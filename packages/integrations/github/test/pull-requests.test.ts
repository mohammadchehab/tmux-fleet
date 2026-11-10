/**
 * The `PullRequests` port over `gh` (§10): which argv each call runs, what a
 * non-zero exit means, and the one place the two differ — `get` reports a
 * missing PR as `undefined` while every other failure throws.
 *
 * The runner is a fake that records argv and answers from a table, so nothing
 * here authenticates or shells out; `createGh` is still the real wrapper, so the
 * JSON decoding and the error mapping under test are the ones that ship.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parse, repo, type Sha } from '@fleet/foundation-core'
import { createGh, type GhRunner } from '../src/gh.ts'
import { createGitHubPullRequests } from '../src/pull-requests.ts'

const where = parse(repo(), 'mohammadchehab/tmux-fleet')

interface Reply {
  readonly code?: number
  readonly stdout?: string
  readonly stderr?: string
}

/** A `gh` that records every argv and answers from `reply`, which may depend on the argv. */
const fakeGh = (reply: (args: readonly string[]) => Reply = () => ({})) => {
  const calls: string[][] = []
  const runner: GhRunner = async (args) => {
    calls.push([...args])
    const answer = reply(args)
    return { code: answer.code ?? 0, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' }
  }
  return { calls, gh: createGh(runner) }
}

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
  body: '',
  ...overrides,
})

const json = (value: unknown, code = 0): Reply => ({ code, stdout: JSON.stringify(value) })

/** The argv with the long `--json` field list collapsed, so an assertion reads as the call a human would type. */
const readable = (args: readonly string[]): string =>
  args
    .map((arg) => (arg.includes(',') ? '<fields>' : arg))
    .join(' ')

describe('list and searchIntent', () => {
  it('asks for open PRs by default, with the fields a PullRequest needs', async () => {
    const fake = fakeGh(() => json([prJson(), prJson({ number: 8, baseRefName: 'feat', headRefName: 'feat-2' })]))
    const prs = await createGitHubPullRequests({ gh: fake.gh }).list(where)

    assert.equal(fake.calls.length, 1)
    assert.equal(readable(fake.calls[0] ?? []), 'pr list -R mohammadchehab/tmux-fleet --state open --limit 200 --json <fields>')
    assert.deepEqual(
      prs.map((pr) => pr.number),
      [7, 8],
    )
    assert.deepEqual(
      prs.map((pr) => pr.repo),
      [where, where],
    )
  })

  it('refuses a nested namespace instead of letting `gh -R` read it as HOST/OWNER/REPO', async () => {
    // `gh -R` treats three segments as a host selector, so a nested `Repo` here would decide which host the
    // daemon talks to — and a PR body's footer can write one. GitHub has no subgroups: refused, and `gh` never runs.
    const fake = fakeGh(() => json([]))
    const nested = parse(repo(), 'backbase/fleet/services')
    await assert.rejects(createGitHubPullRequests({ gh: fake.gh }).list(nested), {
      code: 'invalid_input',
      message: /HOST\/OWNER\/REPO/,
    })
    assert.equal(fake.calls.length, 0)
  })

  it('passes the state through, and the search text to gh’s own search', async () => {
    const fake = fakeGh(() => json([]))
    const port = createGitHubPullRequests({ gh: fake.gh, limit: 5 })

    await port.list(where, { state: 'all' })
    await port.searchIntent(where, '  add   pagination ')
    await port.searchIntent(where, '   ')

    assert.equal(readable(fake.calls[0] ?? []), 'pr list -R mohammadchehab/tmux-fleet --state all --limit 5 --json <fields>')
    assert.equal(
      readable(fake.calls[1] ?? []),
      'pr list -R mohammadchehab/tmux-fleet --state open --search add pagination --limit 5 --json <fields>',
    )
    // Whitespace is not an intent: no call at all rather than a search that matches everything.
    assert.equal(fake.calls.length, 2)
  })
})

describe('get: a missing PR is an answer, a failed call is not', () => {
  it('reads one PR', async () => {
    const fake = fakeGh(() => json(prJson()))
    const pr = await createGitHubPullRequests({ gh: fake.gh }).get(where, 7)
    assert.equal(readable(fake.calls[0] ?? []), 'pr view 7 -R mohammadchehab/tmux-fleet --json <fields>')
    assert.equal(pr?.number, 7)
    assert.equal(pr?.headSha, 'abc1234')
  })

  it('is undefined when gh says the PR is not there', async () => {
    const fake = fakeGh(() => ({ code: 1, stderr: 'no pull requests found for branch "feat"' }))
    assert.equal(await createGitHubPullRequests({ gh: fake.gh }).get(where, 7), undefined)
  })

  it('throws for anything else, so a network failure never reads as a closed PR', async () => {
    const fake = fakeGh(() => ({ code: 4, stderr: 'dial tcp: no such host' }))
    await assert.rejects(createGitHubPullRequests({ gh: fake.gh }).get(where, 7), {
      code: 'external_failed',
      message: /gh pr view 7 exited 4: dial tcp/,
    })
  })

  it('throws when gh exits zero with something that is not JSON', async () => {
    const fake = fakeGh(() => ({ stdout: 'not json' }))
    await assert.rejects(createGitHubPullRequests({ gh: fake.gh }).get(where, 7), /printed no JSON/)
  })
})

describe('create', () => {
  it('always passes a body, because there is no TTY to prompt on', async () => {
    const fake = fakeGh(() => ({ stdout: 'https://github.com/mohammadchehab/tmux-fleet/pull/64\n' }))
    const created = await createGitHubPullRequests({ gh: fake.gh }).create({
      repo: where,
      base: 'main',
      head: 'feat',
      title: 'Add pagination',
    })

    assert.deepEqual(fake.calls[0], [
      'pr',
      'create',
      '-R',
      'mohammadchehab/tmux-fleet',
      '--base',
      'main',
      '--head',
      'feat',
      '--title',
      'Add pagination',
      '--body',
      '',
    ])
    assert.deepEqual(created, { repo: where, number: 64 })
  })

  it('carries a body when one is given, and fails loudly when gh refuses', async () => {
    const ok = fakeGh(() => ({ stdout: 'https://github.com/o/r/pull/9' }))
    await createGitHubPullRequests({ gh: ok.gh }).create({ repo: where, base: 'main', head: 'feat', title: 't', body: 'why' })
    assert.equal(ok.calls[0]?.at(-1), 'why')

    const refused = fakeGh(() => ({ code: 1, stderr: 'a pull request for branch "feat" already exists' }))
    await assert.rejects(
      createGitHubPullRequests({ gh: refused.gh }).create({ repo: where, base: 'main', head: 'feat', title: 't' }),
      { code: 'external_failed', message: /gh pr create exited 1: a pull request/ },
    )
  })
})

describe('checks and review: the two reads §10 makes on their own', () => {
  it('returns the sha it graded, not just the verdict', async () => {
    const fake = fakeGh(() =>
      json({ headRefOid: 'abc1234', statusCheckRollup: [{ __typename: 'CheckRun', name: 'checks', status: 'COMPLETED', conclusion: 'FAILURE' }] }),
    )
    const graded = await createGitHubPullRequests({ gh: fake.gh }).checks(where, 7)
    assert.deepEqual(fake.calls[0]?.slice(5), ['--json', 'headRefOid,statusCheckRollup'])
    assert.deepEqual(graded, { state: 'failing', failing: ['checks'], headSha: 'abc1234' })
  })

  it('reports the review decision and who approved', async () => {
    const fake = fakeGh(() => json(prJson()))
    assert.deepEqual(await createGitHubPullRequests({ gh: fake.gh }).review(where, 7), { state: 'approved', reviewer: 'reviewer-1' })
  })
})

describe('retarget and dependents: the stack (§10)', () => {
  it('moves a PR onto a new base with one `pr edit`', async () => {
    const fake = fakeGh(() => ({}))
    await createGitHubPullRequests({ gh: fake.gh }).retarget(where, 7, 'main')
    assert.deepEqual(fake.calls[0], ['pr', 'edit', '7', '-R', 'mohammadchehab/tmux-fleet', '--base', 'main'])
  })

  it('finds dependents by base branch: every open PR sitting on this one’s head', async () => {
    const fake = fakeGh((args) => {
      if (args[1] === 'view') return json(prJson())
      return json([
        prJson(),
        prJson({ number: 8, baseRefName: 'feat', headRefName: 'feat-2' }),
        prJson({ number: 9, baseRefName: 'main', headRefName: 'unrelated' }),
        prJson({ number: 10, baseRefName: 'feat', headRefName: 'feat-3', mergedAt: '2026-11-03T00:00:00.000Z' }),
      ])
    })

    const dependents = await createGitHubPullRequests({ gh: fake.gh }).dependents(where, 7)
    assert.deepEqual(dependents, [{ repo: where, number: 8 }])
    // The parent is read once, then the open list: the branch is what defines the stack.
    assert.equal(fake.calls.length, 2)
  })

  it('has no dependents when there is no parent to read', async () => {
    const fake = fakeGh(() => ({ code: 1, stderr: 'no pull requests found' }))
    assert.deepEqual(await createGitHubPullRequests({ gh: fake.gh }).dependents(where, 7), [])
    assert.equal(fake.calls.length, 1)
  })
})

describe('merge', () => {
  const head = 'abc1234' as Sha

  it('pins the head sha on gh’s side too, and reports the merge commit when gh has one', async () => {
    const fake = fakeGh((args) =>
      args[1] === 'merge' ? {} : json({ number: 7, mergeCommit: { oid: 'def5678' }, headRefName: 'feat', baseRefName: 'main', headRefOid: 'abc1234', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z', statusCheckRollup: [], latestReviews: [] }),
    )
    const merged = await createGitHubPullRequests({ gh: fake.gh }).merge(where, 7, {
      method: 'squash',
      deleteBranch: false,
      headSha: head,
    })

    // §10's pin as a flag: a head that moved makes `gh` refuse, rather than merging a commit nobody checked.
    assert.deepEqual(fake.calls[0], [
      'pr',
      'merge',
      '7',
      '-R',
      'mohammadchehab/tmux-fleet',
      '--squash',
      '--match-head-commit',
      'abc1234',
    ])
    assert.deepEqual(merged, { mergeSha: 'def5678' })
  })

  it('deletes the branch only when asked — §10 is the caller that decides', async () => {
    const fake = fakeGh(() => json({ mergeCommit: null }))
    await createGitHubPullRequests({ gh: fake.gh }).merge(where, 7, { method: 'merge', deleteBranch: true, headSha: head })
    assert.deepEqual(fake.calls[0]?.slice(-3), ['--match-head-commit', 'abc1234', '--delete-branch'])
  })

  it('is a merge even when the merge commit cannot be read afterwards', async () => {
    const fake = fakeGh((args) => (args[1] === 'merge' ? {} : { code: 1, stderr: 'rate limited' }))
    assert.deepEqual(
      await createGitHubPullRequests({ gh: fake.gh }).merge(where, 7, { method: 'rebase', deleteBranch: false, headSha: head }),
      {},
    )
  })

  it('throws when gh refuses the merge, so the gate records a failure and not a merge', async () => {
    const fake = fakeGh(() => ({ code: 1, stderr: 'base branch was modified' }))
    await assert.rejects(
      createGitHubPullRequests({ gh: fake.gh }).merge(where, 7, { method: 'squash', deleteBranch: false, headSha: head }),
      { code: 'external_failed', message: /gh pr merge 7 exited 1: base branch was modified/ },
    )
  })

  it('reports a refusal because the head moved as a typed `head_moved`, not a failed call', async () => {
    const fake = fakeGh(() => ({ code: 1, stderr: 'Head branch was modified. Review and try the merge again.' }))
    await assert.rejects(
      createGitHubPullRequests({ gh: fake.gh }).merge(where, 7, { method: 'squash', deleteBranch: false, headSha: head }),
      { code: 'head_moved', message: /moved off abc1234 before the merge; nothing was merged/ },
    )
  })
})
