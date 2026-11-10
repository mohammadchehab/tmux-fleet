/**
 * `gh --json` as the contract's shapes (§10). Every case here is a fixture: the
 * mapping is pure, so the interesting states — a rollup that mixes `CheckRun`
 * with `StatusContext`, a PR with no checks at all, a body with a footer a human
 * mistyped — need no `gh`, no network and no repository.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parse, repo } from '@fleet/foundation-core'
import {
  checksFrom,
  createdFrom,
  footersFrom,
  gradedChecksFrom,
  mergeShaFrom,
  pullRequestFrom,
  reviewFrom,
} from '../src/observe.ts'

const where = parse(repo(), 'mohammadchehab/tmux-fleet')

/** A page of `gh pr view --json` as the real call returns it. */
const prJson = (overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> => ({
  number: 7,
  baseRefName: 'main',
  headRefName: 'feat',
  headRefOid: 'abc1234',
  reviewDecision: 'APPROVED',
  latestReviews: [{ state: 'APPROVED', author: { login: 'reviewer-1' } }],
  statusCheckRollup: [{ __typename: 'CheckRun', name: 'checks', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  mergedAt: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-02T00:00:00.000Z',
  body: 'Adds pagination\n\nFleet-Work: wrk_0123456789abcdef\n',
  ...overrides,
})

const checkRun = (name: string, status: string, conclusion: string) => ({ __typename: 'CheckRun', name, status, conclusion })
const statusContext = (context: string, state: string) => ({ __typename: 'StatusContext', context, state })

describe('checksFrom: §10 reads a rollup as one of three states', () => {
  it('is passing when every check reached a non-failing verdict', () => {
    assert.deepEqual(
      checksFrom([
        checkRun('checks', 'COMPLETED', 'SUCCESS'),
        checkRun('lint', 'COMPLETED', 'NEUTRAL'),
        checkRun('docs', 'COMPLETED', 'SKIPPED'),
        statusContext('legacy-ci', 'SUCCESS'),
      ]),
      { state: 'passing', failing: [] },
    )
  })

  it('is pending the moment one check has not voted, and names nothing', () => {
    const rollup = [checkRun('checks', 'COMPLETED', 'SUCCESS'), checkRun('security', 'IN_PROGRESS', '')]
    assert.deepEqual(checksFrom(rollup), { state: 'pending', failing: [] })
    assert.deepEqual(checksFrom([statusContext('legacy-ci', 'PENDING')]), { state: 'pending', failing: [] })
    // A check gh has created but not started carries neither field, and that is not a verdict either.
    assert.deepEqual(checksFrom([{ __typename: 'CheckRun', name: 'fresh' }]), { state: 'pending', failing: [] })
  })

  it('is failing from either flavour of check, and names the ones a nudge can cite', () => {
    const rollup = [
      checkRun('checks', 'COMPLETED', 'FAILURE'),
      checkRun('timeout', 'COMPLETED', 'TIMED_OUT'),
      checkRun('ok', 'COMPLETED', 'SUCCESS'),
      statusContext('legacy-ci', 'ERROR'),
    ]
    assert.deepEqual(checksFrom(rollup), { state: 'failing', failing: ['checks', 'timeout', 'legacy-ci'] })
  })

  it('refuses to call an empty rollup green: no checks is pending, not passing', () => {
    assert.deepEqual(checksFrom([]), { state: 'pending', failing: [] })
    assert.deepEqual(checksFrom(undefined), { state: 'pending', failing: [] })
    assert.deepEqual(checksFrom(null), { state: 'pending', failing: [] })
  })
})

describe('reviewFrom: §10’s "a clean review"', () => {
  it('takes the decision as the state, and the last approval as the reviewer', () => {
    const reviews = [
      { state: 'APPROVED', author: { login: 'first' } },
      { state: 'COMMENTED', author: { login: 'chatty' } },
      { state: 'APPROVED', author: { login: 'second' } },
    ]
    assert.deepEqual(reviewFrom('APPROVED', reviews), { state: 'approved', reviewer: 'second' })
  })

  it('is pending for every spelling of "not yet" gh uses, including an empty decision', () => {
    for (const decision of ['', 'REVIEW_REQUIRED', null, undefined, 'WHATEVER']) {
      assert.deepEqual(reviewFrom(decision, []), { state: 'pending' })
    }
  })

  it('reports a requested change as one', () => {
    assert.deepEqual(reviewFrom('CHANGES_REQUESTED', []), { state: 'changes_requested' })
  })

  it('approves without inventing a reviewer when no review names one', () => {
    assert.deepEqual(reviewFrom('APPROVED', []), { state: 'approved' })
  })
})

describe('footersFrom: the two fields gh cannot know', () => {
  it('reads a Work id and a stacked parent out of the body', () => {
    const body = 'the work\n\nFleet-Work: wrk_0123456789abcdef\nFleet-Stack-Parent: someone/other#12\n'
    assert.deepEqual(footersFrom(body, where), {
      workId: 'wrk_0123456789abcdef',
      stackParent: { repo: 'someone/other', number: 12 },
    })
  })

  it('reads a bare `#12` as a parent in the same repo', () => {
    assert.deepEqual(footersFrom('Fleet-Stack-Parent: #12', where), { stackParent: { repo: where, number: 12 } })
  })

  it('ignores a footer a human mistyped, because a body is free text', () => {
    assert.deepEqual(footersFrom('Fleet-Work: not-an-id\nFleet-Stack-Parent: somewhere#zero', where), {})
    assert.deepEqual(footersFrom(undefined, where), {})
  })

  it('refuses a nested footer, so a body cannot name a host through the stack pin', () => {
    // `gh -R` reads three segments as HOST/OWNER/REPO. A stranger who can edit a PR body would otherwise choose
    // the host the gate's next `get` talks to, so a nested footer is not a footer at all.
    assert.deepEqual(footersFrom('Fleet-Stack-Parent: evil.example/someone/other#12', where), {})
    assert.deepEqual(footersFrom('Fleet-Stack-Parent: ./someone#12', where), {})
  })
})

describe('pullRequestFrom: one row as the contract’s PR', () => {
  it('maps every field the gate reads, all from one call', () => {
    const pr = pullRequestFrom(prJson(), where)
    assert.equal(pr.repo, where)
    assert.equal(pr.number, 7)
    assert.equal(pr.base, 'main')
    assert.equal(pr.head, 'feat')
    assert.equal(pr.headSha, 'abc1234')
    assert.equal(pr.checks, 'passing')
    assert.deepEqual(pr.failingChecks, [])
    assert.equal(pr.review, 'approved')
    assert.equal(pr.merged, false)
    assert.equal(pr.workId, 'wrk_0123456789abcdef')
    assert.equal(pr.createdAt, '2026-11-01T00:00:00.000Z')
  })

  it('carries the failing check names, so a nudge can cite them', () => {
    const pr = pullRequestFrom(prJson({ statusCheckRollup: [checkRun('checks', 'COMPLETED', 'FAILURE')] }), where)
    assert.equal(pr.checks, 'failing')
    assert.deepEqual(pr.failingChecks, ['checks'])
  })

  it('is merged when gh reports a merge time', () => {
    assert.equal(pullRequestFrom(prJson({ mergedAt: '2026-11-03T00:00:00.000Z' }), where).merged, true)
  })

  it('refuses a row it does not model rather than guessing a head sha', () => {
    assert.throws(() => pullRequestFrom(prJson({ headRefOid: 'not-a-sha' }), where), {
      code: 'external_failed',
      message: /unusable headRefOid/,
    })
    assert.throws(() => pullRequestFrom(prJson({ number: 'seven' }), where), /no number/)
    assert.throws(() => pullRequestFrom(prJson({ baseRefName: '' }), where), /no baseRefName/)
    assert.throws(() => pullRequestFrom('a string', where), /not an object/)
  })
})

describe('gradedChecksFrom: the verdict travels with the sha it graded (§10)', () => {
  it('returns the sha and the verdict from the same call', () => {
    const graded = gradedChecksFrom({ headRefOid: 'abc1234', statusCheckRollup: [checkRun('checks', 'COMPLETED', 'SUCCESS')] })
    assert.deepEqual(graded, { state: 'passing', failing: [], headSha: 'abc1234' })
  })
})

describe('createdFrom and mergeShaFrom: the two writes that report something back', () => {
  it('reads the number out of the URL gh prints', () => {
    assert.deepEqual(createdFrom('https://github.com/mohammadchehab/tmux-fleet/pull/63\n', where), { repo: where, number: 63 })
  })

  it('refuses a create that printed no URL', () => {
    assert.throws(() => createdFrom('', where), { code: 'external_failed', message: /no pull request URL/ })
  })

  it('reads a merge commit, and says nothing when there is not one', () => {
    assert.equal(mergeShaFrom({ mergeCommit: { oid: 'def5678' } }), 'def5678')
    assert.equal(mergeShaFrom({ mergeCommit: null }), undefined)
    assert.equal(mergeShaFrom({ mergeCommit: { oid: 'nope' } }), undefined)
  })
})
