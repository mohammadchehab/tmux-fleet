/**
 * §6.1's rules, as tests: dedupe, the failure rate limit, the single quiet
 * reminder, and the withdraw on close. The planner is pure, so each case is one
 * set of rows and one `now`, and the assertion is the plan — no channel, no
 * store, nothing to fake but the rows.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parse, timestamp } from '@fleet/foundation-core'
import { decision as decisionSchema, notification as notificationSchema } from '@fleet/foundation-contracts'
import type { Decision, Notification } from '@fleet/foundation-contracts'
import { notifyPolicy } from '../src/policy.ts'
import { planNotifications } from '../src/plan.ts'

const at = (iso: string): string => parse(timestamp(), iso)

// The overrides are loose on purpose: each test names the one field it is about (`key: 'failure:builder:auth'`), and
// the schema is what turns them into a `Notification`, branded ids and all.
const row = (overrides: Readonly<Record<string, unknown>>): Notification =>
  parse(notificationSchema(), {
    key: 'decision:dec_0123456789abcdef',
    class: 'decision',
    state: 'pending',
    deliveryFailed: false,
    occurrences: 1,
    createdAt: at('2026-11-10T09:00:00.000Z'),
    ...overrides,
  })

const openDecision = (overrides: Partial<Decision> = {}): Decision =>
  parse(decisionSchema(), {
    decisionId: 'dec_0123456789abcdef',
    kind: 'scope',
    state: 'open',
    question: 'Ship the CI gate before the notify packages?',
    options: ['yes', 'no'],
    inputsHash: 'abc12345',
    requestedAt: at('2026-11-10T09:00:00.000Z'),
    ...overrides,
  })

const plan = (notifications: readonly Notification[], now: string, extra: { readonly decisions?: readonly Decision[]; readonly standups?: readonly { date: string; text: string }[] } = {}) =>
  planNotifications({ notifications, now: at(now), ...extra })

describe('dedupe: one notification per key', () => {
  it('sends a pending decision once, with the question, the options and the inbox command', () => {
    const result = plan([row({})], '2026-11-10T09:05:00.000Z', { decisions: [openDecision()] })

    assert.equal(result.send.length, 1)
    const [send] = result.send
    assert.equal(send?.reason, 'first')
    assert.equal(send?.key, 'decision:dec_0123456789abcdef')
    assert.match(send?.title ?? '', /Decision needed/)
    assert.match(send?.body ?? '', /Ship the CI gate/)
    assert.match(send?.body ?? '', /yes · no/)
    assert.equal(send?.action?.cmd, 'fleet decide dec_0123456789abcdef')
  })

  it('a sent decision is silent: a decision notifies once when it opens', () => {
    const sent = row({ state: 'sent', sentAt: at('2026-11-10T09:00:00.000Z') })

    assert.deepEqual(plan([sent], '2026-11-10T09:30:00.000Z', { decisions: [openDecision()] }), { send: [], withdraw: [] })
  })

  it('skips a class the profile turned off', () => {
    const policy = notifyPolicy({ classes: ['decision'] })
    const failure = row({ key: 'failure:builder:auth', class: 'failure', state: 'pending' })

    const result = planNotifications({ notifications: [failure], now: at('2026-11-10T09:05:00.000Z'), policy })

    assert.deepEqual(result.send, [])
  })
})

describe('failure rate limit: once, then one per window with a count (§6.1)', () => {
  const failing = row({
    key: 'failure:builder:auth',
    class: 'failure',
    state: 'sent',
    sentAt: at('2026-11-10T09:00:00.000Z'),
    occurrences: 4,
  })

  it('stays quiet inside the 6 h window — never one banner per retry', () => {
    assert.deepEqual(plan([failing], '2026-11-10T14:59:00.000Z').send, [])
  })

  it('repeats after the window, saying how many events have piled up', () => {
    const [send, ...rest] = plan([failing], '2026-11-10T15:00:00.000Z').send

    assert.equal(rest.length, 0)
    assert.equal(send?.reason, 'repeat')
    assert.equal(send?.occurrences, 4)
    assert.match(send?.title ?? '', /Still failing: auth/)
    assert.match(send?.body ?? '', /builder — 4 events/)
  })

  it('a failure key resolves by itself, so a resolved row withdraws rather than repeats', () => {
    const resolved = row({
      key: 'failure:builder:auth',
      class: 'failure',
      state: 'resolved',
      sentAt: at('2026-11-10T09:00:00.000Z'),
      resolvedAt: at('2026-11-10T09:10:00.000Z'),
    })

    assert.deepEqual(plan([resolved], '2026-11-10T20:00:00.000Z').withdraw, [
      { key: 'failure:builder:auth', class: 'failure' },
    ])
  })
})

describe('still waiting: at most one quiet reminder (§6.1)', () => {
  const sent = row({ state: 'sent', sentAt: at('2026-11-10T09:00:00.000Z') })

  it('reminds an open decision after 8 h', () => {
    const [reminder, ...rest] = plan([sent], '2026-11-10T17:00:00.000Z', { decisions: [openDecision()] }).send

    assert.equal(rest.length, 0)
    assert.equal(reminder?.reason, 'reminder')
    assert.match(reminder?.title ?? '', /Still waiting/)
    assert.equal(reminder?.action?.cmd, 'fleet decide dec_0123456789abcdef')
  })

  it('does not remind before 8 h', () => {
    assert.deepEqual(plan([sent], '2026-11-10T16:59:00.000Z', { decisions: [openDecision()] }).send, [])
  })

  it('never reminds twice: the row already carries remindedAt', () => {
    const reminded = row({
      state: 'sent',
      sentAt: at('2026-11-10T09:00:00.000Z'),
      remindedAt: at('2026-11-10T17:00:00.000Z'),
    })

    assert.deepEqual(plan([reminded], '2026-11-11T09:00:00.000Z', { decisions: [openDecision()] }).send, [])
  })

  it('does not remind a decision that was answered while the banner waited', () => {
    const answered = openDecision({ state: 'answered', answeredAt: at('2026-11-10T10:00:00.000Z') as Decision['answeredAt'] })

    assert.deepEqual(plan([sent], '2026-11-10T18:00:00.000Z', { decisions: [answered] }).send, [])
  })
})

describe('close: the banner goes when its key resolves (§6.1)', () => {
  const delivered = { sentAt: at('2026-11-10T09:00:00.000Z') }

  it('withdraws a resolved key that was delivered, once', () => {
    const resolved = row({ state: 'resolved', ...delivered, resolvedAt: at('2026-11-10T09:30:00.000Z') })
    assert.equal(plan([resolved], '2026-11-10T10:00:00.000Z').withdraw.length, 1)

    const alreadyWithdrawn = row({
      state: 'resolved',
      ...delivered,
      resolvedAt: at('2026-11-10T09:30:00.000Z'),
      withdrawnAt: at('2026-11-10T09:30:00.000Z'),
    })
    assert.deepEqual(plan([alreadyWithdrawn], '2026-11-10T10:00:00.000Z').withdraw, [])
  })

  it('does not withdraw a key that never reached the screen — there is no banner to clear', () => {
    const resolved = row({ state: 'resolved', resolvedAt: at('2026-11-10T09:30:00.000Z'), deliveryFailed: true })
    assert.deepEqual(plan([resolved], '2026-11-10T10:00:00.000Z').withdraw, [])
  })
})

describe('standup: the day is read once (§6.1)', () => {
  const standup = row({
    key: 'standup:2026-11-10',
    class: 'standup',
    state: 'pending',
    createdAt: at('2026-11-10T09:00:00.000Z'),
  })

  it('carries the rendered text the event had, not an empty body', () => {
    const [send, ...rest] = plan([standup], '2026-11-10T09:05:00.000Z', {
      standups: [{ date: '2026-11-10', text: '3 peers, 2 work items, 1 decision open' }],
    }).send

    assert.equal(rest.length, 0)
    assert.equal(send?.title, 'Standup 2026-11-10')
    assert.equal(send?.body, '3 peers, 2 work items, 1 decision open')
    assert.equal(send?.action, undefined)
  })

  it('never repeats: a sent standup is done for the day', () => {
    const sent = row({
      key: 'standup:2026-11-10',
      class: 'standup',
      state: 'sent',
      sentAt: at('2026-11-10T09:00:00.000Z'),
    })

    assert.deepEqual(plan([sent], '2026-11-11T09:00:00.000Z').send, [])
  })
})

describe('a banner is a glance, not a page', () => {
  it('flattens a title to one line and cuts a long body', () => {
    const question = `Line one\nLine two ${'x'.repeat(400)}`
    const longText = 'y'.repeat(5000)
    const [decisionSend] = plan([row({})], '2026-11-10T09:05:00.000Z', {
      decisions: [openDecision({ question })],
    }).send
    const [standupSend] = plan([row({ key: 'standup:2026-11-10', class: 'standup', state: 'pending' })], '2026-11-10T09:05:00.000Z', {
      standups: [{ date: '2026-11-10', text: longText }],
    }).send

    assert.doesNotMatch(decisionSend?.title ?? '', /\n/)
    assert.ok((decisionSend?.title ?? '').length <= 120)
    // `notify.sent` carries a body of at most 2000 characters; the planner may not produce one that fails its own schema.
    assert.ok((decisionSend?.body ?? '').length <= 2000)
    assert.ok((standupSend?.body ?? '').length <= 2000)
  })
})

describe('a failure that knows what it is talking about', () => {
  it('sends the row’s own words when the projection wrote them, not a render of its key', () => {
    // A compaction is the case: its key says "failure:engineer-1:compacted:17",
    // which is unreadable, and the projection already wrote the sentence worth
    // reading — the tokens, the limit, and the verdict on the limit.
    const compaction = row({
      key: 'failure:engineer-1:compacted:17',
      class: 'failure',
      state: 'pending',
      title: 'Compaction: engineer-1',
      body: 'engineer-1 (claude-sonnet-5-5) — compacted 40,000 tokens (auto) under a configured limit of 200,000.',
    })

    const [send] = plan([compaction], '2026-11-10T09:05:00.000Z').send

    assert.equal(send?.title, 'Compaction: engineer-1')
    assert.match(send?.body ?? '', /configured limit of 200,000/)
  })

  it('still renders the key when the row carries no words of its own', () => {
    // Every other failure: a crash, an unreadable profile. Nothing wrote a
    // sentence, so the fallback is what the user gets — and it has to stay.
    const [send] = plan([row({ key: 'failure:builder:auth', class: 'failure', state: 'pending' })], '2026-11-10T09:05:00.000Z').send

    assert.match(send?.title ?? '', /Failure: auth/)
    assert.match(send?.body ?? '', /builder — auth\./)
  })
})
