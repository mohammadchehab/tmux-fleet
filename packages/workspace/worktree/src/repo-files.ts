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
 * Which commit is the *remote's*, not the local ref's: see the comment at the
 * `ls-remote` below. The caller records the sha, so what was read is visible.
 */

import type { RepoFiles } from '@fleet/foundation-contracts'
import { execFileGit, type GitRunner } from './git.ts'
import { remoteDefault } from './refs.ts'

const SHA = /^[0-9a-f]{40}$/

/**
 * The repo's git config is shared with every worktree, so a peer can write it. A peer
 * can write `core.sshCommand` to run a program of its choosing; `core.gitProxy` and
 * `core.askPass` could run programs or credential helpers. They are reset on the two
 * commands that touch the remote. `credential.helper` is left as it is on purpose:
 * it is how a private repository authenticates, and stripping it would make this fail
 * for exactly the repos that need it.
 */
const TRANSPORT = [
  '-c', 'core.sshCommand=ssh',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.askPass=',
  '-c', 'core.gitProxy=',
  '-c', 'protocol.ext.allow=never',
] as const

export const createRepoFiles = (runner: GitRunner = execFileGit): RepoFiles => ({
  async read(cwd, path) {
    // A path is a path *in the repository*: `..` or an absolute one would ask git
    // for something that is not the file the caller named.
    if (path.startsWith('/') || path.split('/').includes('..')) {
      throw new Error(`'${path}' is not a path inside a repository`)
    }
    const base = await remoteDefault(runner, cwd)
    if (base === undefined) return undefined

    const resolved = await runner(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], cwd)
    let ref = resolved.stdout.trim()
    if (resolved.code !== 0 || !SHA.test(ref)) return undefined

    // `refs/remotes/origin/*` live in the repository's shared git directory, which a
    // peer working in any of its worktrees can write: `git update-ref` would let it
    // point `origin/main` at a commit of its own and so rewrite its rules. So the
    // remote is asked what the branch is, and that commit is what is read. Offline,
    // the local ref stands (stale beats none) — the one case a peer's edit of it
    // could matter, and the recorded sha says which commit was read. This is a guard
    // against drift and accident, not a sandbox: a peer runs as fleetd's own user, so
    // what actually keeps one from rewriting its rules is its tool policy.
    const branch = base.replace(/^origin\//, '')
    const asked = await runner([...TRANSPORT, 'ls-remote', '--exit-code', 'origin', `refs/heads/${branch}`], cwd)
    const remote = asked.code === 0 ? (asked.stdout.split(/\s/)[0] ?? '') : ''
    if (SHA.test(remote) && remote !== ref) {
      const have = async (): Promise<boolean> => (await runner(['cat-file', '-e', `${remote}^{commit}`], cwd)).code === 0
      // Objects only: nothing a fetch of a branch does touches a ref a peer's rules hang on.
      if (!(await have())) await runner([...TRANSPORT, 'fetch', '--quiet', '--no-write-fetch-head', 'origin', `refs/heads/${branch}`], cwd)
      // Not there even now: nothing trustworthy to read, so nothing is read.
      if (!(await have())) return undefined
      ref = remote
    }

    const shown = await runner(['show', `${ref}:${path}`], cwd)
    // 128 is "no such path in that commit" (and "not a repository"): both are "nothing to read".
    return shown.code === 0 ? { text: shown.stdout, ref } : undefined
  },
})
