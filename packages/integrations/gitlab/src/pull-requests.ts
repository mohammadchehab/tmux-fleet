/**
 * The `PullRequests` port over `glab` (§10). Every read is one `glab api` call
 * against the REST endpoint that returns the JSON we need, and the mapping lives
 * in `observe.ts`, so this file is only the sequence: which endpoint, in which
 * order, and what a non-zero exit means.
 *
 * **Why `glab api` for reads and `glab mr` for writes.** `glab mr list` prints a
 * view-shaped JSON whose fields are the CLI's business and have changed between
 * releases; `/projects/:id/merge_requests` is GitLab's own documented response
 * and a merge request's pipelines and approvals only exist as endpoints. So reads
 * name the resource they want, and the three actions (create, update, merge) use
 * the subcommands, because that is where `--sha`, `--auto-merge` and the
 * confirmation prompt live.
 *
 * Two behaviours the gate depends on and would be wrong without:
 *
 * - **`get` distinguishes "no such merge request" from "the call failed".** A
 *   missing one is `undefined`, which the gate reports as `missing`; a `glab`
 *   that fails for any other reason throws, so a network blip never reads as "the
 *   merge request was closed".
 * - **A refused merge is re-read, not guessed.** With `--sha`, GitLab refuses to
 *   merge a head that moved, but the CLI's wording for that refusal is not a
 *   contract. So on a non-zero exit this file reads the merge request's current
 *   sha and compares it to the one the caller pinned: a different sha *is* a
 *   moved head (`head_moved`), whatever `glab` printed; the message is only a
 *   fallback for the case where the re-read itself fails.
 *
 * Nothing here deletes a branch on its own: `merge` removes the source branch only
 * when the caller asked, and §10's gate is the caller that decides (§10, the
 * `#102` loss).
 */

import { fleetError, type Repo, type Sha } from '@fleet/foundation-core'
import type { ForgePullRequest, PullRequests, ReviewState } from '@fleet/foundation-contracts'
import { createGlab, type Glab, type GlabResult } from './glab.ts'
import {
  branchListFrom,
  branchShaFrom,
  createdFrom,
  gradedChecksFrom,
  headShaFrom,
  iidOf,
  mergeShaFrom,
  pullRequestFrom,
  reviewFrom,
  sourceBranchFrom,
  type GradedChecks,
  type MergeRequestEvidence,
  type ReviewObservation,
} from './observe.ts'

/**
 * How many rows a list may return. GitLab caps `per_page` at 100 and does not
 * say so, so this is also the clamp: asking for more would silently return a
 * page and look like "there are no more merge requests".
 */
const DEFAULT_LIMIT = 100
const MAX_PER_PAGE = 100

/** How many merge requests a `list` asks approvals for at once. Each one is a `glab` process. */
const APPROVALS_AT_ONCE = 8

/** The port's own merge options, so a widening that adds `auto` cannot drift from the contract. */
type PortMergeOptions = Parameters<PullRequests['merge']>[2]

/** §10's pin plus the one flag GitLab offers beyond it: merge when the pipeline succeeds. */
export interface GitLabMergeOptions extends PortMergeOptions {
  /** `--auto-merge`: GitLab merges the moment the pipeline succeeds, instead of refusing now. */
  readonly auto?: boolean
}

/**
 * The port, plus the two things §10 needs that the port's signature cannot say:
 * `checks` returns the sha it graded, and `merge` can ask GitLab to wait for the
 * pipeline instead of merging now. Both are widenings, not a second contract — a
 * `GitLabPullRequests` is a `PullRequests`, so `apps/daemon` passes it to the
 * gate unchanged.
 */
export interface GitLabPullRequests extends PullRequests {
  checks(repo: Repo, number: number): Promise<GradedChecks>
  merge(repo: Repo, number: number, options: GitLabMergeOptions): Promise<{ readonly mergeSha?: Sha }>
}

export interface GitLabOptions {
  /** Defaults to `glab` on `PATH` through `execFile`. A test supplies a fake and reads the argv. */
  readonly glab?: Glab
  /**
   * The profile's `forge.host`. Only used to build the default runner's
   * environment; an injected `glab` has already made that choice.
   */
  readonly host?: string
  /** Rows per list. Defaults to 100, which is GitLab's own ceiling. */
  readonly limit?: number
}

/**
 * GitLab's REST path for a repo. The whole namespace is one path segment, so its slashes
 * are encoded — and it may nest, because a GitLab subgroup is a repo here.
 *
 * No segment count here, and the asymmetry with GitHub's `githubRepo` is deliberate:
 * `gh -R` reads three segments as HOST/OWNER/REPO, so a nested path reaching it lets a
 * footer a stranger wrote pick the host. This adapter has no such flag — the repo is one
 * encoded segment of `projects/:id`, and the instance is pinned before the call by
 * `GITLAB_HOST` from the profile's `forge.host`. A `Fleet-Stack-Parent` footer can
 * therefore only name another project on the same host, which is the cross-repo stack
 * feature; counting segments here would refuse subgroups without closing a hole.
 */
const projectPath = (repo: Repo): string => `projects/${encodeURIComponent(String(repo))}`

/** `open` is GitLab's `opened`; the other two are spelled the same on both forges. */
const stateName = (state: 'open' | 'closed' | 'all'): string => (state === 'open' ? 'opened' : state)

/** A `glab api` that answers 404 is the merge request (or project) not being there — an answer, not a failure. */
const isMissing = (result: GlabResult): boolean => /\b404\b|not found/i.test(result.stderr)

/**
 * The CLI's wording when it refuses a merge because the head moved. Kept as a
 * fallback only: the authoritative test is the re-read below, because this
 * sentence is `glab`'s prose and not an interface.
 */
const looksLikeHeadMoved = (result: GlabResult): boolean => /sha|head (?:of the )?source branch|modified|updated/i.test(result.stderr)

export const createGitLabPullRequests = (options: GitLabOptions = {}): GitLabPullRequests => {
  const glab = options.glab ?? createGlab(options.host === undefined ? {} : { host: options.host })
  const limit = Math.min(options.limit ?? DEFAULT_LIMIT, MAX_PER_PAGE)

  const api = (path: string): Promise<unknown> => glab.json(['api', path])

  const listPath = (repo: Repo, state: 'open' | 'closed' | 'all', extra: readonly string[] = []): string =>
    [`${projectPath(repo)}/merge_requests?state=${stateName(state)}&per_page=${String(limit)}`, ...extra].join('&')

  /** One page of raw rows. A page says nothing about the merge requests beyond what GitLab lists. */
  const readRows = async (path: string): Promise<readonly unknown[]> => {
    const raw = await api(path)
    if (!Array.isArray(raw)) throw fleetError('external_failed', 'glab api printed something that is not a list')
    return raw
  }

  const readAll = async (path: string, repo: Repo): Promise<readonly ForgePullRequest[]> =>
    (await readRows(path)).map((row) => pullRequestFrom(row, repo))

  /** The approvals GitLab holds for a merge request's `iid` — the only place it reports `approved`. */
  const approvalsOf = (repo: Repo, number: number): Promise<unknown> =>
    api(`${projectPath(repo)}/merge_requests/${String(number)}/approvals`)

  /**
   * `list`'s approvals, one per row, a few at a time. A page is up to `limit` merge
   * requests and each costs a `glab` process, so the reads are chunked rather than
   * fanned out at once; and a row whose read fails is `pending` (the conservative
   * answer) instead of failing the page, the same trade `get` makes for pipelines.
   */
  const reviewsOf = async (repo: Repo, rows: readonly unknown[]): Promise<MergeRequestEvidence[]> => {
    const found: MergeRequestEvidence[] = []
    for (let start = 0; start < rows.length; start += APPROVALS_AT_ONCE) {
      const chunk = rows.slice(start, start + APPROVALS_AT_ONCE)
      found.push(
        ...(await Promise.all(
          chunk.map(async (row) => {
            // No `iid`, no approvals to ask for: `pullRequestFrom` reports that row as unusable on its own.
            const number = iidOf(row)
            return number === undefined ? {} : { approvals: await approvalsOf(repo, number).catch(() => undefined) }
          }),
        )),
      )
    }
    return found
  }

  /** The raw merge request, or `undefined` when GitLab says it is not there. */
  const readRaw = async (repo: Repo, number: number): Promise<unknown | undefined> => {
    const result = await glab.run(['api', `${projectPath(repo)}/merge_requests/${String(number)}`])
    if (result.code !== 0) {
      // A missing merge request is an answer the gate reports as `missing`; anything else is a failed read and throws.
      if (isMissing(result)) return undefined
      throw fleetError(
        'external_failed',
        `glab api merge_requests/${String(number)} exited ${String(result.code)}: ${result.stderr.trim() || 'no output'}`,
        { details: { repo: String(repo), number, exitCode: result.code } },
      )
    }
    try {
      return JSON.parse(result.stdout) as unknown
    } catch (thrown) {
      throw fleetError('external_failed', `glab api merge_requests/${String(number)} printed no JSON`, { cause: thrown })
    }
  }

  /** The pipelines GitLab ran for this merge request — the evidence §10 grades. */
  const pipelinesOf = (repo: Repo, number: number): Promise<unknown> =>
    api(`${projectPath(repo)}/merge_requests/${String(number)}/pipelines`)

  const get = async (repo: Repo, number: number): Promise<ForgePullRequest | undefined> => {
    const raw = await readRaw(repo, number)
    if (raw === undefined) return undefined
    // `get` is the read the gate decides on, so it pays for the real pipeline list and the real approvals
    // rather than trusting a summary — neither is a field of the merge request. A failed sub-read is
    // `pending` for its own field and leaves the other alone: the gate refuses a pending, it never merges one.
    const [pipelines, approvals] = await Promise.all([
      pipelinesOf(repo, number).catch(() => undefined),
      approvalsOf(repo, number).catch(() => undefined),
    ])
    return pullRequestFrom(raw, repo, { pipelines, approvals })
  }

  /** `merge`'s post-refusal question: what sha is the merge request at now? */
  const currentHead = async (repo: Repo, number: number): Promise<Sha | undefined> => {
    const raw = await readRaw(repo, number)
    return raw === undefined ? undefined : headShaFrom(raw)
  }

  return {
    /**
     * The page, with each row's review read from its own approvals endpoint. `pr-babysit` records
     * these rows as observations (§6), so a row that was not asked is a PR the log holds as `pending`
     * for as long as the list is its only read — which is exactly what `work-sync`'s `green` refuses.
     */
    list: async (repo, listOptions) => {
      const rows = await readRows(listPath(repo, listOptions?.state ?? 'open'))
      const evidence = await reviewsOf(repo, rows)
      return rows.map((row, at) => pullRequestFrom(row, repo, evidence[at] ?? {}))
    },

    get,

    /** `dedupe` (§5.2): GitLab's own `search`, which reads titles and descriptions. */
    async searchIntent(repo, searchText) {
      const trimmed = searchText.trim().replace(/\s+/g, ' ')
      if (trimmed === '') return []
      return readAll(listPath(repo, 'open', [`search=${encodeURIComponent(trimmed)}`]), repo)
    },

    async create(input) {
      const result = await glab.run([
        'mr',
        'create',
        '-R',
        String(input.repo),
        '--source-branch',
        input.head,
        '--target-branch',
        input.base,
        '--title',
        input.title,
        // Always passed: without it `glab` would prompt for a description, and there is no TTY here to prompt on.
        '--description',
        input.body ?? '',
        // The confirmation prompt has no TTY either.
        '--yes',
      ])
      if (result.code !== 0) {
        throw fleetError('external_failed', `glab mr create exited ${result.code}: ${result.stderr.trim() || 'no output'}`, {
          details: { repo: String(input.repo), head: input.head },
        })
      }
      return createdFrom(result.stdout, input.repo)
    },

    async checks(repo, number) {
      const raw = await readRaw(repo, number)
      if (raw === undefined) {
        throw fleetError('not_found', `${String(repo)}!${String(number)} is not a merge request glab can read`, {
          details: { repo: String(repo), number },
        })
      }
      return gradedChecksFrom(raw, await pipelinesOf(repo, number))
    },

    async review(repo, number): Promise<ReviewObservation> {
      const approvals = await api(`${projectPath(repo)}/merge_requests/${String(number)}/approvals`)
      return reviewFrom(approvals)
    },

    async retarget(repo, number, base) {
      const result = await glab.run(['mr', 'update', String(number), '-R', String(repo), '--target-branch', base, '--yes'])
      if (result.code !== 0) {
        throw fleetError('external_failed', `glab mr update ${String(number)} exited ${result.code}: ${result.stderr.trim() || 'no output'}`, {
          details: { repo: String(repo), number, base },
        })
      }
    },

    /** Every open merge request targeting this one's source branch — the stack that sits on top of it (§10). */
    async dependents(repo, number) {
      // Only the parent's source branch is wanted here, so this stops at the merge request itself:
      // `get` would pay for pipelines and approvals that no stack decision looks at.
      const raw = await readRaw(repo, number)
      if (raw === undefined) return []
      const head = sourceBranchFrom(raw)
      const open = await readAll(
        `${projectPath(repo)}/merge_requests?state=opened&per_page=${String(limit)}&target_branch=${encodeURIComponent(head)}`,
        repo,
      )
      return open
        .filter((pr) => pr.number !== number && pr.base === head && !pr.merged)
        .map((pr) => ({ repo: pr.repo, number: pr.number }))
    },

    async merge(repo, number, mergeOptions) {
      // GitLab's default action is a merge commit; `--squash` and `--rebase` are the opt-ins.
      const flag = mergeOptions.method === 'squash' ? '--squash' : mergeOptions.method === 'rebase' ? '--rebase' : undefined
      const result = await glab.run([
        'mr',
        'merge',
        String(number),
        '-R',
        String(repo),
        // §10's pin, enforced by GitLab rather than by us: a head that moved between the caller's read and this call
        // makes the merge fail instead of landing a commit nobody checked.
        '--sha',
        String(mergeOptions.headSha),
        ...(flag === undefined ? [] : [flag]),
        ...(mergeOptions.deleteBranch ? ['--remove-source-branch'] : []),
        // "Merge when the pipeline succeeds", for a caller that asked to wait rather than to merge now.
        ...(mergeOptions.auto === true ? ['--auto-merge'] : []),
        // The merge confirmation, which has no TTY on this side.
        '--yes',
      ])

      if (result.code !== 0) {
        const details = { repo: String(repo), number, method: mergeOptions.method }
        // The head moving is an answer, not a transport failure. Re-read first: the current sha is a fact, `glab`'s
        // message is prose. A read that fails falls back to the message, so a refusal is never mistaken for a blip.
        const moved = await currentHead(repo, number)
          .then((sha) => sha !== undefined && sha !== mergeOptions.headSha)
          .catch(() => looksLikeHeadMoved(result))
        if (moved) {
          throw fleetError(
            'head_moved',
            `${String(repo)}!${String(number)} moved off ${String(mergeOptions.headSha)} before the merge; nothing was merged`,
            { details: { ...details, headSha: mergeOptions.headSha } },
          )
        }
        throw fleetError('external_failed', `glab mr merge ${String(number)} exited ${result.code}: ${result.stderr.trim() || 'no output'}`, {
          details,
        })
      }

      // The merge commit is a nicety, not the merge: a second call that fails leaves `mergeSha` absent, and the
      // `pr.merged` event records the head sha it merged either way (§3).
      const sha = await readRaw(repo, number)
        .then(mergeShaFrom)
        .catch(() => undefined)
      return sha === undefined ? {} : { mergeSha: sha }
    },

    /**
     * Every repository branch. GitLab pages at `per_page` with no `--paginate` on
     * `glab api`, so the page size is the limit — the same ceiling, and the same
     * caveat, as `list`: a repo with more branches than that reports the first page.
     */
    async branches(repo) {
      const raw = await api(`${projectPath(repo)}/repository/branches?per_page=${String(MAX_PER_PAGE)}`)
      return branchListFrom(raw)
    },

    /**
     * The project's trunk, as GitLab names it. A project setting, not a
     * convention: `main`, `master` and `develop` are all trunk somewhere.
     */
    async defaultBranch(repo) {
      const raw = await api(projectPath(repo))
      const name = raw === null || typeof raw !== 'object' ? undefined : (raw as { default_branch?: unknown }).default_branch
      if (typeof name !== 'string' || name === '') {
        throw fleetError('external_failed', `${String(repo)} reports no default branch`, {
          details: { repo: String(repo) },
        })
      }
      return name
    },

    /**
     * Delete, pinned to `expectedSha`, with the same read-check-delete sequence the
     * GitHub adapter uses and the same honest caveat: GitLab's delete endpoint takes
     * no conditional header, so the window between the calls is narrowed by the
     * comparison and closed only by the caller's reason — a merge whose head sha the
     * log recorded.
     */
    async deleteBranch(repo, branch, expectedSha) {
      const path = `${projectPath(repo)}/repository/branches/${encodeURIComponent(branch)}`
      const result = await glab.run(['api', path])
      if (result.code !== 0) {
        if (isMissing(result)) {
          throw fleetError('not_found', `${String(repo)} has no branch ${branch}`, {
            details: { repo: String(repo), branch },
          })
        }
        throw fleetError('external_failed', `glab api ${path} exited ${String(result.code)}: ${result.stderr.trim() || 'no output'}`, {
          details: { repo: String(repo), branch, exitCode: result.code },
        })
      }
      const current = branchShaFrom(result.stdout)
      if (current !== String(expectedSha)) {
        throw fleetError(
          'head_moved',
          `${String(repo)}'s ${branch} points at ${current ?? 'no sha'}, not ${String(expectedSha)}; nothing was deleted`,
          { details: { repo: String(repo), branch, expectedSha: String(expectedSha) } },
        )
      }
      const deleted = await glab.run(['api', path, '-X', 'DELETE'])
      if (deleted.code !== 0) {
        throw fleetError(
          'external_failed',
          `glab api ${path} -X DELETE exited ${String(deleted.code)}: ${deleted.stderr.trim() || 'no output'}`,
          { details: { repo: String(repo), branch, exitCode: deleted.code } },
        )
      }
    },
  }
}
