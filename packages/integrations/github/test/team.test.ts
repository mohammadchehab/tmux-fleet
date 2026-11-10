/**
 * The `TeamDirectory` port over `gh api` (shared-fleet.md §5.1): which argv it
 * runs, and that a read which fails is a throw — never an empty team.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { FleetError } from '@fleet/foundation-core'
import { createGh, type GhRunner } from '../src/gh.ts'
import { createGitHubTeamDirectory } from '../src/team.ts'

const fakeGh = (reply: (args: readonly string[]) => { code?: number; stdout?: string; stderr?: string }) => {
  const calls: string[][] = []
  const runner: GhRunner = async (args) => {
    calls.push([...args])
    const answer = reply(args)
    return { code: answer.code ?? 0, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' }
  }
  return { calls, gh: createGh(runner) }
}

const rejectsWith = (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (thrown: unknown) => thrown instanceof FleetError && thrown.code === code)

describe('a team’s members', () => {
  it('are read from the authenticated API, every page, sorted and once each', async () => {
    const { calls, gh } = fakeGh(() => ({ stdout: 'zoe\nmohammads_backbase\n\nalice\nzoe\n' }))

    const members = await createGitHubTeamDirectory({ gh }).members('backbase-se/eng-07')

    assert.deepEqual(calls, [['api', '--paginate', 'orgs/backbase-se/teams/eng-07/members', '--jq', '.[].login']])
    assert.deepEqual(members, ['alice', 'mohammads_backbase', 'zoe'])
  })

  it('throw when the team cannot be read, rather than answering nobody', async () => {
    const { gh } = fakeGh(() => ({ code: 1, stderr: 'HTTP 404: Not Found' }))
    await rejectsWith(createGitHubTeamDirectory({ gh }).members('backbase-se/eng-07'), 'external_failed')
  })

  it('refuse a team that is not <org>/<slug>, before running gh', async () => {
    const { calls, gh } = fakeGh(() => ({}))
    const directory = createGitHubTeamDirectory({ gh })
    for (const team of ['eng-07', 'backbase-se/eng-07/x', 'backbase-se/../users', '../x/y']) {
      await rejectsWith(directory.members(team), 'invalid_input')
    }
    assert.deepEqual(calls, [])
  })

  it('throw when gh lists something that is not a login', async () => {
    const { gh } = fakeGh(() => ({ stdout: 'alice\n{"message":"x"}\n' }))
    await rejectsWith(createGitHubTeamDirectory({ gh }).members('backbase-se/eng-07'), 'external_failed')
  })
})

describe('a member’s SSH keys', () => {
  it('are read from the authenticated API, as the forge serves them', async () => {
    const { calls, gh } = fakeGh(() => ({ stdout: 'ssh-ed25519 AAAA1\nssh-rsa AAAA2\n' }))

    const keys = await createGitHubTeamDirectory({ gh }).sshKeys('mohammads_backbase')

    assert.deepEqual(calls, [['api', '--paginate', 'users/mohammads_backbase/keys', '--jq', '.[].key']])
    assert.deepEqual(keys, ['ssh-ed25519 AAAA1', 'ssh-rsa AAAA2'])
  })

  it('refuse a login that could reach another path', async () => {
    const { calls, gh } = fakeGh(() => ({}))
    await rejectsWith(createGitHubTeamDirectory({ gh }).sshKeys('../orgs/x'), 'invalid_input')
    assert.deepEqual(calls, [])
  })
})
