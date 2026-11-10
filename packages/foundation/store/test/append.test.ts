/**
 * The append boundary is strict (architecture §3, §5.4, §15). Reads tolerate
 * unknown keys; a write does not, because a misspelt optional field would be
 * dropped and lost instead of reported. `registerEvents` holds the rule here;
 * `SqliteEventStore.append` calls `assertAppendable` before it writes anything.
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { FleetError } from '@fleet/foundation-core'
import type { AppendEvent, FleetEvent } from '@fleet/foundation-contracts'
import { assertAppendable } from '../src/index.ts'

/** The golden fixtures every recorded event is checked against (contracts §3). */
const fixturesDir = fileURLToPath(new URL('../../contracts/test/fixtures/events/', import.meta.url))

/** A recorded event as a producer would hand it to `append`: no seq yet. */
const appendable = (name: string): AppendEvent => {
  const recorded = JSON.parse(readFileSync(`${fixturesDir}${name}`, 'utf8')) as FleetEvent
  const { seq: _seq, ...event } = recorded
  return event
}

const refusal = (batch: readonly AppendEvent[]): FleetError => {
  try {
    assertAppendable(batch)
  } catch (thrown) {
    assert.ok(thrown instanceof FleetError, `expected a FleetError, got ${String(thrown)}`)
    return thrown
  }
  assert.fail('expected the append boundary to refuse the batch')
}

test('every recorded event is appendable', () => {
  const names = readdirSync(fixturesDir).filter((name) => name.endsWith('.json'))
  assert.ok(names.length > 40, `expected the golden corpus, found ${names.length} fixture(s)`)
  for (const name of names) {
    assert.deepEqual(
      (() => {
        try {
          assertAppendable([appendable(name)])
          return []
        } catch (thrown) {
          return [(thrown as FleetError).message]
        }
      })(),
      [],
      `${name} must pass the append boundary`,
    )
  }
})

test('a misspelt optional key is refused, not dropped', () => {
  const event = appendable('peer.state_changed.json')
  const misspelt = { ...event, data: { ...event.data, reasunn: 'turn.started' } } as unknown as AppendEvent
  const error = refusal([misspelt])
  assert.equal(error.code, 'invalid_input')
  assert.match(error.message, /\[0\] peer\.state_changed data\.reasunn: unknown field/)
})

test('an unknown event type is refused', () => {
  const event = { ...appendable('peer.state_changed.json'), type: 'peer.state_changedd' } as unknown as AppendEvent
  const error = refusal([event])
  assert.equal(error.code, 'invalid_input')
  assert.match(error.message, /unknown event type "peer\.state_changedd"/)
})

test('a batch reports every bad event and its position', () => {
  const good = appendable('peer.state_changed.json')
  const bad = { ...appendable('turn.usage_recorded.json') } as Record<string, unknown>
  bad.ts = 'yesterday'
  const error = refusal([good, bad as unknown as AppendEvent])
  assert.equal(error.code, 'invalid_input')
  assert.match(error.message, /\[1\] turn\.usage_recorded ts:/)
  assert.doesNotMatch(error.message, /\[0\]/)
})
