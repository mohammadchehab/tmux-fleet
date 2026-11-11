/**
 * What a peer may be asked to do and what it runs (§4, §6). The command lines
 * are asserted literally, because a takeover that runs a different command than
 * the one a person would type is the bug this table exists to prevent.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  actionsFor,
  actionTitle,
  commandFor,
  oneShotActions,
  sendParamsFor,
  standingOf,
  terminalActions,
} from '../src/actions.ts'
import type { PeerState } from '@fleet/foundation-core'

test('every state maps to a standing, and the live ones are running', () => {
  const expected: readonly (readonly [PeerState, string])[] = [
    ['starting', 'running'],
    ['working', 'running'],
    ['waiting_input', 'running'],
    ['idle', 'running'],
    ['ended', 'stopped'],
    ['failed', 'stopped'],
  ]
  for (const [state, standing] of expected) assert.equal(standingOf(state), standing, state)
})

test('the action table is the watch table', () => {
  assert.deepEqual(actionsFor('running'), ['takeover', 'takeover-now', 'send', 'stop'])
  assert.deepEqual(actionsFor('held'), ['reopen', 'release'])
  assert.deepEqual(actionsFor('stopped'), ['start'])
})

test('every action has a title, and every action is either a terminal or one-shot or send', () => {
  const all = [...actionsFor('running'), ...actionsFor('held'), ...actionsFor('stopped')]
  for (const action of all) assert.notEqual(actionTitle(action), '')
  const covered = new Set([...terminalActions, ...oneShotActions, 'send'])
  for (const action of all) assert.ok(covered.has(action), `${action} is not classified`)
})

test('a takeover is `fleet attach`, and a takeover-now adds --now', () => {
  assert.deepEqual(commandFor('fleet', 'takeover', 'engineer-1'), {
    name: 'fleet: engineer-1',
    argv: ['fleet', 'attach', 'engineer-1'],
  })
  assert.deepEqual(commandFor('fleet', 'takeover-now', 'engineer-1')?.argv, ['fleet', 'attach', 'engineer-1', '--now'])
})

test('stop, start, release and reopen are the CLI commands, and send is not a command at all', () => {
  assert.deepEqual(commandFor('fleet', 'stop', 'p')?.argv, ['fleet', 'stop', 'p'])
  assert.deepEqual(commandFor('fleet', 'start', 'p')?.argv, ['fleet', 'start', 'p'])
  assert.deepEqual(commandFor('fleet', 'release', 'p')?.argv, ['fleet', 'release', 'p'])
  assert.deepEqual(commandFor('fleet', 'reopen', 'p')?.argv, ['fleet', 'attach', 'p'])
  assert.equal(commandFor('fleet', 'send', 'p'), undefined)
})

test('the configured command is what runs, so a checkout works as well as an install', () => {
  assert.deepEqual(commandFor('node apps/clients/cli/src/main.ts', 'stop', 'p')?.argv, [
    'node apps/clients/cli/src/main.ts',
    'stop',
    'p',
  ])
})

test('a message is a nudge to that peer, and nothing else', () => {
  assert.deepEqual(sendParamsFor('engineer-1', 'have a look at TASK-4'), {
    to: 'engineer-1',
    kind: 'nudge',
    body: 'have a look at TASK-4',
  })
})
