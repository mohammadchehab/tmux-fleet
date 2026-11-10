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

  test('repo is owner/name', () => {
    assert.equal(parse(repo(), 'mohammadchehab/tmux-fleet'), 'mohammadchehab/tmux-fleet')
    assert.throws(() => parse(repo(), 'tmux-fleet'), /Repo/)
  })

  test('a notification key carries its class', () => {
    const key = decisionNotificationKey(newDecisionId())
    assert.equal(parse(notificationKey(), key), key)
    assert.throws(() => parse(notificationKey(), 'nope'), /NotificationKey/)
  })
})
