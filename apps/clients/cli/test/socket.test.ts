import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { FleetError } from '@fleet/foundation-core'
import { socketPathOf } from '../src/socket.ts'

const home = '/home/tester'
const derived = join(home, '.fleet', 'squad', 'daemon', 'fleetd.sock')

const refused = (error: unknown): boolean => error instanceof FleetError && error.code === 'invalid_input'

describe('socketPathOf', () => {
  it('derives the socket from the profile, the way §2 lays a profile out', () => {
    assert.deepEqual(socketPathOf({ profile: 'squad', env: {}, home }), { socketPath: derived, profile: 'squad' })
  })

  it('takes FLEET_PROFILE when no profile was typed', () => {
    assert.deepEqual(socketPathOf({ env: { FLEET_PROFILE: 'squad' }, home }), { socketPath: derived, profile: 'squad' })
  })

  it('takes FLEET_SOCKET as it is, because that is the one a peer is handed (§8)', () => {
    assert.deepEqual(socketPathOf({ env: { FLEET_SOCKET: '/run/fleetd.sock', FLEET_PROFILE: 'squad' }, home }), {
      socketPath: '/run/fleetd.sock',
      profile: 'squad',
    })
  })

  it('lets --profile beat FLEET_SOCKET: a flag is a decision about this command', () => {
    assert.deepEqual(socketPathOf({ profile: 'squad', env: { FLEET_SOCKET: '/run/stale.sock' }, home }), {
      socketPath: derived,
      profile: 'squad',
    })
  })

  it('lets --socket beat everything, and carries no profile it was not given', () => {
    assert.deepEqual(socketPathOf({ socket: '/tmp/x.sock', profile: 'squad', env: {}, home }), {
      socketPath: '/tmp/x.sock',
      profile: 'squad',
    })
    assert.deepEqual(socketPathOf({ socket: '/tmp/x.sock', env: { FLEET_PROFILE: 'squad' }, home }), {
      socketPath: '/tmp/x.sock',
    })
  })

  it('treats an empty variable as unset rather than as a path of ""', () => {
    assert.deepEqual(socketPathOf({ env: { FLEET_SOCKET: '', FLEET_PROFILE: 'squad' }, home }), {
      socketPath: derived,
      profile: 'squad',
    })
  })

  it('refuses a profile name instead of turning it into a path', () => {
    for (const bad of ['../escape', 'Squad', 'squad/../other', '1squad']) {
      assert.throws(() => socketPathOf({ profile: bad, env: {}, home }), refused, bad)
    }
  })

  it('says how to name a fleet when nothing does', () => {
    assert.throws(
      () => socketPathOf({ env: {}, home }),
      (error: unknown) => refused(error) && /no fleet named/.test((error as Error).message),
    )
  })

  it('names the fleet that is running, so the name is one copy-paste away', () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-socket-'))
    mkdirSync(join(root, '.fleet', 'squad', 'daemon'), { recursive: true })
    writeFileSync(join(root, '.fleet', 'squad', 'daemon', 'fleetd.sock'), '')
    assert.throws(
      () => socketPathOf({ env: {}, home: root }),
      (error: unknown) => refused(error) && /pass --profile squad/.test((error as Error).message),
    )
  })
})
