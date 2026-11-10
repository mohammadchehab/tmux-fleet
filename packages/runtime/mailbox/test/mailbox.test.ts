/**
 * The Mailbox's contract (§7): stable peer ids, typed messages stored as
 * events, at-least-once delivery with ack, and no path that can hold a message.
 * Every assertion here is either an event in the store or an error code — the
 * two things a supervisor or a CLI can act on.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fixedClock, peerActor, type FleetError, type MessageId, type PeerId, type Result } from '@fleet/foundation-core'
import type { Mailbox, Message } from '@fleet/foundation-contracts'
import { createMailbox } from '../src/mailbox.ts'
import { fakeBriefs, fakeSessions, fakeStore, noSession, resumeFailed } from './support/fakes.ts'

const peer = (id: string): PeerId => id as PeerId
const architect = peer('architect')
const engineer = peer('engineer-1')
const at = fixedClock('2026-11-10T09:00:00.000Z')

const setup = (briefs: Readonly<Record<string, number>> = {}) => {
  const store = fakeStore()
  const sessions = fakeSessions()
  const versions = fakeBriefs(briefs)
  const mailbox = createMailbox({ store, sessions, briefs: versions, clock: at })
  return { store, sessions, versions, mailbox }
}

const unwrap = <T>(result: Result<T, FleetError>): T => {
  if (!result.ok) assert.fail(`expected ok, got ${result.error.code}: ${result.error.message}`)
  return result.value
}

const failure = <T>(result: Result<T, FleetError>): FleetError => {
  if (result.ok) assert.fail(`expected an error, got ${JSON.stringify(result.value)}`)
  return result.error
}

const send = async (
  mailbox: Mailbox,
  to: PeerId,
  overrides: Partial<Parameters<Mailbox['send']>[0]> = {},
): Promise<Result<MessageId, FleetError>> =>
  mailbox.send({ to, from: 'pm', kind: 'info', briefVersion: 1, body: `hello ${String(to)}`, ...overrides })

describe('a peer is an id, not a session', () => {
  it('addresses the message to the peer id and keeps the sender as the actor', async () => {
    const { store, mailbox } = setup()

    const msgId = unwrap(await send(mailbox, engineer))

    assert.match(String(msgId), /^msg_[0-9a-f]{16}$/)
    const [event] = store.ofType('message.sent')
    assert.ok(event)
    assert.equal(event.subject, 'engineer-1')
    assert.equal(event.actor, 'pm')
    assert.deepEqual(event.data, {
      msgId,
      to: engineer,
      from: 'pm',
      kind: 'info',
      briefVersion: 1,
      body: 'hello engineer-1',
    })
  })

  it('carries the turn kind and the brief version into the stored message', async () => {
    const { store, mailbox } = setup()
    unwrap(await send(mailbox, architect, { kind: 'brief', briefVersion: 3 }))

    const [sent] = store.ofType('message.sent')
    assert.ok(sent)
    assert.equal(sent.data.kind, 'brief')
    assert.equal(sent.data.briefVersion, 3)
  })

  it('accepts a message before the peer has a brief', async () => {
    const { mailbox } = setup()
    unwrap(await send(mailbox, architect, { briefVersion: 1 }))
    assert.equal((await mailbox.pending(architect)).length, 1)
  })

  it('routes peer-to-peer messages through the same box', async () => {
    const { store, mailbox } = setup()
    unwrap(await send(mailbox, architect, { from: peerActor('engineer-1'), body: 'PR is up' }))

    const [sent] = store.ofType('message.sent')
    assert.ok(sent)
    assert.equal(sent.actor, 'peer:engineer-1')
    assert.equal(sent.subject, 'architect')
  })
})

describe('a stale brief is rejected, with the newer one attached', () => {
  it('rejects at send and stores both the message and the rejection', async () => {
    const { store, mailbox } = setup({ 'architect': 4 })

    const error = failure(await send(mailbox, architect, { briefVersion: 2 }))

    assert.equal(error.code, 'conflict')
    assert.equal(error.details?.['currentBriefVersion'], 4)
    assert.equal(store.ofType('message.sent').length, 1, 'the message is still a fact: it was sent')
    const [rejection] = store.ofType('message.rejected')
    assert.ok(rejection)
    assert.deepEqual(rejection.data, {
      msgId: error.details?.['msgId'],
      to: architect,
      reason: 'stale_brief',
      briefVersion: 2,
      currentBriefVersion: 4,
    })
    assert.equal((await mailbox.pending(architect)).length, 0, 'a rejected message is not waiting for delivery')
  })

  it('accepts the current version', async () => {
    const { mailbox } = setup({ 'architect': 4 })
    unwrap(await send(mailbox, architect, { briefVersion: 4 }))
  })

  it('rejects at delivery a message that went stale while it waited', async () => {
    const { store, sessions, versions, mailbox } = setup({ 'architect': 1 })
    const msgId = unwrap(await send(mailbox, architect, { briefVersion: 1 }))

    versions.set(architect, 2) // a new brief was published before anything was delivered
    const outcome = unwrap(await mailbox.deliver(architect))

    assert.deepEqual(outcome.failures, [{ msgId, reason: 'stale_brief' }])
    assert.deepEqual(outcome.delivered, [])
    assert.equal(sessions.sent.length, 0, 'nothing reaches a peer citing an old brief')
    const [rejection] = store.ofType('message.rejected')
    assert.ok(rejection)
    assert.equal(rejection.data.currentBriefVersion, 2)
    const history = await mailbox.history(architect)
    assert.equal(history[0]?.state, 'rejected')
  })
})

describe('at-least-once delivery with ack', () => {
  it('resumes a session and hands every pending message over, oldest first', async () => {
    const { store, sessions, mailbox } = setup()
    const first = unwrap(await send(mailbox, engineer, { body: 'one' }))
    const second = unwrap(await send(mailbox, engineer, { body: 'two' }))

    const outcome = unwrap(await mailbox.deliver(engineer))

    assert.equal(outcome.resumed, true)
    assert.equal(outcome.sessionId, sessions.sessionId)
    assert.deepEqual(outcome.delivered, [first, second])
    assert.deepEqual(outcome.failures, [])
    assert.deepEqual(
      sessions.sent.map((entry) => entry.turn.text),
      ['one', 'two'],
    )
    assert.equal(sessions.sent[0]?.turn.kind, 'info')
    assert.equal(store.ofType('message.delivered').length, 2)
    assert.deepEqual(
      (await mailbox.pending(engineer)).map((message) => message.state),
      ['delivered', 'delivered'],
      'delivered but unacked still counts as pending: that is the at-least-once part',
    )
  })

  it('says whether a resume had to happen', async () => {
    const { sessions, mailbox } = setup()
    sessions.setResumed(false)
    unwrap(await send(mailbox, engineer))
    assert.equal(unwrap(await mailbox.deliver(engineer)).resumed, false)
  })

  it('delivers nothing when the peer has no session, and says why', async () => {
    const { sessions, mailbox } = setup()
    const msgId = unwrap(await send(mailbox, engineer))
    sessions.failNext(noSession(engineer))

    const outcome = unwrap(await mailbox.deliver(engineer))

    assert.deepEqual(outcome.delivered, [])
    assert.deepEqual(outcome.failures, [{ msgId, reason: 'no_session' }])
    assert.equal(outcome.resumed, false)
  })

  it('distinguishes a failed resume from a peer with no session', async () => {
    const { sessions, mailbox } = setup()
    const msgId = unwrap(await send(mailbox, engineer))
    sessions.failNext(resumeFailed(engineer))

    const outcome = unwrap(await mailbox.deliver(engineer))
    assert.deepEqual(outcome.failures, [{ msgId, reason: 'resume_failed' }])
  })

  it('does not re-send an unacked message into the session that already has it', async () => {
    const { sessions, mailbox } = setup()
    unwrap(await send(mailbox, engineer))

    unwrap(await mailbox.deliver(engineer))
    const again = unwrap(await mailbox.deliver(engineer))

    assert.equal(sessions.sent.length, 1, 'the peer is looking at it; a second turn would duplicate it')
    assert.deepEqual(again.delivered, [])
  })

  it('re-sends an unacked message after the session restarted', async () => {
    const { sessions, mailbox } = setup()
    unwrap(await send(mailbox, engineer))
    unwrap(await mailbox.deliver(engineer))

    sessions.rotateSession() // the peer died and came back without its context
    const afterRestart = unwrap(await mailbox.deliver(engineer))

    assert.equal(sessions.sent.length, 2, 'the same message, once more')
    assert.equal(sessions.sent[1]?.sessionId, sessions.sessionId, 'into the session that just came up')
    assert.equal(sessions.sent[1]?.turn.text, sessions.sent[0]?.turn.text)
    assert.equal(afterRestart.delivered.length, 1)
  })

  it('stops delivering once the peer acks, and a repeated ack is a no-op', async () => {
    const { sessions, mailbox } = setup()
    const msgId = unwrap(await send(mailbox, engineer))
    unwrap(await mailbox.deliver(engineer))

    unwrap(await mailbox.ack(engineer, msgId))
    unwrap(await mailbox.ack(engineer, msgId))
    const outcome = unwrap(await mailbox.deliver(engineer))

    assert.deepEqual(outcome.delivered, [])
    assert.equal(sessions.sent.length, 1)
    assert.deepEqual(await mailbox.pending(engineer), [])
    assert.equal((await mailbox.history(engineer))[0]?.state, 'acked')
  })

  it('refuses to ack a message it does not have', async () => {
    const { mailbox } = setup()
    const error = failure(await mailbox.ack(engineer, 'msg_0000000000000000' as MessageId))
    assert.equal(error.code, 'not_found')
  })

  it('refuses to ack a message that was rejected instead of delivered', async () => {
    const { versions, mailbox } = setup({ 'engineer-1': 1 })
    const msgId = unwrap(await send(mailbox, engineer, { briefVersion: 1 }))
    versions.set(engineer, 3)
    unwrap(await mailbox.deliver(engineer))

    const error = failure(await mailbox.ack(engineer, msgId))
    assert.equal(error.code, 'conflict')
  })

  it('sends each message once when two deliveries race', async () => {
    const { sessions, mailbox } = setup()
    unwrap(await send(mailbox, engineer))

    // A supervisor tick can overlap a slow provider call. Both calls see the same
    // box, so only serialising delivery keeps the peer from getting the turn twice.
    await Promise.all([mailbox.deliver(engineer), mailbox.deliver(engineer)])

    assert.equal(sessions.sent.length, 1, 'the peer gets the turn once')
    // The second call ran after the first (not in parallel); it found the message
    // already in this session and had nothing to hand over.
    assert.deepEqual((await mailbox.pending(engineer)).map((m) => m.state), ['delivered'])
  })

  it('leaves the message in the box when the provider refuses the turn', async () => {
    const { sessions, mailbox } = setup()
    const msgId = unwrap(await send(mailbox, engineer))
    sessions.failNextSend(new Error('the session died mid-turn'))

    const error = failure(await mailbox.deliver(engineer))

    assert.equal(error.code, 'provider_failed')
    assert.deepEqual(
      (await mailbox.pending(engineer)).map((message) => message.msgId),
      [msgId],
      'the next deliver retries it',
    )

    const retried = unwrap(await mailbox.deliver(engineer))
    assert.deepEqual(retried.delivered, [msgId])
  })
})

describe('reject', () => {
  it('records the citation and the current version, and is idempotent', async () => {
    const { store, mailbox } = setup()
    const msgId = unwrap(await send(mailbox, engineer, { briefVersion: 2 }))

    unwrap(await mailbox.reject(engineer, msgId, 5))
    unwrap(await mailbox.reject(engineer, msgId, 5))

    const rejections = store.ofType('message.rejected')
    assert.equal(rejections.length, 1, 'a repeated reject writes nothing new')
    assert.equal(rejections[0]?.data.currentBriefVersion, 5)
    const [message] = await mailbox.history(engineer)
    assert.equal(message?.state, 'rejected')
    assert.equal(message?.currentBriefVersion, 5)
  })

  it('refuses a "current" version that is not newer than the one cited', async () => {
    const { mailbox } = setup()
    const msgId = unwrap(await send(mailbox, engineer, { briefVersion: 2 }))
    assert.equal(failure(await mailbox.reject(engineer, msgId, 2)).code, 'invalid_input')
  })

  it('refuses to reject a message the peer already acked', async () => {
    const { mailbox } = setup()
    const msgId = unwrap(await send(mailbox, engineer))
    unwrap(await mailbox.ack(engineer, msgId))
    assert.equal(failure(await mailbox.reject(engineer, msgId, 9)).code, 'conflict')
  })
})

describe('reads', () => {
  it('lists the box newest first, up to the limit', async () => {
    const { mailbox } = setup()
    for (const body of ['one', 'two', 'three']) unwrap(await send(mailbox, engineer, { body }))

    const history = await mailbox.history(engineer, 2)
    assert.deepEqual(
      history.map((message: Message) => message.body),
      ['three', 'two'],
    )
  })

  it('refuses to report an empty box when the read itself failed', async () => {
    const { store, mailbox } = setup()
    unwrap(await send(mailbox, engineer))
    store.failNext(new Error('disk on fire'))

    // `pending` returns a plain list, so a failed read must throw rather than
    // answer "nothing to do".
    await assert.rejects(async () => mailbox.pending(engineer), /disk on fire/)
  })

  it('a store failure comes back as a typed error, not a throw', async () => {
    const { store, mailbox } = setup()
    store.failNext(new Error('disk on fire'))

    const error = failure(await send(mailbox, engineer))
    assert.equal(error.code, 'store_failed')
    assert.match(error.message, /disk on fire/)
  })
})

describe('no held or approval path (§13)', () => {
  it('exposes exactly the six calls the API declares, so nothing can be held', () => {
    const { mailbox } = setup()
    assert.deepEqual(Object.keys(mailbox).sort(), ['ack', 'deliver', 'history', 'pending', 'reject', 'send'])
  })
})
