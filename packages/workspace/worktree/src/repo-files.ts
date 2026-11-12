/**
 * `RepoFiles` over git (§12.1): a file as the default branch has it, never as the
 * working tree does.
 *
 * `git show <sha>:<path>` rather than reading the file: the checkout a peer works
 * in can be edited by that peer, and what review approved is the commit. The sha
 * is resolved first and the file read at *that* sha, so the text and the `ref` the
 * caller records cannot come from two different commits if the branch moves
 * between the two calls.
 *
 * Which commit is the *remote's*, not the local ref's: see the comment in `read`.
 * The caller records the sha, so what was read is visible.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RepoFiles } from '@fleet/foundation-contracts'
import { execFileGit, type GitRunner } from './git.ts'
import { remoteDefault } from './refs.ts'

const SHA = /^[0-9a-f]{40}$/

/**
 * The repo's git config is shared with every worktree, so a peer can write it.
 * Network commands therefore never run *in* that repository: they run in a scratch
 * bare repository of our own, against an explicit URL, so none of the repository's
 * local config (`remote.origin.*`, `url.*.insteadOf`, `http.proxy`,
 * `credential.helper`, ...) is read at all. System and global config still apply, on
 * purpose: they are the user's, not a peer's, and a `credential.helper` there is how
 * a private repository authenticates. On top of that, keys that can run programs or
 * widen transports are pinned:
 * - `core.sshCommand`, `core.askPass`, `core.gitProxy`, `core.fsmonitor`: can run programs
 * - `remote.origin.uploadpack`: can run programs
 * - `protocol.*`: control which transports are allowed
 *
 * What stays peer-writable is the URL itself, read from `remote.origin.url`; pass
 * `remoteUrl` to pin it from a source a peer cannot write. A peer runs as fleetd's
 * own OS user, so this reader is a guard against drift and accident, not a sandbox;
 * what keeps one from rewriting its rules is its tool policy.
 */
const TRANSPORT = [
  '-c', 'core.sshCommand=ssh',
  '-c', 'core.askPass=',
  '-c', 'core.gitProxy=',
  '-c', 'core.fsmonitor=false',
  '-c', 'remote.origin.uploadpack=git-upload-pack',
  '-c', 'protocol.ext.allow=never',
  '-c', 'protocol.https.allow=always',
  '-c', 'protocol.ssh.allow=always',
] as const

export interface RepoFilesOptions {
  /** The origin to ask, from a source a peer cannot write. Default: the repository's `remote.origin.url`. */
  readonly remoteUrl?: string
  /**
   * When the remote cannot be reached, read the local `origin/<branch>` ref anyway.
   * Off by default: that ref lives in the shared git directory and a peer can point it
   * at a commit of its own, so trusting it is a decision the caller makes, not a
   * silent fallback. The recorded `ref` still says which commit was read.
   */
  readonly allowStaleLocal?: boolean
}

interface Read {
  readonly text: string
  readonly ref: string
}

export const createRepoFiles = (runner: GitRunner = execFileGit, options: RepoFilesOptions = {}): RepoFiles => ({
  async read(cwd, path) {
    // A path is a path *in the repository*: `..` or an absolute one would ask git
    // for something that is not the file the caller named.
    if (path.startsWith('/') || path.split('/').includes('..')) {
      throw new Error(`'${path}' is not a path inside a repository`)
    }
    const base = await remoteDefault(runner, cwd)
    if (base === undefined) return undefined

    const resolved = await runner(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], cwd)
    const local = resolved.stdout.trim()
    if (resolved.code !== 0 || !SHA.test(local)) return undefined

    // `refs/remotes/origin/*` live in the repository's shared git directory, which a
    // peer working in any of its worktrees can write: `git update-ref` would let it
    // point `origin/main` at a commit of its own and so rewrite its rules. So the
    // remote is asked what the branch is, and that commit is what is read, fetched
    // into a scratch repository so the shared config never touches the transport.
    // Unreachable: nothing is read unless `allowStaleLocal` says the local ref may
    // stand. This is a guard against drift and accident, not a sandbox.
    const branch = base.replace(/^origin\//, '')
    const url = options.remoteUrl ?? (await runner(['config', '--local', '--get', 'remote.origin.url'], cwd)).stdout.trim()
    if (url !== '') {
      const remote = await fromRemote(runner, url, branch, path)
      if (remote !== undefined) return remote.read
    }
    if (options.allowStaleLocal !== true) return undefined

    const shown = await runner(['show', `${local}:${path}`], cwd)
    // 128 is "no such path in that commit" (and "not a repository"): both are "nothing to read".
    return shown.code === 0 ? { text: shown.stdout, ref: local } : undefined
  },
})

/** `undefined`: the remote could not be reached. Otherwise what it holds (`read` is undefined when the path is not there). */
const fromRemote = async (
  runner: GitRunner,
  url: string,
  branch: string,
  path: string,
): Promise<{ readonly read: Read | undefined } | undefined> => {
  const scratch = await mkdtemp(join(tmpdir(), 'fleet-repofiles-'))
  try {
    if ((await runner(['init', '--quiet', '--bare'], scratch)).code !== 0) return undefined
    // Objects only, into a ref of the scratch repository: nothing here is a peer's to move.
    const fetched = await runner([...TRANSPORT, 'fetch', '--quiet', '--no-write-fetch-head', url, `+refs/heads/${branch}:refs/fetched`], scratch)
    if (fetched.code !== 0) return undefined
    const tip = (await runner(['rev-parse', '--verify', '--quiet', 'refs/fetched^{commit}'], scratch)).stdout.trim()
    if (!SHA.test(tip)) return undefined
    const shown = await runner(['show', `${tip}:${path}`], scratch)
    return { read: shown.code === 0 ? { text: shown.stdout, ref: tip } : undefined }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
