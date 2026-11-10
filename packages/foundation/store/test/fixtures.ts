/**
 * Test support: the golden corpus as a log, and the read model as one snapshot.
 *
 * The events in `contracts/test/fixtures/events/` are one example of every
 * event type, each with its own `seq`; replayed in that order they are a log the
 * store can be fed like any other, which is what makes them useful here too.
 */

import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Clock, PeerId } from '@fleet/foundation-core'
import type { AppendEvent, FleetEvent } from '@fleet/foundation-contracts'
import type { EventStore } from '../src/index.ts'

const fixturesDir = fileURLToPath(new URL('../../contracts/test/fixtures/events/', import.meta.url))

const readFixture = (name: string): FleetEvent =>
  JSON.parse(readFileSync(`${fixturesDir}${name}`, 'utf8')) as FleetEvent

/** One recorded event, as a producer hands it to `append`: no seq yet. */
export const appendable = (name: string): AppendEvent => {
  const { seq: _seq, ...event } = readFixture(name)
  return event
}

/** The whole corpus in log order. Ties are broken by type so the order never depends on `readdir`. */
export const fixtureLog = (): readonly AppendEvent[] =>
  readdirSync(fixturesDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readFixture(name))
    .sort((left, right) => left.seq - right.seq || left.type.localeCompare(right.type))
    .map(({ seq: _seq, ...event }) => event)

/** Fixed, so a replay stamps the same `ts` it stamped before (§5.4). */
export const fixedClock: Clock = {
  now: () => '2026-11-10T12:00:00.000Z',
  millis: () => 1_800_000_000_000,
}

export const tempStorePath = (): string => join(mkdtempSync(join(tmpdir(), 'fleet-store-')), 'store.sqlite')

/** Every read the `ReadModel` port exposes, in one comparable value. */
export const readAll = async (store: EventStore): Promise<Readonly<Record<string, unknown>>> => {
  const reader = store.reader()
  return {
    peers: await reader.peers.all(),
    sessions: await reader.sessions.forPeer('engineer-1' as PeerId),
    work: await reader.work.all(),
    decisions: await reader.decisions.all(),
    openDecisions: await reader.decisions.open(),
    notifications: await reader.notifications.all(),
    findings: await reader.findings.all(),
    messages: await reader.messages.all(),
    pullRequests: await reader.pullRequests.all(),
    worktrees: await reader.worktrees.all(),
    routines: await reader.routines.all(),
  }
}
