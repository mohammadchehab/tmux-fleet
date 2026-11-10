/**
 * The `PullRequests` port over `glab` (§10): which argv each call runs, what a
 * non-zero exit means, and the two places this adapter differs from the GitHub
 * one — a refused merge is re-read rather than matched on prose, and `--auto-merge`
 * waits for the pipeline instead of refusing.
 *
 * The runner is a fake that records argv and answers from a table, so nothing
 * here authenticates or shells out; `createGlab` is still the real wrapper, so the
 * JSON decoding and the error mapping under test are the ones that ship.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parse, repo, type Sha } from '@fleet/foundation-core'
import { createGlab, type GlabRunner } from '../src/glab.ts'
import { createGitLabPullRequests } from '../src/pull-requests.ts'

const where = parse(repo(), 'backbase/fleet')
const project = 'projects/backbase%2Ffleet'

interface Reply {
  readonly code?: number
  readonly stdout?: string
  readonly stderr?: string
}

/** A `glab` that records every argv and answers from `reply`, which may depend on the argv. */
const fakeGlab = (reply: (args: readonly string[]) => Reply = () => ({})) => {
  const calls: string[][] = []
  const runner: GlabRunner = async (args) => {
    calls.push([...args])
    const answer = reply(args)
    return { code: answer.code ?? 0, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' }
  }
  return { calls, glab: createGlab({ runner }) }
}

const pipeline = (id: number, status: string) => ({ id, status, sha: 'abc1234' })

const mrJson = (overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> => ({
  iid: 7,
  title: 'Add pagination',
  description: '',
  state: 'opened',
  source_branch: 'feat',
  target_branch: 'main',
  sha: 'abc1234',
  merged_at: null,
  created_at: '2026-11-01T00:00:00.000Z',
  updated_at: '2026-11-02T00:00:00.000Z',
  ...overrides,
})

const json = (value: unknown, code = 0): Reply => ({ code, stdout: JSON.stringify(value) })

describe('list and searchIntent', () => {
  it('asks GitLab for open merge requests, one page of them', async () => {
    const fake = fakeGlab(() => json([mrJson(), mrJson({ iid: 8, target_branch: 'feat', source_branch: 'feat-2' })]))
    const prs = await createGitLabPullRequests({ glab: fake.glab }).list(where)

    assert.equal(fake.calls.length, 1)
    assert.deepEqual(fake.calls[0], ['api', `${project}/merge_requests?state=opened&per_page=100`])
    assert.deepEqual(
      prs.map((pr) => pr.number),
      [7, 8],
    )
  })

  it('spells the states GitLab’s way and clamps the page to its ceiling', async () => {
    const fake = fakeGlab(() => json([]))
    const port = createGitLabPullRequests({ glab: fake.glab, limit: 500 })

    await port.list(where, { state: 'all' })
    await port.list(where, { state: 'closed' })

    assert.deepEqual(fake.calls[0], ['api', `${project}/merge_requests?state=all&per_page=100`])
    assert.deepEqual(fake.calls[1], ['api', `${project}/merge_requests?state=closed&per_page=100`])
  })

  it('hands the search text to GitLab, and does not search on whitespace', async () => {
    const fake = fakeGlab(() => json([]))
    const port = createGitLabPullRequests({ glab: fake.glab })

    await port.searchIntent(where, '  add   pagination ')
    await port.searchIntent(where, '   ')

    assert.deepEqual(fake.calls[0], [
      'api',
      `${project}/merge_requests?state=opened&per_page=100&search=add%20pagination`,
    ])
    assert.equal(fake.calls.length, 1)
  })
})

describe('a nested GitLab namespace', () => {
  const nested = parse(repo(), 'backbase/fleet/services')

  it('encodes the whole path as GitLab’s one project segment', async () => {
    const fake = fakeGlab(() => json([mrJson()]))
    const prs = await createGitLabPullRequests({ glab: fake.glab }).list(nested)

    assert.deepEqual(fake.calls[0], [
      'api',
      'projects/backbase%2Ffleet%2Fservices/merge_requests?state=opened&per_page=100',
    ])
    assert.deepEqual(
      prs.map((pr) => pr.repo),
      [nested],
    )
  })

  it('hands the nested path to `glab mr` as the project it is', async () => {
    const fake = fakeGlab(() => ({}))
    await createGitLabPullRequests({ glab: fake.glab }).retarget(nested, 7, 'main')
    assert.deepEqual(fake.calls[0], ['mr', 'update', '7', '-R', 'backbase/fleet/services', '--target-branch', 'main', '--yes'])
  })

  it('reads a stack parent that nests too — `group/sub/repo#12` is one footer', async () => {
    const fake = fakeGlab((args) =>
      args[1]?.endsWith('/pipelines') === true
        ? json([])
        : json(mrJson({ description: 'Why.\n\nFleet-Stack-Parent: backbase/fleet/core#3' })),
    )
    const pr = await createGitLabPullRequests({ glab: fake.glab }).get(nested, 7)

    assert.equal(String(pr?.stackParent?.repo), 'backbase/fleet/core')
    assert.equal(pr?.stackParent?.number, 3)
  })
})

describe('get: a missing merge request is an answer, a failed call is not', () => {
  it('reads the merge request and the pipelines it ran', async () => {
    const fake = fakeGlab((args) =>
      args[1]?.endsWith('/pipelines') === true ? json([pipeline(1, 'success')]) : json(mrJson()),
    )
    const pr = await createGitLabPullRequests({ glab: fake.glab }).get(where, 7)

    assert.deepEqual(fake.calls[0], ['api', `${project}/merge_requests/7`])
    assert.deepEqual(fake.calls[1], ['api', `${project}/merge_requests/7/pipelines`])
    assert.equal(pr?.number, 7)
    assert.equal(pr?.checks, 'passing')
    assert.equal(pr?.headSha, 'abc1234')
    // The API answers with the whole merge request, so the state rides along — which is
    // what makes `get` §9's only way to learn a PR closed (§3 has no `pr.closed`).
    assert.equal(pr?.state, 'open', 'GitLab says `opened`; the contract says `open`')
  })

  it('is undefined when GitLab says the merge request is not there', async () => {
    const fake = fakeGlab(() => ({ code: 1, stderr: 'glab: 404 Not Found' }))
    assert.equal(await createGitLabPullRequests({ glab: fake.glab }).get(where, 7), undefined)
  })

  it('throws for anything else, so a network failure never reads as a closed merge request', async () => {
    const fake = fakeGlab(() => ({ code: 1, stderr: 'dial tcp: no such host' }))
    await assert.rejects(createGitLabPullRequests({ glab: fake.glab }).get(where, 7), {
      code: 'external_failed',
      message: /merge_requests\/7 exited 1: dial tcp/,
    })
  })

  it('throws when glab exits zero with something that is not JSON', async () => {
    const fake = fakeGlab(() => ({ stdout: 'not json' }))
    await assert.rejects(createGitLabPullRequests({ glab: fake.glab }).get(where, 7), /printed no JSON/)
  })

  it('still answers when the pipeline read fails: the merge request is real, its checks are pending', async () => {
    const fake = fakeGlab((args) => (args[1]?.endsWith('/pipelines') === true ? { code: 1, stderr: 'boom' } : json(mrJson())))
    const pr = await createGitLabPullRequests({ glab: fake.glab }).get(where, 7)
    assert.equal(pr?.checks, 'pending')
  })
})

describe('create', () => {
  it('always passes a description and --yes, because there is no TTY to prompt on', async () => {
    const fake = fakeGlab(() => ({ stdout: 'https://gitlab.example/backbase/fleet/-/merge_requests/64\n' }))
    const created = await createGitLabPullRequests({ glab: fake.glab }).create({
      repo: where,
      base: 'main',
      head: 'feat',
      title: 'Add pagination',
    })

    assert.deepEqual(fake.calls[0], [
      'mr',
      'create',
      '-R',
      'backbase/fleet',
      '--source-branch',
      'feat',
      '--target-branch',
      'main',
      '--title',
      'Add pagination',
      '--description',
      '',
      '--yes',
    ])
    assert.deepEqual(created, { repo: where, number: 64 })
  })

  it('carries a body when one is given, and fails loudly when glab refuses', async () => {
    const ok = fakeGlab(() => ({ stdout: '!9' }))
    await createGitLabPullRequests({ glab: ok.glab }).create({ repo: where, base: 'main', head: 'feat', title: 't', body: 'why' })
    assert.equal(ok.calls[0]?.at(-2), 'why')

    const refused = fakeGlab(() => ({ code: 1, stderr: 'a merge request for branch "feat" already exists' }))
    await assert.rejects(
      createGitLabPullRequests({ glab: refused.glab }).create({ repo: where, base: 'main', head: 'feat', title: 't' }),
      { code: 'external_failed', message: /glab mr create exited 1: a merge request/ },
    )
  })
})

describe('checks and review: the two reads §10 makes on their own', () => {
  it('returns the sha it graded, not just the verdict', async () => {
    const fake = fakeGlab((args) =>
      args[1]?.endsWith('/pipelines') === true ? json([pipeline(3, 'failed')]) : json(mrJson()),
    )
    const graded = await createGitLabPullRequests({ glab: fake.glab }).checks(where, 7)
    assert.deepEqual(graded, { state: 'failing', failing: ['pipeline 3'], headSha: 'abc1234' })
  })

  it('refuses to grade a merge request it cannot read', async () => {
    const fake = fakeGlab(() => ({ code: 1, stderr: '404 Not Found' }))
    await assert.rejects(createGitLabPullRequests({ glab: fake.glab }).checks(where, 7), { code: 'not_found' })
  })

  it('reports the approvals as the review', async () => {
    const fake = fakeGlab(() => json({ approved: true, approved_by: [{ user: { username: 'reviewer-1' } }] }))
    assert.deepEqual(await createGitLabPullRequests({ glab: fake.glab }).review(where, 7), {
      state: 'approved',
      reviewer: 'reviewer-1',
    })
    assert.deepEqual(fake.calls[0], ['api', `${project}/merge_requests/7/approvals`])
  })
})

describe('retarget and dependents: the stack (§10)', () => {
  it('moves a merge request onto a new target branch with one `mr update`', async () => {
    const fake = fakeGlab(() => ({}))
    await createGitLabPullRequests({ glab: fake.glab }).retarget(where, 7, 'main')
    assert.deepEqual(fake.calls[0], ['mr', 'update', '7', '-R', 'backbase/fleet', '--target-branch', 'main', '--yes'])
  })

  it('asks GitLab for open merge requests targeting this one’s source branch', async () => {
    const fake = fakeGlab((args) => {
      if (args[1]?.includes('target_branch=') === true) {
        return json([
          mrJson(),
          mrJson({ iid: 8, target_branch: 'feat', source_branch: 'feat-2' }),
          mrJson({ iid: 9, target_branch: 'main', source_branch: 'unrelated' }),
          mrJson({ iid: 10, target_branch: 'feat', source_branch: 'feat-3', state: 'merged' }),
        ])
      }
      if (args[1]?.endsWith('/pipelines') === true) return json([])
      return json(mrJson())
    })

    const dependents = await createGitLabPullRequests({ glab: fake.glab }).dependents(where, 7)
    assert.deepEqual(dependents, [{ repo: where, number: 8 }])
    // The parent, its pipelines, then the filtered list: the branch is what defines the stack.
    assert.equal(fake.calls.length, 3)
    assert.ok(fake.calls[2]?.[1]?.includes('target_branch=feat'))
  })

  it('has no dependents when there is no parent to read', async () => {
    const fake = fakeGlab(() => ({ code: 1, stderr: '404 Not Found' }))
    assert.deepEqual(await createGitLabPullRequests({ glab: fake.glab }).dependents(where, 7), [])
    assert.equal(fake.calls.length, 1)
  })
})

describe('merge', () => {
  const head = 'abc1234' as Sha

  it('pins the head sha on GitLab’s side too, and reports the merge commit when there is one', async () => {
    const fake = fakeGlab((args) =>
      args[1] === 'merge' ? {} : json(mrJson({ merge_commit_sha: 'def5678', state: 'merged' })),
    )
    const merged = await createGitLabPullRequests({ glab: fake.glab }).merge(where, 7, {
      method: 'squash',
      deleteBranch: false,
      headSha: head,
    })

    // §10's pin as a flag: a head that moved makes GitLab refuse, rather than merging a commit nobody checked.
    assert.deepEqual(fake.calls[0], [
      'mr',
      'merge',
      '7',
      '-R',
      'backbase/fleet',
      '--sha',
      'abc1234',
      '--squash',
      '--yes',
    ])
    assert.deepEqual(merged, { mergeSha: 'def5678' })
  })

  it('passes no method flag for a merge commit, because that is GitLab’s default', async () => {
    const fake = fakeGlab((args) => (args[1] === 'merge' ? {} : json(mrJson())))
    await createGitLabPullRequests({ glab: fake.glab }).merge(where, 7, { method: 'merge', deleteBranch: false, headSha: head })
    assert.ok(!fake.calls[0]?.includes('--squash'))
    assert.deepEqual(fake.calls[0]?.slice(-3), ['--sha', 'abc1234', '--yes'])
  })

  it('removes the source branch only when asked — §10 is the caller that decides', async () => {
    const fake = fakeGlab((args) => (args[1] === 'merge' ? {} : json(mrJson())))
    await createGitLabPullRequests({ glab: fake.glab }).merge(where, 7, { method: 'merge', deleteBranch: true, headSha: head })
    assert.deepEqual(fake.calls[0]?.slice(5), ['--sha', 'abc1234', '--remove-source-branch', '--yes'])
  })

  it('asks GitLab to wait for the pipeline when the caller says auto', async () => {
    const fake = fakeGlab((args) => (args[1] === 'merge' ? {} : json(mrJson())))
    await createGitLabPullRequests({ glab: fake.glab }).merge(where, 7, {
      method: 'squash',
      deleteBranch: false,
      headSha: head,
      auto: true,
    })
    assert.deepEqual(fake.calls[0]?.slice(5), ['--sha', 'abc1234', '--squash', '--auto-merge', '--yes'])
  })

  it('is a merge even when the merge commit cannot be read afterwards', async () => {
    const fake = fakeGlab((args) => (args[1] === 'merge' ? {} : { code: 1, stderr: 'rate limited' }))
    assert.deepEqual(
      await createGitLabPullRequests({ glab: fake.glab }).merge(where, 7, { method: 'rebase', deleteBranch: false, headSha: head }),
      {},
    )
  })

  it('reports a refusal as head_moved when the head really did move, whatever glab printed', async () => {
    const fake = fakeGlab((args) =>
      args[1] === 'merge' ? { code: 1, stderr: 'something we have never seen' } : json(mrJson({ sha: 'fff9999' })),
    )
    await assert.rejects(
      createGitLabPullRequests({ glab: fake.glab }).merge(where, 7, { method: 'squash', deleteBranch: false, headSha: head }),
      { code: 'head_moved', message: /moved off abc1234 before the merge; nothing was merged/ },
    )
  })

  it('does not call a refusal head_moved when the head is still where we pinned it', async () => {
    const fake = fakeGlab((args) =>
      args[1] === 'merge' ? { code: 1, stderr: 'branch cannot be merged' } : json(mrJson()),
    )
    await assert.rejects(
      createGitLabPullRequests({ glab: fake.glab }).merge(where, 7, { method: 'squash', deleteBranch: false, headSha: head }),
      { code: 'external_failed', message: /glab mr merge 7 exited 1: branch cannot be merged/ },
    )
  })

  it('falls back to glab’s wording only when the re-read itself fails', async () => {
    const fake = fakeGlab((args) =>
      args[1] === 'merge' ? { code: 1, stderr: 'the SHA of the source branch changed' } : { code: 1, stderr: 'dial tcp: no such host' },
    )
    await assert.rejects(
      createGitLabPullRequests({ glab: fake.glab }).merge(where, 7, { method: 'squash', deleteBranch: false, headSha: head }),
      { code: 'head_moved' },
    )
  })
})

describe('branches and deleteBranch: §10 keeps the delete, the gate does not (§6)', () => {
  const head = 'abc1234' as Sha

  it('lists the branches with the commit each points at', async () => {
    const fake = fakeGlab(() => json([{ name: 'feat', commit: { id: 'abc1234' } }, { name: 'fleet/work-1', commit: { id: 'def5678' } }]))
    const branches = await createGitLabPullRequests({ glab: fake.glab }).branches(where)

    assert.deepEqual(branches, [
      { name: 'feat', sha: 'abc1234' },
      { name: 'fleet/work-1', sha: 'def5678' },
    ])
    assert.deepEqual(fake.calls[0], ['api', `${project}/repository/branches?per_page=100`])
  })

  it('asks the project what its trunk is, instead of assuming `main`', async () => {
    const fake = fakeGlab(() => json({ id: 7, default_branch: 'develop' }))
    const trunk = await createGitLabPullRequests({ glab: fake.glab }).defaultBranch(where)

    assert.equal(trunk, 'develop')
    assert.deepEqual(fake.calls[0], ['api', project])
  })

  it('refuses a project that reports no trunk rather than falling back to a guess', async () => {
    const fake = fakeGlab(() => json({ id: 7 }))
    await assert.rejects(createGitLabPullRequests({ glab: fake.glab }).defaultBranch(where), {
      code: 'external_failed',
      message: /reports no default branch/,
    })
  })

  it('reads the branch, then deletes it', async () => {
    const fake = fakeGlab((args) => (args.includes('DELETE') ? {} : json({ name: 'feat', commit: { id: 'abc1234' } })))
    await createGitLabPullRequests({ glab: fake.glab }).deleteBranch(where, 'feat', head)

    assert.deepEqual(fake.calls[0], ['api', `${project}/repository/branches/feat`])
    assert.deepEqual(fake.calls[1], ['api', `${project}/repository/branches/feat`, '-X', 'DELETE'])
  })

  it('encodes a branch name with a slash, so `fleet/work-1` is one path segment', async () => {
    const fake = fakeGlab(() => json({ commit: { id: 'abc1234' } }))
    await createGitLabPullRequests({ glab: fake.glab }).deleteBranch(where, 'fleet/work-1', head)
    assert.deepEqual(fake.calls[0], ['api', `${project}/repository/branches/fleet%2Fwork-1`])
  })

  it('refuses with `head_moved` when the branch moved, and deletes nothing', async () => {
    const fake = fakeGlab(() => json({ commit: { id: 'def5678' } }))
    await assert.rejects(createGitLabPullRequests({ glab: fake.glab }).deleteBranch(where, 'feat', head), {
      code: 'head_moved',
      message: /points at def5678, not abc1234; nothing was deleted/,
    })
    assert.equal(fake.calls.length, 1)
  })

  it('reports a branch that is already gone as `not_found`', async () => {
    const fake = fakeGlab(() => ({ code: 1, stderr: '404 Branch Not Found' }))
    await assert.rejects(createGitLabPullRequests({ glab: fake.glab }).deleteBranch(where, 'feat', head), {
      code: 'not_found',
    })
  })
})
