/**
 * What the CLI prints must not do anything (TASK-100).
 *
 * `fleet ls`, `fleet peek` and `fleet build` lay out strings a peer chose the
 * bytes of: the target of its last tool call is the model's own `file_path`, a
 * message body is what a peer wrote, a decision's question is what it asked.
 * None of them print a colour of their own, so none of their output has a
 * legitimate `\u001b` in it — which makes one assertion enough for the file.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { BuildsResult, LsResult, Message, PeekResult } from '@fleet/foundation-contracts'
import type { DecisionId, MessageId, PeerId } from '@fleet/foundation-core'

import { formatBuild, formatLs, formatPeek } from '../src/render.ts'

/**
 * What a peer puts in a path to take the screen: wipe it, home the cursor, set
 * the window title (OSC 0), write the clipboard (OSC 52).
 */
const PAYLOAD = '\u001b[2J\u001b[1;1H\u001b]0;pwned\u0007\u001b]52;c;cGF5bG9hZA==\u0007evil.ts'

const now = '2026-11-11T09:00:00.000Z'

/**
 * Whatever a terminal would obey rather than draw. A newline is excluded: it is
 * the one control character the layout writes itself, between two lines.
 */
const controls = (text: string): readonly string[] => text.match(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g) ?? []

const ls = (overrides: Partial<LsResult> = {}): LsResult => ({
  status: {
    profile: 'squad',
    pid: 1,
    startedAt: now,
    socketPath: '/s',
    storePath: '/db',
    protocolVersion: 2,
    purgeContextRatio: 0.6,
  },
  peers: [],
  routines: [],
  decisions: [],
  compactions: [],
  tokens: [],
  activity: [],
  ...overrides,
})

test('a peer-controlled lastTarget is printed as text, not as a sequence', () => {
  const text = formatLs(
    ls({
      activity: [{ peerId: 'a' as PeerId, lastTool: 'Read', lastTarget: PAYLOAD, edits: 1 }],
      peers: [{ peerId: 'a' as PeerId, role: 'engineer', providerId: 'claude', model: 'opus', permissionMode: 'default', briefVersion: 1, state: 'working', registeredAt: now, updatedAt: now }],
    }),
  )
  assert.deepEqual(controls(text), [])
  // And the harm is gone rather than renamed: the words survive as words.
  assert.match(text, /Read\s+evil\.ts/)
})

test('so is the peer id, the session and the model on the peers row', () => {
  const text = formatLs(
    ls({
      peers: [
        {
          peerId: `a${PAYLOAD}` as PeerId,
          role: PAYLOAD,
          providerId: PAYLOAD,
          model: PAYLOAD,
          permissionMode: 'default',
          briefVersion: 1,
          currentSessionId: PAYLOAD as never,
          state: 'working',
          registeredAt: now,
          updatedAt: now,
        },
      ],
    }),
  )
  assert.deepEqual(controls(text), [])
})

test('so is the question a peer asks and the options it offers', () => {
  const text = formatLs(
    ls({
      decisions: [
        {
          decisionId: 'dec_0123456789abcdef' as DecisionId,
          kind: 'route_question',
          state: 'open',
          question: PAYLOAD,
          options: [PAYLOAD, 'hold'],
          inputsHash: 'abcdef0123',
          requestedAt: now,
        },
      ],
    }),
  )
  assert.deepEqual(controls(text), [])
  assert.match(text, /options: evil\.ts \| hold/)
})

test('so is the body of a message in `fleet peek`', () => {
  const message: Message = {
    msgId: 'msg_0123456789abcdef' as MessageId,
    from: 'a' as PeerId,
    to: 'b' as PeerId,
    kind: 'info',
    state: 'delivered',
    body: `here is the file\n${PAYLOAD}`,
    briefVersion: 1,
    sentAt: now,
  } as Message
  const peek: PeekResult = { messages: [message] } as PeekResult
  const text = formatPeek(peek, 'b')
  assert.deepEqual(controls(text), [])
})

test('so is the task and host a build records', () => {
  const builds = {
    build: { buildId: 'bld_0123456789abcdef', status: 'passed', repo: 'r', sha: 'abc1234', task: PAYLOAD, host: PAYLOAD, logPath: `/tmp/${PAYLOAD}` },
    deduped: false,
  } as unknown as BuildsResult
  assert.deepEqual(controls(formatBuild(builds)), [])
})
