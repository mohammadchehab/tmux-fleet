/**
 * The `Coordination` port over `git` (shared-fleet.md §2).
 *
 * The transport owns one bare repository, `cache`, and never a working tree:
 * files become blobs with `hash-object`, a tree with `mktree`, a parentless commit
 * with `commit-tree`, and the commit goes out with `push`. Nothing is checked out,
 * so there is no index to corrupt and no file a payload could be written to.
 *
 * Every write is a `push --force-with-lease=<ref>:<sha>`, which is what makes the
 * port's three writes one mechanism:
 *
 * - `publish` leases on the sha this fleet last pushed, so a second machine on the
 *   same account cannot silently overwrite the first (§2.3, "on reconnect a fleet
 *   fetches before it pushes");
 * - `create` leases on *nothing* — an empty expected value means "must not exist",
 *   and the server checks it again when it applies the update, so of two fleets
 *   that both saw the ref absent exactly one wins (§2.1);
 * - `release` leases on the claim's sha, so a claim re-taken since is not deleted.
 *
 * A rejected push is not trusted to say why — a ruleset, a network failure and a
 * lost lease all exit non-zero — so after one the remote is asked what the ref
 * holds now, and only a ref that really moved is `head_moved`.
 *
 * Every network call carries `tmux-fleet/<version> (fleet-coord)` as its HTTP user
 * agent: a laptop polling GitHub on a timer looks like beaconing to an endpoint
 * agent, and a name that says what it is lets one be told from the other.
 */

import { mkdir } from 'node:fs/promises'
import { fleetError, type Sha } from '@fleet/foundation-core'
import type { Coordination, CoordinationFiles, CoordinationRef } from '@fleet/foundation-contracts'
import { execFileGit, type GitResult, type GitRunner } from './git.ts'

export interface GitCoordinationOptions {
  /** The coordination repository: an HTTPS URL, or a path in a test. */
  readonly remote: string
  /** A directory the transport owns as a bare repository; created on first use. */
  readonly cache: string
  /** Who the commits are by: the fleet owner's GitHub identity. */
  readonly author: { readonly name: string; readonly email: string }
  /** The fleet's version, for the user agent. */
  readonly version: string
  readonly git?: GitRunner
}

/** Where a fetched ref is kept in the cache, so a later read finds it without the network. */
const CACHE_NAMESPACE = 'refs/coord/'

/**
 * A ref name as the port speaks it: slash-separated segments of letters, digits,
 * `.`, `_` and `-`, none starting with `.` or `-`. Narrower than git's own rule on
 * purpose — it keeps every name a single argv word that cannot read as an option.
 */
const REF_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/
const FILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/

const checkRef = (name: string): string => {
  const segments = name.split('/')
  const valid =
    name.length <= 200 &&
    segments.every((segment) => REF_SEGMENT.test(segment) && !segment.endsWith('.lock') && !segment.includes('..'))
  if (!valid) throw fleetError('invalid_input', `not a coordination ref name: ${JSON.stringify(name)}`)
  return `refs/heads/${name}`
}

const checkFiles = (files: CoordinationFiles): readonly [string, string][] => {
  const entries = Object.entries(files)
  for (const [name] of entries) {
    if (!FILE_NAME.test(name)) throw fleetError('invalid_input', `not a coordination file name: ${JSON.stringify(name)}`)
  }
  return entries
}

/** `git ls-remote` output as refs under `refs/heads/`, with the prefix taken off. */
const parseRefs = (stdout: string): CoordinationRef[] =>
  stdout
    .split('\n')
    .map((line) => line.split('\t'))
    .filter((parts): parts is [string, string] => parts.length === 2 && parts[1]!.startsWith('refs/heads/'))
    .map(([sha, ref]) => ({ name: ref.slice('refs/heads/'.length), sha: sha as Sha }))

export const createGitCoordination = (options: GitCoordinationOptions): Coordination => {
  const run = options.git ?? execFileGit
  const { cache, remote } = options
  if (remote.startsWith('-')) throw fleetError('invalid_input', `not a remote: ${JSON.stringify(remote)}`)
  const agent = ['-c', `http.userAgent=tmux-fleet/${options.version} (fleet-coord)`]

  /** The argv's first word after the options, which is what an error message can quote. */
  const failed = (args: readonly string[], result: GitResult): never => {
    const verb = args.find((arg, i) => !arg.startsWith('-') && args[i - 1] !== '-c') ?? 'git'
    throw fleetError('external_failed', `git ${verb} exited ${result.code}: ${result.stderr.trim() || 'no output'}`, {
      details: { verb, exitCode: result.code },
    })
  }

  const git = async (args: readonly string[], input?: string): Promise<string> => {
    await ready()
    const result = await run(args, { cwd: cache, ...(input === undefined ? {} : { input }) })
    if (result.code !== 0) failed(args, result)
    return result.stdout
  }

  let initialised: Promise<void> | undefined
  const ready = (): Promise<void> =>
    (initialised ??= (async () => {
      await mkdir(cache, { recursive: true })
      const result = await run(['init', '--bare', '--quiet', '.'], { cwd: cache })
      if (result.code !== 0) {
        initialised = undefined
        failed(['init'], result)
      }
    })())

  const listRefs = async (): Promise<CoordinationRef[]> => parseRefs(await git([...agent, 'ls-remote', '--heads', remote]))

  const current = async (name: string): Promise<Sha | undefined> =>
    (await listRefs()).find((ref) => ref.name === name)?.sha

  const commit = async (files: CoordinationFiles, message: string): Promise<Sha> => {
    const entries = checkFiles(files)
    const lines: string[] = []
    for (const [name, text] of entries) {
      const blob = (await git(['hash-object', '-w', '--stdin'], text)).trim()
      lines.push(`100644 blob ${blob}\t${name}\n`)
    }
    const tree = (await git(['mktree'], lines.join(''))).trim()
    const { name, email } = options.author
    const sha = await git(['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit-tree', tree, '-m', message])
    return sha.trim() as Sha
  }

  /** One leased push; `true` when it landed. Any refusal is reported as `false` for the caller to explain. */
  const push = async (ref: string, source: Sha | '', expected: Sha | ''): Promise<boolean> => {
    await ready()
    const args = [...agent, 'push', '--porcelain', '--no-verify', `--force-with-lease=${ref}:${expected}`, remote]
    const result = await run([...args, `${source}:${ref}`], { cwd: cache })
    return result.code === 0
  }

  const isLocal = async (sha: Sha): Promise<boolean> => {
    await ready()
    return (await run(['cat-file', '-e', `${sha}^{commit}`], { cwd: cache })).code === 0
  }

  const filesAt = async (sha: Sha): Promise<CoordinationFiles> => {
    const files: Record<string, string> = {}
    for (const entry of (await git(['ls-tree', '-z', sha])).split('\0')) {
      const match = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(entry)
      if (match === null) continue
      files[match[2]!] = await git(['cat-file', 'blob', match[1]!])
    }
    return files
  }

  return {
    async refs(prefix) {
      const refs = await listRefs()
      return prefix === undefined ? refs : refs.filter((ref) => ref.name.startsWith(prefix))
    },

    async read(ref) {
      const full = checkRef(ref.name)
      if (await isLocal(ref.sha)) return { sha: ref.sha, files: await filesAt(ref.sha) }
      const local = `${CACHE_NAMESPACE}${ref.name}`
      await ready()
      const args = [...agent, 'fetch', '--quiet', '--no-tags', '--depth=1', remote, `+${full}:${local}`]
      const fetched = await run(args, { cwd: cache })
      if (fetched.code !== 0) {
        if ((await current(ref.name)) === undefined) return undefined
        failed(args, fetched)
      }
      const sha = (await git(['rev-parse', '--verify', `${local}^{commit}`])).trim() as Sha
      return { sha, files: await filesAt(sha) }
    },

    async publish({ ref, files, expected, message }) {
      const full = checkRef(ref)
      const sha = await commit(files, message)
      if (await push(full, sha, expected ?? '')) return sha
      const now = await current(ref)
      if (now !== expected) {
        throw fleetError('head_moved', `${ref} is at ${now ?? 'nothing'}, not ${expected ?? 'nothing'}; nothing was pushed`, {
          details: { ref, expected: expected ?? null, actual: now ?? null },
        })
      }
      throw fleetError('external_failed', `push to ${ref} was refused, and the ref did not move`, { details: { ref } })
    },

    async create({ ref, files, message }) {
      const full = checkRef(ref)
      const sha = await commit(files, message)
      if (await push(full, sha, '')) return { created: true, sha }
      const winner = await current(ref)
      if (winner === undefined) {
        throw fleetError('external_failed', `creating ${ref} was refused, and nobody else holds it`, { details: { ref } })
      }
      return { created: false, sha: winner }
    },

    async release(ref, expected) {
      const full = checkRef(ref)
      if (await push(full, '', expected)) return
      const now = await current(ref)
      if (now === undefined) throw fleetError('not_found', `${ref} is already gone`, { details: { ref } })
      if (now !== expected) {
        throw fleetError('head_moved', `${ref} is at ${now}, not ${expected}; it was not released`, {
          details: { ref, expected, actual: now },
        })
      }
      throw fleetError('external_failed', `deleting ${ref} was refused, and the ref did not move`, { details: { ref } })
    },
  }
}
