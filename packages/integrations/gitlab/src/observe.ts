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
 *    "nothing ran" as "nothing failed" would merge unchecked code.
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
import type { Branch, ChecksState, PullRequest, ReviewState } from '@fleet/foundation-contracts'

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
/** The two that mean "this commit was checked and nothing objected". `skipped` is a completed pipeline that ran no jobs. */
const passingStatuses: ReadonlySet<string> = new Set(['success', 'skipped'])

const pipelineId = (row: Readonly<Record<string, unknown>>): number => {
  const id = row['id']
  return typeof id === 'number' && Number.isInteger(id) ? id : 0
}

/** The name a nudge can cite. A pipeline has no name of its own, and its jobs would be one call each. */
const pipelineName = (row: Readonly<Record<string, unknown>>): string => `pipeline ${String(pipelineId(row))}`

/**
 * The merge request's pipelines as §10 states it: **the newest one** decides. A
 * retried pipeline leaves the failed attempt behind, so grading every pipeline
 * for a commit would keep a merge request red after someone fixed it.
 */
export const checksFrom = (value: unknown): { readonly state: ChecksState; readonly failing: readonly string[] } => {
  const pipelines = pipelinesIn(value)
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
 * answers the question; `approved_by` is read for the reviewer the record cites.
 */
export const reviewFrom = (value: unknown): ReviewObservation => {
  const row = record(value)
  const approvedBy = list(row?.['approved_by'])
  if (row?.['approved'] !== true && approvedBy.length === 0) return { state: 'pending' }

  const login = text(record(approvedBy.at(-1)?.['user'])?.['username'])
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
 * One GitLab merge request as the contract's `PullRequest`.
 *
 * `pipelines` is passed in rather than read off the row: `get` fetches them from
 * the merge request's own pipelines endpoint, and a list row carries at most the
 * embedded `head_pipeline`. When the caller has neither, the row's own
 * `head_pipeline` is what there is, and its absence is `pending` (rule 1).
 */
export const pullRequestFrom = (raw: unknown, on: Repo, pipelines?: unknown): PullRequest => {
  const row = record(raw)
  if (row === undefined) throw fleetError('external_failed', 'glab reported a merge request that is not an object')

  // GitLab's `iid` is the per-project number a human sees; `id` is the global one, and the port speaks in the first.
  const number = row['iid']
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) {
    throw fleetError('external_failed', 'glab reported a merge request with no iid', { details: { iid: number } })
  }

  const base = needText(row, 'target_branch')
  const head = needText(row, 'source_branch')
  const headSha = shape(shaShape(), row['sha'], 'sha')
  const checks = checksFrom(pipelines ?? row['head_pipeline'])
  const review = reviewFrom(row['approvals'] ?? row['approved_by'])
  const merged = row['state'] === 'merged' || (row['merged_at'] !== null && row['merged_at'] !== undefined)
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
    createdAt,
    updatedAt,
  }
}

/** `checks` on its own call: the sha the pipeline ran on travels with the verdict, so it can be matched (§10). */
export const gradedChecksFrom = (raw: unknown, pipelines: unknown): GradedChecks => {
  const row = record(raw)
  if (row === undefined) throw fleetError('external_failed', 'glab reported a merge request that is not an object')
  const headSha = shape(shaShape(), row['sha'], 'sha')
  return { ...checksFrom(pipelines), headSha }
}

/** The head sha a merge request is at, read on its own — what a refused merge is compared against (§10). */
export const headShaFrom = (raw: unknown): Sha => {
  const row = record(raw)
  if (row === undefined) throw fleetError('external_failed', 'glab reported a merge request that is not an object')
  return shape(shaShape(), row['sha'], 'sha')
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
