import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { pullRequestUrl } from '../src/forge.ts'

describe('pullRequestUrl', () => {
  it('defaults to github.com', () => {
    assert.equal(pullRequestUrl(undefined, 'acme/widgets', 7), 'https://github.com/acme/widgets/pull/7')
    assert.equal(pullRequestUrl({ kind: 'github' }, 'acme/widgets', 7), 'https://github.com/acme/widgets/pull/7')
  })
  it('honours a GitHub Enterprise host', () => {
    assert.equal(
      pullRequestUrl({ kind: 'github', host: 'ghe.example' }, 'acme/widgets', 7),
      'https://ghe.example/acme/widgets/pull/7',
    )
  })
  it('builds a GitLab merge request url, on gitlab.com by default', () => {
    assert.equal(pullRequestUrl({ kind: 'gitlab' }, 'acme/widgets', 7), 'https://gitlab.com/acme/widgets/-/merge_requests/7')
  })
  it('keeps a subgroup repo whole on a self-hosted GitLab', () => {
    assert.equal(
      pullRequestUrl({ kind: 'gitlab', host: 'git.example' }, 'group/sub/project', 12),
      'https://git.example/group/sub/project/-/merge_requests/12',
    )
  })
})
