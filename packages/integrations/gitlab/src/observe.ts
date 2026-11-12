/**
 * GitLab's REST JSON read into the contract's shapes (§10). Everything here is
 * pure: a parsed JSON value goes in, a `PullRequest` or a checks observation
 * comes out, and the whole mapping is testable on a fixture with no `glab` at
 * all — the same split `@fleet/integrations-github` uses for `gh --json`.
 *
 * Three decisions worth stating, because they are rules and not formatting:
 *
 * 1. **No pipeline is `pending`, not `passing`.** A merge request whose pipeline
 *    has not started has no `head_pipeline`, and a merge request with no pipeline
 *    is exactly what §10's "green on the head sha" is there to refuse. Reading
 *    "nothing ran" as "nothing failed" would merge unchecked code. The rule is a
 *    **pin on the sha**, not just a count: a pipeline that ran on an earlier
 *    commit is not a verdict about this head, so it is never graded, and no
 *    pipeline *on the head* is `pending` however green the commit behind it was.
 *    `skipped` is that case in another spelling — `[skip ci]` completes a
 *    pipeline that ran no jobs.
 * 2. **A status this package does not model is `pending`.** GitLab adds pipeline
 *    statuses (`waiting_for_resource`, `preparing`, `scheduled`, …); a verdict is
 *    only `passing` for the statuses that mean it, so an unknown one waits for a
 *    human rather than merging.
 * 3. **`review` cannot say `changes_requested`.** GitLab's approvals endpoint
 *    reports who approved, not who asked for changes — a "request changes" review
 *    is a discussion thread, which is a different resource. So only `approved`
 *    and `pending` are produced. That is safe in the one direction that matters:
 *    the gate requires `approved`, and a request for changes can only ever make
 *    it wait, never merge.
 *
 * As in the GitHub adapter, the two fields the forge cannot know — which Work
 * item a merge request belongs to, and which one it stacks on — are read from
 * the description's footer lines (`Fleet-Work:`, `Fleet-Stack-Parent:`). They
 * are advisory: a description is free text a human edits, so a malformed footer
 * is ignored rather than raised, while a malformed `iid` or `sha` is a real
 * failure — that JSON is not one we model.
 */

import {
  fleetError,
  repo as repoShape,
  safeParse,
  sha as shaShape,
  timestamp,
  workId as workIdShape,
  type Repo,
  type Schema,
  type Sha,
} from '@fleet/foundation-core'
import { pullRequestStates } from '@fleet/foundation-contracts'
import type {
  Branch,
  ChecksState,
  ForgePullRequest,
  PullRequestState,
  ReviewState,
} from '@fleet/foundation-contracts'

/** One checks observation. `headSha` is the commit the pipeline ran on — the whole point of §10's pin. */
export interface GradedChecks {
  readonly state: ChecksState
  readonly failing: readonly string[]
  readonly headSha: Sha
}

export interface ReviewObservation {
  readonly state: ReviewState
  readonly reviewer?: string
}

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

const list = (value: unknown): readonly Readonly<Record<string, unknown>>[] => {
  if (!Array.isArray(value)) return []
  const rows: Readonly<Record<string, unknown>>[] = []
  for (const entry of value) {
    const row = record(entry)
    if (row !== undefined) rows.push(row)
  }
  return rows
}

/**
 * The pipelines a response carries, in either spelling GitLab uses: the array
 * from `/merge_requests/:iid/pipelines`, or the single `head_pipeline` object a
 * merge request embeds. A row with no `status` is not a pipeline, so a `null`
 * `head_pipeline` contributes nothing — which reads as "no pipeline", and rule 1
 * makes that `pending`.
 */
const pipelinesIn = (value: unknown): readonly Readonly<Record<string, unknown>>[] => {
  const single = record(value)
  if (single !== undefined && text(single['status']) !== undefined) return [single]
  return list(value)
}

/** A value the contract has a schema for, or a sentence saying `glab` gave us something this package does not model. */
const shape = <T>(schema: Schema<T>, value: unknown, field: string): T => {
  const result = safeParse(schema, value)
  if (result.ok) return result.value
  const why = result.error.issues.map((issue) => issue.message).join('; ')
  throw fleetError('external_failed', `glab reported an unusable ${field}: ${why}`, { details: { field } })
}

const needText = (row: Readonly<Record<string, unknown>>, field: string): string => {
  const value = text(row[field])
  if (value === undefined || value === '') {
    throw fleetError('external_failed', `glab reported a merge request with no ${field}`, { details: { field } })
  }
  return value
}

// ------------------------------------------------------------------- checks

/** Pipeline statuses that mean "do not merge". `canceled` is here: a pipeline that stopped is not a green one. */
const failingStatuses: ReadonlySet<string> = new Set(['failed', 'canceled'])
/**
 * The one status that means "this commit was checked and nothing objected".
 * `skipped` is deliberately not here: a pipeline that ran no jobs says nothing
 * about the commit, and rule 1 makes "nothing ran" wait rather than merge.
 */
const passingStatuses: ReadonlySet<string> = new Set(['success'])

const pipelineId = (row: Readonly<Record<string, unknown>>): number => {
  const id = row['id']
  return typeof id === 'number' && Number.isInteger(id) ? id : 0
}

/** The name a nudge can cite. A pipeline has no name of its own, and its jobs would be one call each. */
const pipelineName = (row: Readonly<Record<string, unknown>>): string => `pipeline ${String(pipelineId(row))}`

/**
 * The commit a verdict is about: the head the merge request is at now, and the
 * branch it came from. Both come from the merge request rather than from the
 * pipelines, because the pipelines are what is being judged.
 */
export interface ChecksAt {
  readonly sha: Sha
  readonly ref?: string
}

/**
 * The ref a *detached* merge-request pipeline reports instead of the source branch. It runs on the head commit
 * itself, so the sha pin still holds; only the ref differs. A merged-results pipeline (`.../merge`) runs on a
 * synthesized commit that is not the head, so it is deliberately not matched: the sha pin cannot vouch for it, and
 * it stays `pending` rather than being graded on a commit nobody identified.
 */
const detachedMergeRequestRef = /^refs\/merge-requests\/\d+\/head$/

/**
 * The rows that ran on `at` — rule 1's pin, as a filter over the pipelines. A row
 * carrying no `sha` cannot be shown to describe `at`, so it is dropped: a verdict
 * about a commit nobody identified is the one thing §10 must not act on. `ref` is
 * compared only when the row has one, since GitLab leaves it off some pipeline
 * rows and a missing ref is not a different branch.
 */
const ranOn = (
  rows: readonly Readonly<Record<string, unknown>>[],
  at: ChecksAt | undefined,
): readonly Readonly<Record<string, unknown>>[] => {
  if (at === undefined) return rows
  return rows.filter((row) => {
    if (text(row['sha']) !== at.sha) return false
    const ref = text(row['ref'])
    return at.ref === undefined || ref === undefined || ref === at.ref || detachedMergeRequestRef.test(ref)
  })
}

/**
 * The merge request's pipelines as §10 states it: **the newest one that ran on the
 * head** decides. A retried pipeline leaves the failed attempt behind, so grading
 * every pipeline for a commit would keep a merge request red after someone fixed
 * it. With `at`, a pipeline for an older commit is dropped before the newest is
 * picked, and none left means `pending` — the head itself was never checked, and
 * an older pipeline being green is not evidence that it was.
 *
 * `at` is optional for the caller that has no head in hand and is grading a bare
 * pipeline list; every path from a merge request passes it.
 */
export const checksFrom = (
  value: unknown,
  at?: ChecksAt,
): { readonly state: ChecksState; readonly failing: readonly string[] } => {
  const pipelines = ranOn(pipelinesIn(value), at)
  if (pipelines.length === 0) return { state: 'pending', failing: [] }

  let latest = pipelines[0]
  for (const row of pipelines) {
    if (latest === undefined || pipelineId(row) > pipelineId(latest)) latest = row
  }
  if (latest === undefined) return { state: 'pending', failing: [] }

  const status = text(latest['status']) ?? ''
  if (failingStatuses.has(status)) return { state: 'failing', failing: [pipelineName(latest)] }
  if (passingStatuses.has(status)) return { state: 'passing', failing: [] }
  // Running, pending, manual, or a status this build has never seen: a verdict has not arrived (§10, rule 2).
  return { state: 'pending', failing: [] }
}

// ------------------------------------------------------------------- review

/**
 * `/merge_requests/:iid/approvals` as §10's review. `approved` is the field that
 * answers the question, and it is the only one that can: it is GitLab's own
 * verdict, computed against the approval count the project *requires*.
 * `approved_by` is who approved, not whether the project is satisfied — a
 * project that needs two approvals reports `approved: false` beside a single
 * entry, so reading the list as the verdict would open the gate on half the
 * approvals it asks for. The list is read for the reviewer the record cites.
 */
export const reviewFrom = (value: unknown): ReviewObservation => {
  const row = record(value)
  if (row?.['approved'] !== true) return { state: 'pending' }

  const login = text(record(list(row['approved_by']).at(-1)?.['user'])?.['username'])
  return login === undefined ? { state: 'approved' } : { state: 'approved', reviewer: login }
}

// ------------------------------------------------------------------ footers

const WORK_FOOTER = /^Fleet-Work:[ \t]*(\S+)[ \t]*$/m
const PARENT_FOOTER = /^Fleet-Stack-Parent:[ \t]*(\S+)[ \t]*$/m

/** `owner/name#12`, or `#12` for a merge request in the same repo. Anything else is not a footer this package understands. */
const parseParent = (value: string, on: Repo): { readonly repo: Repo; readonly number: number } | undefined => {
  const match = /^(?:([^#\s]+))?#(\d+)$/.exec(value)
  if (match === null) return undefined
  const owner = match[1]
  const number = Number(match[2])
  if (!Number.isInteger(number) || number < 1) return undefined
  const where = safeParse(repoShape(), owner ?? String(on))
  return where.ok ? { repo: where.value, number } : undefined
}

/** The description's advisory footers. A description is free text, so anything unusable is simply not there. */
export const footersFrom = (
  body: unknown,
  on: Repo,
): { readonly workId?: string; readonly stackParent?: { readonly repo: Repo; readonly number: number } } => {
  const value = text(body) ?? ''
  const work = WORK_FOOTER.exec(value)
  const workId = work?.[1] === undefined ? undefined : safeParse(workIdShape(), work[1])
  const parent = PARENT_FOOTER.exec(value)
  const stackParent = parent?.[1] === undefined ? undefined : parseParent(parent[1], on)

  return {
    ...(workId?.ok === true ? { workId: String(workId.value) } : {}),
    ...(stackParent === undefined ? {} : { stackParent }),
  }
}

// -------------------------------------------------------------- merge request

/**
 * GitLab's own `state` as the contract spells it. GitLab says `opened` where the
 * contract says `open`; anything it names that is not one of the three is left off
 * rather than guessed, because §9 removes a checkout only on an explicit `closed`.
 */
const stateFrom = (value: unknown): PullRequestState | undefined => {
  const lower = typeof value === 'string' ? value.toLowerCase() : undefined
  const named = lower === 'opened' ? 'open' : lower
  return pullRequestStates.find((state) => state === named)
}

/** What the caller fetched from the merge request's own endpoints, beyond the row GitLab lists. */
export interface MergeRequestEvidence {
  /** The merge request's own `/pipelines` endpoint. */
  readonly pipelines?: unknown
  /** The merge request's own `/approvals` endpoint — the only place GitLab reports `approved`. */
  readonly approvals?: unknown
}

/**
 * GitLab's `iid` is the per-project number a human sees; `id` is the global one, and
 * the port speaks in the first. `undefined` when the row has no usable one.
 */
export const iidOf = (raw: unknown): number | undefined => {
  const iid = record(raw)?.['iid']
  return typeof iid === 'number' && Number.isInteger(iid) && iid >= 1 ? iid : undefined
}

/**
 * One GitLab merge request as the contract's `PullRequest`.
 *
 * `pipelines` and `approvals` are passed in rather than read off the row: both are
 * endpoints of their own in GitLab, and a merge request's own JSON carries neither.
 * `checksFrom` falls back to the row's embedded `head_pipeline` (rule 1), and the
 * review falls back to whatever approvals a caller put on the row; when there is
 * none, `pending` — "not fetched" is never "approved" (§10).
 *
 * `state` travels too, and it is the one field here the log cannot hold: §3 has no
 * `pr.closed`, so this is where "still open" comes from (§9).
 */
export const pullRequestFrom = (raw: unknown, on: Repo, evidence: MergeRequestEvidence = {}): ForgePullRequest => {
  const row = record(raw)
  if (row === undefined) throw fleetError('external_failed', 'glab reported a merge request that is not an object')

  const number = iidOf(raw)
  if (number === undefined) {
    throw fleetError('external_failed', 'glab reported a merge request with no iid', { details: { iid: row['iid'] } })
  }

  const base = needText(row, 'target_branch')
  const head = needText(row, 'source_branch')
  const headSha = shape(shaShape(), row['sha'], 'sha')
  const checks = checksFrom(evidence.pipelines ?? row['head_pipeline'], { sha: headSha, ref: head })
  const review = reviewFrom(evidence.approvals ?? row['approvals'] ?? row['approved_by'])
  const merged = row['state'] === 'merged' || (row['merged_at'] !== null && row['merged_at'] !== undefined)
  const state = stateFrom(row['state'])
  const createdAt = shape(timestamp(), row['created_at'], 'created_at')
  const updatedAt = shape(timestamp(), row['updated_at'], 'updated_at')

  return {
    repo: on,
    number,
    base,
    head,
    headSha,
    checks: checks.state,
    failingChecks: checks.failing,
    review: review.state,
    ...footersFrom(row['description'], on),
    merged,
    ...(state === undefined ? {} : { state }),
    createdAt,
    updatedAt,
  }
}

/**
 * `checks` on its own call: the sha the pipeline ran on travels with the verdict,
 * so it can be matched (§10). The verdict is graded only against pipelines at
 * `headSha`, which is what keeps the pair from describing two commits — the sha
 * that is reported is the sha that was asked about, so a green pipeline on an
 * older commit can no longer travel as this one's.
 */
export const gradedChecksFrom = (raw: unknown, pipelines: unknown): GradedChecks => {
  const row = record(raw)
  if (row === undefined) throw fleetError('external_failed', 'glab reported a merge request that is not an object')
  const headSha = shape(shaShape(), row['sha'], 'sha')
  const head = text(row['source_branch'])
  return { ...checksFrom(pipelines, { sha: headSha, ...(head === undefined ? {} : { ref: head }) }), headSha }
}

/** The head sha a merge request is at, read on its own — what a refused merge is compared against (§10). */
export const headShaFrom = (raw: unknown): Sha => {
  const row = record(raw)
  if (row === undefined) throw fleetError('external_failed', 'glab reported a merge request that is not an object')
  return shape(shaShape(), row['sha'], 'sha')
}

/**
 * The branch a merge request comes from. `dependents` wants only this, which is why
 * it reads the merge request itself instead of `get` — pipelines and approvals are
 * evidence no stack decision looks at.
 */
export const sourceBranchFrom = (raw: unknown): string => {
  const row = record(raw)
  if (row === undefined) throw fleetError('external_failed', 'glab reported a merge request that is not an object')
  return needText(row, 'source_branch')
}

/**
 * The merge request number `glab mr create` prints, from either spelling it
 * uses: the URL (`…/-/merge_requests/64`) or the short reference (`!64`).
 */
export const createdFrom = (stdout: string, on: Repo): { readonly repo: Repo; readonly number: number } => {
  const match = /(?:merge_requests\/|!)(\d+)\b/.exec(stdout)
  const number = match?.[1] === undefined ? Number.NaN : Number(match[1])
  if (!Number.isInteger(number) || number < 1) {
    throw fleetError('external_failed', 'glab mr create printed no merge request reference', {
      details: { stdout: stdout.trim().slice(0, 200) },
    })
  }
  return { repo: on, number }
}

/**
 * The commit the merge produced, when GitLab reports one: a squash merge has a
 * `squash_commit_sha` and no `merge_commit_sha`, so both spellings are read.
 */
export const mergeShaFrom = (raw: unknown): Sha | undefined => {
  const row = record(raw)
  const candidate = text(row?.['merge_commit_sha']) ?? text(row?.['squash_commit_sha'])
  if (candidate === undefined) return undefined
  const parsed = safeParse(shaShape(), candidate)
  return parsed.ok ? parsed.value : undefined
}

// ------------------------------------------------------------------ branches

/**
 * The head sha `glab api …/repository/branches/<branch>` reports, or `undefined`
 * when the output is not a branch. It is compared rather than returned as a `Sha`
 * because the caller asks whether it equals a sha it already holds (§10's pin).
 */
export const branchShaFrom = (stdout: string): string | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout) as unknown
  } catch {
    return undefined
  }
  return text(record(record(parsed)?.['commit'])?.['id'])
}

/**
 * `glab api …/repository/branches` as the port's `Branch[]`. A row without a name
 * or an unusable `commit.id` is a response this package does not model, not a
 * branch to skip: a sweep that skipped one would leave it forever.
 */
export const branchListFrom = (raw: unknown): readonly Branch[] => {
  if (!Array.isArray(raw)) {
    throw fleetError('external_failed', 'glab api branches printed something that is not a list')
  }
  const branches: Branch[] = []
  for (const row of list(raw)) {
    const name = text(row['name'])
    if (name === undefined || name === '') {
      throw fleetError('external_failed', 'glab reported a branch with no name')
    }
    const sha = record(row['commit'])?.['id']
    branches.push({ name, sha: shape(shaShape(), sha, 'branch head') })
  }
  return branches
}
