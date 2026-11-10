/**
 * `gh --json` read into the contract's shapes (§10). Everything here is pure:
 * a parsed JSON value goes in, a `PullRequest` or a checks observation comes
 * out, and the whole mapping is testable on a fixture with no `gh` at all.
 *
 * Two decisions worth stating, because they are rules and not formatting:
 *
 * 1. **No checks is `pending`, not `passing`.** `statusCheckRollup` is empty for
 *    a PR whose workflows have not started, and a PR with no checks is exactly
 *    what §10's "green on the head sha" is there to refuse. An empty rollup
 *    that read as green would merge unchecked code.
 * 2. **Only a failure is named.** `failing` lists the check names a nudge can
 *    cite; `pending` and `passing` carry an empty list, so nothing downstream
 *    has to re-filter.
 *
 * The two fields `gh` cannot know — which Work item a PR belongs to, and which
 * PR it stacks on — are read from the body's footer lines (`Fleet-Work:`,
 * `Fleet-Stack-Parent:`). They are advisory: a body is free text a human edits,
 * so a malformed footer is ignored rather than raised, while a malformed
 * `number` or `headRefOid` is a real failure — that JSON is not one we model.
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
import type { ChecksState, PullRequest, ReviewState } from '@fleet/foundation-contracts'

/** One checks observation. `headSha` is the sha `gh` graded — the whole point of `matchHeadSha` (§10). */
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

/** A value the contract has a schema for, or a sentence saying `gh` gave us something this package does not model. */
const shape = <T>(schema: Schema<T>, value: unknown, field: string): T => {
  const result = safeParse(schema, value)
  if (result.ok) return result.value
  const why = result.error.issues.map((issue) => issue.message).join('; ')
  throw fleetError('external_failed', `gh reported an unusable ${field}: ${why}`, { details: { field } })
}

const needText = (row: Readonly<Record<string, unknown>>, field: string): string => {
  const value = text(row[field])
  if (value === undefined || value === '') {
    throw fleetError('external_failed', `gh reported a pull request with no ${field}`, { details: { field } })
  }
  return value
}

// ------------------------------------------------------------------- checks

/** A completed check that means "do not merge". `SKIPPED` and `NEUTRAL` are not here on purpose. */
const failingConclusions: ReadonlySet<string> = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])
/** A legacy commit status that means the same. */
const failingStates: ReadonlySet<string> = new Set(['FAILURE', 'ERROR'])

/**
 * `statusCheckRollup` as §10 states it. A rollup mixes `CheckRun` (`status` +
 * `conclusion`) with `StatusContext` (`state`), so both spellings are read;
 * `name` and `context` are the two names a check can carry.
 */
export const checksFrom = (rollup: unknown): { readonly state: ChecksState; readonly failing: readonly string[] } => {
  const entries = list(rollup)
  const failing: string[] = []
  let pending = false

  for (const entry of entries) {
    const conclusion = text(entry['conclusion']) ?? ''
    const state = text(entry['state']) ?? ''
    const status = text(entry['status']) ?? ''
    const name = text(entry['name']) ?? text(entry['context']) ?? 'an unnamed check'

    if (failingConclusions.has(conclusion) || failingStates.has(state)) {
      failing.push(name)
      continue
    }
    // A legacy commit status has only `state`; anything that is not SUCCESS has not passed yet.
    if (state !== '') {
      if (state !== 'SUCCESS') pending = true
      continue
    }
    // A `CheckRun` is a verdict only once it is COMPLETED with a conclusion. A check gh has created but not
    // started carries neither, and that is not a verdict either.
    if (status !== 'COMPLETED' || conclusion === '') pending = true
  }

  if (failing.length > 0) return { state: 'failing', failing }
  if (entries.length === 0 || pending) return { state: 'pending', failing: [] }
  return { state: 'passing', failing: [] }
}

// ------------------------------------------------------------------- review

/** §10's required review, from `reviewDecision`; the reviewer is the last approval, when there is one. */
export const reviewFrom = (reviewDecision: unknown, latestReviews: unknown): ReviewObservation => {
  const decision = text(reviewDecision) ?? ''
  const state: ReviewState =
    decision === 'APPROVED' ? 'approved' : decision === 'CHANGES_REQUESTED' ? 'changes_requested' : 'pending'
  if (state !== 'approved') return { state }

  const approvers = list(latestReviews).filter((review) => text(review['state']) === 'APPROVED')
  const login = text(record(approvers.at(-1)?.['author'])?.['login'])
  return login === undefined ? { state } : { state, reviewer: login }
}

// ------------------------------------------------------------------ footers

const WORK_FOOTER = /^Fleet-Work:[ \t]*(\S+)[ \t]*$/m
const PARENT_FOOTER = /^Fleet-Stack-Parent:[ \t]*(\S+)[ \t]*$/m

/**
 * `owner/name#12`, or `#12` for a PR in the same repo. Anything else is not a
 * footer this package understands.
 *
 * The footer is text a stranger can write, so it may not name a *host*: `gh -R`
 * reads `HOST/OWNER/REPO`, which means a three-segment footer would choose the
 * host the gate then talks to. GitHub has no nested repos, so exactly two
 * segments is the whole grammar — the widened `Repo` type does not widen this.
 */
const parseParent = (value: string, on: Repo): { readonly repo: Repo; readonly number: number } | undefined => {
  const match = /^(?:([^#\s]+))?#(\d+)$/.exec(value)
  if (match === null) return undefined
  const owner = match[1]
  const number = Number(match[2])
  if (!Number.isInteger(number) || number < 1) return undefined
  if (owner !== undefined && owner.split('/').length !== 2) return undefined
  const where = safeParse(repoShape(), owner ?? String(on))
  return where.ok ? { repo: where.value, number } : undefined
}

/** The body's advisory footers. A body is free text, so anything unusable is simply not there. */
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

// -------------------------------------------------------------- pull request

/**
 * One row of `gh pr view`/`gh pr list --json` as the contract's `PullRequest`.
 * `on` is the repo that was asked about, because `gh` does not repeat it in
 * every row and every row of one call belongs to it.
 */
export const pullRequestFrom = (raw: unknown, on: Repo): PullRequest => {
  const row = record(raw)
  if (row === undefined) throw fleetError('external_failed', 'gh reported a pull request that is not an object')

  const number = row['number']
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) {
    throw fleetError('external_failed', 'gh reported a pull request with no number', { details: { number } })
  }

  const base = needText(row, 'baseRefName')
  const head = needText(row, 'headRefName')
  const headSha = shape(shaShape(), row['headRefOid'], 'headRefOid')
  const checks = checksFrom(row['statusCheckRollup'])
  const review = reviewFrom(row['reviewDecision'], row['latestReviews'])
  const merged = row['mergedAt'] !== null && row['mergedAt'] !== undefined
  const createdAt = shape(timestamp(), row['createdAt'], 'createdAt')
  const updatedAt = shape(timestamp(), row['updatedAt'], 'updatedAt')

  return {
    repo: on,
    number,
    base,
    head,
    headSha,
    checks: checks.state,
    failingChecks: checks.failing,
    review: review.state,
    ...footersFrom(row['body'], on),
    merged,
    createdAt,
    updatedAt,
  }
}

/** `checks` on its own call: the sha that was graded travels with the verdict, so it can be matched (§10). */
export const gradedChecksFrom = (raw: unknown): GradedChecks => {
  const row = record(raw)
  if (row === undefined) throw fleetError('external_failed', 'gh reported a pull request that is not an object')
  const headSha = shape(shaShape(), row['headRefOid'], 'headRefOid')
  return { ...checksFrom(row['statusCheckRollup']), headSha }
}

/** The PR number `gh pr create` prints as a URL, and nothing else. */
export const createdFrom = (stdout: string, on: Repo): { readonly repo: Repo; readonly number: number } => {
  const match = /\/pull\/(\d+)\b/.exec(stdout)
  const number = match?.[1] === undefined ? Number.NaN : Number(match[1])
  if (!Number.isInteger(number) || number < 1) {
    throw fleetError('external_failed', 'gh pr create printed no pull request URL', {
      details: { stdout: stdout.trim().slice(0, 200) },
    })
  }
  return { repo: on, number }
}

/** `mergeCommit` after a merge, when `gh` reports one. Abbreviated shas are what the contract stores. */
export const mergeShaFrom = (raw: unknown): Sha | undefined => {
  const oid = text(record(record(raw)?.['mergeCommit'])?.['oid'])
  if (oid === undefined) return undefined
  const parsed = safeParse(shaShape(), oid)
  return parsed.ok ? parsed.value : undefined
}
