/**
 * GitLab's REST JSON as the contract's shapes (§10). Every case here is a
 * fixture: the mapping is pure, so the interesting states — no pipeline at all, a
 * retried pipeline, a status this build has never seen, a description with a
 * footer a human mistyped — need no `glab`, no network and no GitLab.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parse, repo, sha } from '@fleet/foundation-core'
import {
  checksFrom,
  createdFrom,
  footersFrom,
  gradedChecksFrom,
  headShaFrom,
  mergeShaFrom,
  pullRequestFrom,
  reviewFrom,
} from '../src/observe.ts'

const where = parse(repo(), 'backbase/fleet')

/** One GitLab merge request as `/projects/:id/merge_requests/:iid` returns it. */
const mrJson = (overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> => ({
  id: 12345,
  iid: 7,
  project_id: 99,
  title: 'Add pagination',
  description: 'Adds pagination\n\nFleet-Work: wrk_0123456789abcdef\n',
  state: 'opened',
  source_branch: 'feat',
  target_branch: 'main',
  sha: 'abc1234',
  merged_at: null,
  created_at: '2026-11-01T00:00:00.000Z',
  updated_at: '2026-11-02T00:00:00.000Z',
  ...overrides,
})

const pipeline = (id: number, status: string, overrides: Readonly<Record<string, unknown>> = {}) => ({
  id,
  status,
  ref: 'feat',
  sha: 'abc1234',
  ...overrides,
})

/** The head `mrJson` reports, so a call that pins grading has something to pin it to. */
const head = { sha: parse(sha(), 'abc1234'), ref: 'feat' } as const

/** The same head as a merge request reports it: with its iid and the pipeline GitLab calls its head_pipeline. */
const mrHead = { ...head, iid: 7, headPipelineId: 5 } as const

describe('checksFrom: §10 reads the newest pipeline as one of three states', () => {
  it('is passing on a successful pipeline', () => {
    assert.deepEqual(checksFrom([pipeline(1, 'success')]), { state: 'passing', failing: [] })
  })

  it('is pending on a skipped pipeline — it ran no jobs, so it says nothing about the commit', () => {
    // `[skip ci]` produces this for the head. Reading it as green would let the gate merge exactly the push nobody
    // checked, which is the case rule 1 is written for.
    assert.deepEqual(checksFrom([pipeline(1, 'skipped')]), { state: 'pending', failing: [] })
  })

  it('is pending when there is no pipeline at all — not green, because nothing ran', () => {
    assert.deepEqual(checksFrom([]), { state: 'pending', failing: [] })
    assert.deepEqual(checksFrom(null), { state: 'pending', failing: [] })
    assert.deepEqual(checksFrom(undefined), { state: 'pending', failing: [] })
  })

  it('names the pipeline that failed, and treats a canceled one as failing', () => {
    assert.deepEqual(checksFrom([pipeline(42, 'failed')]), { state: 'failing', failing: ['pipeline 42'] })
    assert.deepEqual(checksFrom([pipeline(42, 'canceled')]), { state: 'failing', failing: ['pipeline 42'] })
  })

  it('is pending while the pipeline runs, and for a status this build has never seen', () => {
    for (const status of ['running', 'pending', 'created', 'manual', 'preparing', 'something-new']) {
      assert.deepEqual(checksFrom([pipeline(1, status)]), { state: 'pending', failing: [] }, status)
    }
  })

  it('lets the newest pipeline decide, so a retry is not held red by the attempt it replaced', () => {
    assert.deepEqual(checksFrom([pipeline(1, 'failed'), pipeline(2, 'success')]), { state: 'passing', failing: [] })
    assert.deepEqual(checksFrom([pipeline(2, 'success'), pipeline(1, 'failed')]), { state: 'passing', failing: [] })
    // The other way round: the newest attempt failed even though an older one passed.
    assert.deepEqual(checksFrom([pipeline(1, 'success'), pipeline(2, 'failed')]), {
      state: 'failing',
      failing: ['pipeline 2'],
    })
  })

  it('reads the single `head_pipeline` a merge request embeds, as one pipeline', () => {
    assert.deepEqual(checksFrom({ id: 9, status: 'success' }), { state: 'passing', failing: [] })
    assert.deepEqual(checksFrom({ id: 9, status: 'failed' }), { state: 'failing', failing: ['pipeline 9'] })
  })
})

describe('checksFrom: the verdict is about the head sha, whatever else the merge request ran', () => {
  it('is pending when the newest pipeline is green on an older commit and the head has none', () => {
    // The finding this block exists for: `id` order says 2 is newest, and the merge request would have read
    // `passing` on a head no pipeline ever touched.
    const older = pipeline(2, 'success', { sha: '0ld0000' })
    const alsoOlder = pipeline(1, 'failed', { sha: '0ld0000' })
    assert.deepEqual(checksFrom([older, alsoOlder], head), { state: 'pending', failing: [] })
  })

  it('grades a pipeline on the head, even when a newer one ran on a different commit', () => {
    const onHead = pipeline(1, 'failed', { sha: 'abc1234' })
    const newer = pipeline(2, 'success', { sha: '0ld0000' })
    assert.deepEqual(checksFrom([onHead, newer], head), { state: 'failing', failing: ['pipeline 1'] })
  })

  it('drops a pipeline for another branch, so a green one on a sibling ref is not this head’s verdict', () => {
    assert.deepEqual(checksFrom([pipeline(1, 'success', { ref: 'other' })], head), { state: 'pending', failing: [] })
    // A row with no ref is the same branch as far as GitLab tells us; only a differing ref is a mismatch.
    assert.deepEqual(checksFrom([pipeline(1, 'success', { ref: undefined })], head), { state: 'passing', failing: [] })
  })

  it('accepts a detached MR pipeline on the head, and only this request’s refs/merge-requests/<iid>/head', () => {
    const detached = pipeline(1, 'success', { ref: 'refs/merge-requests/7/head', source: 'merge_request_event' })
    assert.deepEqual(checksFrom([detached], mrHead), { state: 'passing', failing: [] })
    // Without the iid, any detached-MR head ref on the head sha is still a detached MR pipeline.
    assert.deepEqual(checksFrom([detached], head), { state: 'passing', failing: [] })
    // Another request's ref is not this one's, even on the same sha.
    const other = pipeline(1, 'success', { ref: 'refs/merge-requests/8/head' })
    assert.deepEqual(checksFrom([other], mrHead), { state: 'pending', failing: [] })
    // A stale head sha on a detached ref is still stale.
    const stale = pipeline(1, 'success', { ref: 'refs/merge-requests/7/head', sha: '0ld0000' })
    assert.deepEqual(checksFrom([stale], mrHead), { state: 'pending', failing: [] })
  })

  it('accepts a merged-results pipeline only when it is this request’s merge ref and GitLab’s head_pipeline', () => {
    const merged = pipeline(5, 'success', { ref: 'refs/merge-requests/7/merge', sha: 'merge99' })
    assert.deepEqual(checksFrom([merged], mrHead), { state: 'passing', failing: [] })
    const failed = pipeline(5, 'failed', { ref: 'refs/merge-requests/7/merge', sha: 'merge99' })
    assert.deepEqual(checksFrom([failed], mrHead), { state: 'failing', failing: ['pipeline 5'] })
    // A stale merged-results run (an older head's) is a different pipeline id: dropped.
    const staleRun = pipeline(4, 'success', { ref: 'refs/merge-requests/7/merge', sha: 'merge88' })
    assert.deepEqual(checksFrom([staleRun], mrHead), { state: 'pending', failing: [] })
    // Another request's merge ref, even with the right id, is not this request's.
    const elsewhere = pipeline(5, 'success', { ref: 'refs/merge-requests/8/merge', sha: 'merge99' })
    assert.deepEqual(checksFrom([elsewhere], mrHead), { state: 'pending', failing: [] })
    // With no iid or head pipeline to tie it to, a merge-ref pipeline cannot be shown to describe the head.
    assert.deepEqual(checksFrom([merged], head), { state: 'pending', failing: [] })
  })

  it('pullRequestFrom grades a detached or merged-results head_pipeline instead of staying pending', () => {
    const detached = pipeline(5, 'success', { ref: 'refs/merge-requests/7/head' })
    assert.equal(pullRequestFrom(mrJson({ head_pipeline: detached }), where).checks, 'passing')
    const merged = pipeline(5, 'success', { ref: 'refs/merge-requests/7/merge', sha: 'merge99' })
    const asMr = mrJson({ head_pipeline: merged })
    assert.equal(pullRequestFrom(asMr, where).checks, 'passing')
    assert.equal(pullRequestFrom(asMr, where, { pipelines: [merged] }).checks, 'passing')
    assert.equal(gradedChecksFrom(asMr, [merged]).state, 'passing')
    // The same merge-ref run listed while head_pipeline is a newer one is stale.
    const newer = pipeline(6, 'running', { ref: 'refs/merge-requests/7/merge', sha: 'merge100' })
    assert.equal(pullRequestFrom(mrJson({ head_pipeline: newer }), where, { pipelines: [merged] }).checks, 'pending')
  })

  it('never grades a row with no sha, because it cannot be shown to describe the head', () => {
    assert.deepEqual(checksFrom([pipeline(1, 'success', { sha: undefined })], head), { state: 'pending', failing: [] })
  })

  it('still grades the newest matching attempt, so a retry on the head is not held red by the one it replaced', () => {
    const retried = pipeline(4, 'success', { sha: 'abc1234' })
    const firstTry = pipeline(3, 'failed', { sha: 'abc1234' })
    assert.deepEqual(checksFrom([firstTry, retried], head), { state: 'passing', failing: [] })
  })
})

describe('reviewFrom: approvals, which is all GitLab reports', () => {
  it('is approved when GitLab says so, and cites the last approver', () => {
    const approvals = {
      approved: true,
      approved_by: [{ user: { username: 'first' } }, { user: { username: 'reviewer-1' } }],
    }
    assert.deepEqual(reviewFrom(approvals), { state: 'approved', reviewer: 'reviewer-1' })
  })

  it('is approved with no name when GitLab approves and cites nobody', () => {
    assert.deepEqual(reviewFrom({ approved: true, approved_by: [] }), { state: 'approved' })
  })

  it('is pending when approved_by is populated but the flag is false — a project may require more than one', () => {
    // One approval on a two-approval project arrives as `approved: false` beside a single entry. The list is who
    // approved; only the flag says the project is satisfied, and the gate merges on that.
    assert.deepEqual(reviewFrom({ approved: false, approved_by: [{ user: { username: 'a' } }] }), {
      state: 'pending',
    })
  })

  it('is pending with no approvals — the gate only merges on an explicit one', () => {
    assert.deepEqual(reviewFrom({ approved: false, approved_by: [] }), { state: 'pending' })
    assert.deepEqual(reviewFrom(null), { state: 'pending' })
  })

  it('never says changes_requested: GitLab reports approvals, and a request for changes is a thread', () => {
    // A merge request with an open discussion is still `pending` here; the gate waits, which is the safe direction.
    assert.deepEqual(reviewFrom({ approved: false, approved_by: [], blocking_discussions_resolved: false }), {
      state: 'pending',
    })
  })
})

describe('footers: the two fields GitLab cannot know', () => {
  it('reads the work id and a same-repo stack parent out of the description', () => {
    const body = 'Body\n\nFleet-Work: wrk_0123456789abcdef\nFleet-Stack-Parent: #3\n'
    assert.deepEqual(footersFrom(body, where), {
      workId: 'wrk_0123456789abcdef',
      stackParent: { repo: where, number: 3 },
    })
  })

  it('reads a cross-repo parent, and ignores anything it cannot parse', () => {
    assert.deepEqual(footersFrom('Fleet-Stack-Parent: other/repo#12', where), {
      stackParent: { repo: parse(repo(), 'other/repo'), number: 12 },
    })
    // Advisory: free text a human edits. A bad footer is absent, never a failure.
    assert.deepEqual(footersFrom('Fleet-Work: not-a-work-id\nFleet-Stack-Parent: nonsense', where), {})
    assert.deepEqual(footersFrom(undefined, where), {})
  })
})

describe('pullRequestFrom: one merge request as the contract shape', () => {
  it('maps the fields the port speaks in, with iid as the number', () => {
    const pr = pullRequestFrom(mrJson(), where, { pipelines: [pipeline(1, 'success')] })
    assert.equal(pr.repo, where)
    assert.equal(pr.number, 7)
    assert.equal(pr.base, 'main')
    assert.equal(pr.head, 'feat')
    assert.equal(pr.headSha, 'abc1234')
    assert.equal(pr.checks, 'passing')
    assert.equal(pr.review, 'pending')
    assert.equal(pr.merged, false)
    assert.equal(pr.workId, 'wrk_0123456789abcdef')
    assert.equal(pr.createdAt, '2026-11-01T00:00:00.000Z')
    assert.equal(pr.updatedAt, '2026-11-02T00:00:00.000Z')
  })

  it('is merged when GitLab says merged, however it says it', () => {
    assert.equal(pullRequestFrom(mrJson({ state: 'merged' }), where).merged, true)
    assert.equal(pullRequestFrom(mrJson({ merged_at: '2026-11-03T00:00:00.000Z' }), where).merged, true)
  })

  it('reads the review from the approvals endpoint, which is the only place GitLab says it', () => {
    // `approved` is not a field of the merge request: it lives at `/approvals`, so a
    // row read without that call is `pending` by omission, not by GitLab's answer.
    const approved = pullRequestFrom(mrJson(), where, { approvals: { approved: true } })
    assert.equal(approved.review, 'approved')
    assert.equal(pullRequestFrom(mrJson(), where, { approvals: { approved: false } }).review, 'pending')
    // The row's own copy is a fallback for a caller that had one, and the endpoint's answer wins over it.
    assert.equal(
      pullRequestFrom(mrJson({ approvals: { approved: true } }), where, { approvals: { approved: false } }).review,
      'pending',
    )
  })

  it('falls back to the embedded head_pipeline when the caller passed no pipelines', () => {
    const pr = pullRequestFrom(mrJson({ head_pipeline: { id: 5, status: 'failed', sha: 'abc1234' } }), where)
    assert.equal(pr.checks, 'failing')
    assert.deepEqual(pr.failingChecks, ['pipeline 5'])
  })

  it('reads pending when the merged pipelines are green but ran on an older commit', () => {
    const pr = pullRequestFrom(mrJson(), where, { pipelines: [pipeline(7, 'success', { sha: '0ld0000' })] })
    assert.equal(pr.checks, 'pending')
    assert.equal(pr.headSha, 'abc1234')
  })

  it('carries GitLab’s own state, in the words the contract uses', () => {
    // GitLab spells "open" `opened`. The three words `worktree-gc` branches on (§9) are
    // the contract's, so the adapter translates rather than passing the word along: a
    // `closed` a caller does not recognise would read as unknown, and unknown keeps —
    // safe, but a checkout nobody ever collects.
    assert.equal(pullRequestFrom(mrJson({ state: 'opened' }), where).state, 'open')
    assert.equal(pullRequestFrom(mrJson({ state: 'closed' }), where).state, 'closed')
    assert.equal(pullRequestFrom(mrJson({ state: 'merged' }), where).state, 'merged')
  })

  it('leaves `state` out for a word it does not model, so it reads as unknown and never as closed', () => {
    assert.equal('state' in pullRequestFrom(mrJson({ state: 'locked' }), where), false)
    assert.equal('state' in pullRequestFrom(mrJson({ state: undefined }), where), false)
  })

  it('refuses a merge request it cannot model rather than inventing one', () => {
    assert.throws(() => pullRequestFrom(mrJson({ iid: undefined }), where), /no iid/)
    assert.throws(() => pullRequestFrom(mrJson({ sha: 'not-a-sha' }), where), /unusable sha/)
    assert.throws(() => pullRequestFrom(mrJson({ source_branch: '' }), where), /no source_branch/)
    assert.throws(() => pullRequestFrom('not an object', where), /not an object/)
  })
})

describe('the single-value reads', () => {
  it('carries the sha the pipeline ran on with the verdict', () => {
    assert.deepEqual(gradedChecksFrom(mrJson(), [pipeline(1, 'failed')]), {
      state: 'failing',
      failing: ['pipeline 1'],
      headSha: 'abc1234',
    })
  })

  it('cannot report a sha the verdict did not grade: a green pipeline on an older commit is pending', () => {
    assert.deepEqual(gradedChecksFrom(mrJson(), [pipeline(1, 'success', { sha: '0ld0000' })]), {
      state: 'pending',
      failing: [],
      headSha: 'abc1234',
    })
  })

  it('reads the head sha on its own, for the re-read after a refused merge', () => {
    assert.equal(headShaFrom(mrJson()), 'abc1234')
  })

  it('finds the merge request number in either spelling `glab mr create` prints', () => {
    assert.deepEqual(createdFrom('https://gitlab.example/backbase/fleet/-/merge_requests/64\n', where), {
      repo: where,
      number: 64,
    })
    assert.deepEqual(createdFrom('!64\n', where), { repo: where, number: 64 })
    assert.throws(() => createdFrom('nothing useful', where), /printed no merge request reference/)
  })

  it('reads the commit a merge produced, squash or not', () => {
    assert.equal(mergeShaFrom({ merge_commit_sha: 'def5678' }), 'def5678')
    assert.equal(mergeShaFrom({ squash_commit_sha: 'def5678' }), 'def5678')
    assert.equal(mergeShaFrom({ merge_commit_sha: null }), undefined)
    assert.equal(mergeShaFrom(null), undefined)
  })
})
