import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  decisionNotificationKey,
  newDecisionId,
  newSessionId,
  notificationKey,
  parse,
  peerId,
  repo,
  sessionId,
} from '../src/index.ts'

describe('ids', () => {
  test('a minted session id parses with the session schema', () => {
    const id = newSessionId()
    assert.equal(parse(sessionId(), id), id)
  })

  test('a peer id is the stable human name, not an opaque one', () => {
    assert.equal(parse(peerId(), 'engineer-1'), 'engineer-1')
    assert.throws(() => parse(peerId(), 'ses_0123456789abcdef'), /PeerId/)
  })

  test('an opaque id of the wrong kind is rejected', () => {
    assert.throws(() => parse(sessionId(), newDecisionId()), /SessionId/)
  })

  test('repo is owner/name, and a nested GitLab namespace is the same type', () => {
    assert.equal(parse(repo(), 'mohammadchehab/tmux-fleet'), 'mohammadchehab/tmux-fleet')
    assert.equal(parse(repo(), 'backbase/fleet/tmux-fleet'), 'backbase/fleet/tmux-fleet')
    // Deeper than that is still a path, not a repo with a strange owner: GitLab allows it, so the type does too.
    assert.equal(parse(repo(), 'backbase/team/platform/services'), 'backbase/team/platform/services')
  })

  test('a repo has at least two segments, and no empty ones', () => {
    // One segment is a directory name; nothing can clone or address it as a project.
    assert.throws(() => parse(repo(), 'tmux-fleet'), /Repo/)
    assert.throws(() => parse(repo(), 'backbase//tmux-fleet'), /Repo/)
    assert.throws(() => parse(repo(), 'backbase/tmux-fleet/'), /Repo/)
    assert.throws(() => parse(repo(), '/tmux-fleet'), /Repo/)
  })

  test('a dot segment is refused, because a forge would read it as traversal', () => {
    assert.throws(() => parse(repo(), 'backbase/../tmux-fleet'), /Repo/)
    assert.throws(() => parse(repo(), './tmux-fleet'), /Repo/)
    // A name that merely *starts* with a dot is a name: `.github/workflows` is a real repo.
    assert.equal(parse(repo(), '.github/workflows'), '.github/workflows')
  })

  test('a notification key carries its class', () => {
    const key = decisionNotificationKey(newDecisionId())
    assert.equal(parse(notificationKey(), key), key)
    assert.throws(() => parse(notificationKey(), 'nope'), /NotificationKey/)
  })
})
