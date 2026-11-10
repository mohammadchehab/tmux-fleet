/**
 * GitLab's REST JSON as the contract's shapes (§10). Every case here is a
 * fixture: the mapping is pure, so the interesting states — no pipeline at all, a
 * retried pipeline, a status this build has never seen, a description with a
 * footer a human mistyped — need no `glab`, no network and no GitLab.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parse, repo } from '@fleet/foundation-core'
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

const pipeline = (id: number, status: string) => ({ id, status, ref: 'feat', sha: 'abc1234' })

describe('checksFrom: §10 reads the newest pipeline as one of three states', () => {
  it('is passing on a successful pipeline, and on one that ran no jobs', () => {
    assert.deepEqual(checksFrom([pipeline(1, 'success')]), { state: 'passing', failing: [] })
    assert.deepEqual(checksFrom([pipeline(1, 'skipped')]), { state: 'passing', failing: [] })
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

describe('reviewFrom: approvals, which is all GitLab reports', () => {
  it('is approved when GitLab says so, and cites the last approver', () => {
    const approvals = {
      approved: true,
      approved_by: [{ user: { username: 'first' } }, { user: { username: 'reviewer-1' } }],
    }
    assert.deepEqual(reviewFrom(approvals), { state: 'approved', reviewer: 'reviewer-1' })
  })

  it('is approved from a non-empty approved_by even when the flag lags behind', () => {
    assert.deepEqual(reviewFrom({ approved: false, approved_by: [{ user: { username: 'a' } }] }), {
      state: 'approved',
      reviewer: 'a',
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
    const pr = pullRequestFrom(mrJson(), where, [pipeline(1, 'success')])
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

  it('falls back to the embedded head_pipeline when the caller passed no pipelines', () => {
    const pr = pullRequestFrom(mrJson({ head_pipeline: { id: 5, status: 'failed' } }), where)
    assert.equal(pr.checks, 'failing')
    assert.deepEqual(pr.failingChecks, ['pipeline 5'])
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
