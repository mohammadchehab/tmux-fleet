/**
 * The `PullRequests` port over `gh` (§10). Every call is one `gh` argv, and the
 * mapping lives in `observe.ts`, so this file is only the sequence: which
 * arguments, in which order, and what a non-zero exit means.
 *
 * Two behaviours the gate depends on and would be wrong without:
 *
 * - **`get` distinguishes "no such PR" from "the call failed".** A missing PR is
 *   `undefined`, which the gate reports as `missing`; a `gh` that fails for any
 *   other reason throws, so a network blip never reads as "the PR was closed".
 * - **`dependents` is a branch comparison, not a fleet field.** A stacked PR is
 *   one whose base is this PR's head branch. `gh` has no stack concept, and the
 *   `PullRequest.stackParent` the projection keeps comes from the fleet's own
 *   events — so this asks the repo the question it can actually answer.
 *
 * Nothing here deletes a branch on its own: `merge` deletes only when the
 * caller asked, and §10's gate is the caller that decides (§10, the `#102` loss).
 */

import { fleetError, type Repo, type Sha } from '@fleet/foundation-core'
import type { PullRequest, PullRequests, ReviewState } from '@fleet/foundation-contracts'
import { createGh, type Gh, type GhResult } from './gh.ts'
import { createdFrom, gradedChecksFrom, mergeShaFrom, pullRequestFrom, reviewFrom, type GradedChecks } from './observe.ts'

/** The fields every read asks for. One list, so a `get` and a `list` row are the same shape (§10). */
const FIELDS = [
  'number',
  'baseRefName',
  'headRefName',
  'headRefOid',
  'reviewDecision',
  'latestReviews',
  'statusCheckRollup',
  'mergedAt',
  'createdAt',
  'updatedAt',
  'body',
].join(',')

/** How many rows a list may return. A stack sweep wants all open PRs; a search wants a page. */
const DEFAULT_LIMIT = 200

/**
 * The port, plus the one thing §10 needs that the port's signature cannot say:
 * `checks` returns the sha it graded. It is a widening, not a second contract —
 * a `GitHubPullRequests` is a `PullRequests`, so `apps/daemon` passes it to the
 * gate unchanged and a writer that also wants the sha can ask for it.
 */
export interface GitHubPullRequests extends PullRequests {
  checks(repo: Repo, number: number): Promise<GradedChecks>
}

export interface GitHubOptions {
  /** Defaults to `gh` on `PATH` through `execFile`. A test supplies a fake and reads the argv. */
  readonly gh?: Gh
  /** Rows per list/search. Defaults to 200. */
  readonly limit?: number
}

/** `gh`'s way of saying the PR is not there, in the two spellings it uses for a number and a branch. */
const isMissing = (result: GhResult): boolean =>
  /no pull requests? found|could not resolve to a pullrequest/i.test(result.stderr)

export const createGitHubPullRequests = (options: GitHubOptions = {}): GitHubPullRequests => {
  const gh = options.gh ?? createGh()
  const limit = options.limit ?? DEFAULT_LIMIT

  const listArgs = (repo: Repo, state: 'open' | 'closed' | 'all'): readonly string[] => [
    'pr',
    'list',
    '-R',
    String(repo),
    '--state',
    state,
    '--limit',
    String(limit),
    '--json',
    FIELDS,
  ]

  const readAll = async (args: readonly string[], repo: Repo): Promise<readonly PullRequest[]> => {
    const raw = await gh.json(args)
    if (!Array.isArray(raw)) throw fleetError('external_failed', 'gh pr list printed something that is not a list')
    return raw.map((row) => pullRequestFrom(row, repo))
  }

  const readOne = async (repo: Repo, number: number, fields = FIELDS): Promise<unknown> =>
    gh.json(['pr', 'view', String(number), '-R', String(repo), '--json', fields])

  const get = async (repo: Repo, number: number): Promise<PullRequest | undefined> => {
    const result = await gh.run(['pr', 'view', String(number), '-R', String(repo), '--json', FIELDS])
    if (result.code !== 0) {
      // "No such PR" is an answer the gate reports as `missing`; anything else is a failed read and throws.
      if (isMissing(result)) return undefined
      throw fleetError('external_failed', `gh pr view ${String(number)} exited ${result.code}: ${result.stderr.trim() || 'no output'}`, {
        details: { repo: String(repo), number, exitCode: result.code },
      })
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(result.stdout) as unknown
    } catch (thrown) {
      throw fleetError('external_failed', `gh pr view ${String(number)} printed no JSON`, { cause: thrown })
    }
    return pullRequestFrom(parsed, repo)
  }

  return {
    list: (repo, listOptions) => readAll(listArgs(repo, listOptions?.state ?? 'open'), repo),

    get,

    /** `dedupe` (§5.2): the text is handed to `gh`'s own search, which reads titles and bodies. */
    async searchIntent(repo, searchText) {
      const trimmed = searchText.trim().replace(/\s+/g, ' ')
      if (trimmed === '') return []
      return readAll(
        ['pr', 'list', '-R', String(repo), '--state', 'open', '--search', trimmed, '--limit', String(limit), '--json', FIELDS],
        repo,
      )
    },

    async create(input) {
      const result = await gh.run([
        'pr',
        'create',
        '-R',
        String(input.repo),
        '--base',
        input.base,
        '--head',
        input.head,
        '--title',
        input.title,
        // Always passed: without it `gh` would prompt, and there is no TTY here to prompt on.
        '--body',
        input.body ?? '',
      ])
      if (result.code !== 0) {
        throw fleetError('external_failed', `gh pr create exited ${result.code}: ${result.stderr.trim() || 'no output'}`, {
          details: { repo: String(input.repo), head: input.head },
        })
      }
      return createdFrom(result.stdout, input.repo)
    },

    async checks(repo, number) {
      return gradedChecksFrom(await readOne(repo, number, 'headRefOid,statusCheckRollup'))
    },

    async review(repo, number): Promise<{ readonly state: ReviewState; readonly reviewer?: string }> {
      const row = await readOne(repo, number, 'reviewDecision,latestReviews')
      const object = typeof row === 'object' && row !== null ? (row as Record<string, unknown>) : {}
      return reviewFrom(object['reviewDecision'], object['latestReviews'])
    },

    async retarget(repo, number, base) {
      const result = await gh.run(['pr', 'edit', String(number), '-R', String(repo), '--base', base])
      if (result.code !== 0) {
        throw fleetError('external_failed', `gh pr edit ${String(number)} exited ${result.code}: ${result.stderr.trim() || 'no output'}`, {
          details: { repo: String(repo), number, base },
        })
      }
    },

    /** Every open PR based on this one's head branch — the stack that sits on top of it (§10). */
    async dependents(repo, number) {
      const parent = await get(repo, number)
      if (parent === undefined) return []
      const open = await readAll(listArgs(repo, 'open'), repo)
      return open
        .filter((pr) => pr.number !== number && pr.base === parent.head && !pr.merged)
        .map((pr) => ({ repo: pr.repo, number: pr.number }))
    },

    async merge(repo, number, mergeOptions) {
      const flag = mergeOptions.method === 'merge' ? '--merge' : mergeOptions.method === 'rebase' ? '--rebase' : '--squash'
      const result = await gh.run([
        'pr',
        'merge',
        String(number),
        '-R',
        String(repo),
        flag,
        ...(mergeOptions.deleteBranch ? ['--delete-branch'] : []),
      ])
      if (result.code !== 0) {
        throw fleetError('external_failed', `gh pr merge ${String(number)} exited ${result.code}: ${result.stderr.trim() || 'no output'}`, {
          details: { repo: String(repo), number, method: mergeOptions.method },
        })
      }
      // The merge commit is a nicety, not the merge: a second call that fails leaves `mergeSha` absent, and the
      // `pr.merged` event records the head sha it merged either way (§3).
      const sha: Sha | undefined = await readOne(repo, number, 'mergeCommit')
        .then(mergeShaFrom)
        .catch(() => undefined)
      return sha === undefined ? {} : { mergeSha: sha }
    },
  }
}
