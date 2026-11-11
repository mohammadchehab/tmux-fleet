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
import type { ForgePullRequest, PullRequests, ReviewState } from '@fleet/foundation-contracts'
import { createGh, type Gh, type GhResult } from './gh.ts'
import {
  branchListFrom,
  createdFrom,
  gradedChecksFrom,
  mergeShaFrom,
  pullRequestFrom,
  refShaFrom,
  reviewFrom,
  type GradedChecks,
} from './observe.ts'

/**
 * The fields every read asks for. One list, so a `get` and a `list` row are the same
 * shape (§10). `state` is here for §9's sake and not the gate's: it is the only place
 * "this PR is still open" can come from, because §3 has no `pr.closed`.
 */
const FIELDS = [
  'number',
  'state',
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

/**
 * `gh`'s way of saying the head is not the sha we pinned. GitHub refuses the
 * merge when `--match-head-commit` no longer matches, and that refusal is a fact
 * about the PR rather than a failed call: the caller pinned a sha and the head
 * moved out from under it (§10, `head_moved`). "Base branch was modified" is a
 * different refusal and deliberately not matched here.
 */
const isHeadMoved = (result: GhResult): boolean => /head branch was (?:modified|updated)/i.test(result.stderr)

/**
 * `gh -R` reads three path segments as `HOST/OWNER/REPO`, not as an owner with a
 * slash in it. So a nested `Repo` must never reach it: that would let a string —
 * including one a stranger wrote in a PR body's `Fleet-Stack-Parent` footer —
 * decide which host `gh` talks to and which host's token it presents. GitHub has
 * no subgroups, so a nested repo is not a repo there, and this adapter says so
 * before spawning anything rather than letting `gh` interpret it as a URL.
 *
 * The widened `Repo` in `@fleet/foundation-core` is for a forge that nests; it is
 * not a claim that every forge does.
 */
const githubRepo = (repo: Repo): string => {
  const value = String(repo)
  const segments = value.split('/').length
  if (segments !== 2) {
    throw fleetError(
      'invalid_input',
      `${value} is not a GitHub repository: \`gh -R\` reads ${String(segments)} segments as HOST/OWNER/REPO, so a nested path would pick the host`,
      { details: { repo: value, segments } },
    )
  }
  return value
}

/**
 * A branch name as one path in the refs API. Slashes are kept — `heads/feature/x`
 * is how GitHub names a ref that lives under a folder — but every other character
 * is percent-encoded: a branch name is data from the remote, and the delete this
 * builds is destructive, so `#`, `?` or `%` in it must not be read as URL syntax.
 */
const refPath = (branch: string): string =>
  branch
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')

export const createGitHubPullRequests = (options: GitHubOptions = {}): GitHubPullRequests => {
  const gh = options.gh ?? createGh()
  const limit = options.limit ?? DEFAULT_LIMIT

  const listArgs = (repo: Repo, state: 'open' | 'closed' | 'all'): readonly string[] => [
    'pr',
    'list',
    '-R',
    githubRepo(repo),
    '--state',
    state,
    '--limit',
    String(limit),
    '--json',
    FIELDS,
  ]

  const readAll = async (args: readonly string[], repo: Repo): Promise<readonly ForgePullRequest[]> => {
    const raw = await gh.json(args)
    if (!Array.isArray(raw)) throw fleetError('external_failed', 'gh pr list printed something that is not a list')
    return raw.map((row) => pullRequestFrom(row, repo))
  }

  const readOne = async (repo: Repo, number: number, fields = FIELDS): Promise<unknown> =>
    gh.json(['pr', 'view', String(number), '-R', githubRepo(repo), '--json', fields])

  const get = async (repo: Repo, number: number): Promise<ForgePullRequest | undefined> => {
    const result = await gh.run(['pr', 'view', String(number), '-R', githubRepo(repo), '--json', FIELDS])
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
    // `async` so the `-R` guard's refusal is a rejection, not a throw out of the argument list: a caller that
    // holds a promise (`.catch`, `Promise.all`) must see it, and every other method here already behaves that way.
    list: async (repo, listOptions) => readAll(listArgs(repo, listOptions?.state ?? 'open'), repo),

    get,

    /** `dedupe` (§5.2): the text is handed to `gh`'s own search, which reads titles and bodies. */
    async searchIntent(repo, searchText) {
      const trimmed = searchText.trim().replace(/\s+/g, ' ')
      if (trimmed === '') return []
      return readAll(
        ['pr', 'list', '-R', githubRepo(repo), '--state', 'open', '--search', trimmed, '--limit', String(limit), '--json', FIELDS],
        repo,
      )
    },

    async create(input) {
      const result = await gh.run([
        'pr',
        'create',
        '-R',
        githubRepo(input.repo),
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
      const result = await gh.run(['pr', 'edit', String(number), '-R', githubRepo(repo), '--base', base])
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
        githubRepo(repo),
        flag,
        // §10's pin, enforced by GitHub rather than by us: if the head moved between the caller's read and this
        // call, `gh` refuses the merge instead of merging a commit nobody checked.
        '--match-head-commit',
        String(mergeOptions.headSha),
        ...(mergeOptions.deleteBranch ? ['--delete-branch'] : []),
      ])
      if (result.code !== 0) {
        const details = { repo: String(repo), number, method: mergeOptions.method }
        // The head moving is an answer, not a transport failure: the caller pinned a sha and it is gone, so it is
        // reported with its own code and nothing was merged (§10).
        if (isHeadMoved(result)) {
          throw fleetError(
            'head_moved',
            `${String(repo)}#${String(number)} moved off ${String(mergeOptions.headSha)} before the merge; nothing was merged`,
            { details: { ...details, headSha: mergeOptions.headSha } },
          )
        }
        throw fleetError('external_failed', `gh pr merge ${String(number)} exited ${result.code}: ${result.stderr.trim() || 'no output'}`, {
          details,
        })
      }
      // The merge commit is a nicety, not the merge: a second call that fails leaves `mergeSha` absent, and the
      // `pr.merged` event records the head sha it merged either way (§3).
      const sha: Sha | undefined = await readOne(repo, number, 'mergeCommit')
        .then(mergeShaFrom)
        .catch(() => undefined)
      return sha === undefined ? {} : { mergeSha: sha }
    },

    /**
     * Every remote branch, head sha included. `--paginate` on its own concatenates
     * the pages into output no JSON parser can read, so `--slurp` collects them into
     * one array of pages: one call, one JSON value, whatever the repo's size. `gh`
     * refuses `--slurp` together with `--jq`, so `branchListFrom` flattens the pages.
     */
    async branches(repo) {
      const raw = await gh.json(['api', `repos/${githubRepo(repo)}/branches?per_page=100`, '--paginate', '--slurp'])
      return branchListFrom(raw)
    },

    /**
     * The repo's trunk, as GitHub names it. One field off the repo itself, because
     * the branch list does not mark the default and `main` is a convention rather
     * than a fact.
     */
    async defaultBranch(repo) {
      const raw = await gh.run(['api', `repos/${githubRepo(repo)}`, '--jq', '.default_branch'])
      const name = raw.stdout.trim()
      if (name === '' || name === 'null') {
        throw fleetError('external_failed', `${String(repo)} reports no default branch`, {
          details: { repo: String(repo) },
        })
      }
      return name
    },

    /**
     * Delete, pinned to `expectedSha`. The read-check-delete sequence is the only
     * pair GitHub offers — the refs API takes no `If-Match` — so the window between
     * the two calls is narrowed, not closed; what closes it is the caller's reason
     * (a merge whose head sha this event log recorded) plus the next sweep seeing a
     * moved branch. Nothing is deleted when the read disagrees.
     */
    async deleteBranch(repo, branch, expectedSha) {
      const path = `repos/${githubRepo(repo)}/git/ref/heads/${refPath(branch)}`
      const head = await gh.run(['api', path])
      if (head.code !== 0) {
        // A branch that is not there is its own answer: the caller asked to delete a
        // thing it believes exists, and an `undefined` would read as success.
        if (/not found/i.test(head.stderr)) {
          throw fleetError('not_found', `${String(repo)} has no branch ${branch}`, {
            details: { repo: String(repo), branch },
          })
        }
        throw fleetError('external_failed', `gh api ${path} exited ${head.code}: ${head.stderr.trim() || 'no output'}`, {
          details: { repo: String(repo), branch, exitCode: head.code },
        })
      }
      const current = refShaFrom(head.stdout)
      if (current !== String(expectedSha)) {
        throw fleetError(
          'head_moved',
          `${String(repo)}'s ${branch} points at ${current ?? 'no sha'}, not ${String(expectedSha)}; nothing was deleted`,
          { details: { repo: String(repo), branch, expectedSha: String(expectedSha) } },
        )
      }
      const deleted = await gh.run(['api', '-X', 'DELETE', `repos/${githubRepo(repo)}/git/refs/heads/${refPath(branch)}`])
      if (deleted.code !== 0) {
        throw fleetError(
          'external_failed',
          `gh api -X DELETE ${path} exited ${deleted.code}: ${deleted.stderr.trim() || 'no output'}`,
          { details: { repo: String(repo), branch, exitCode: deleted.code } },
        )
      }
    },
  }
}
