/**
 * Which fleet a window shows (§7): the order of the four answers, and the two
 * that are not a socket.
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { discover, expandHome } from '../src/discovery.ts'
import { runningProfiles } from '../src/profiles.ts'

const HOME = '/home/tester'

const base = { socket: undefined, profile: undefined, env: {}, home: HOME, running: [] } as const

test('a socket setting wins over a profile, an env and the scan', () => {
  const found = discover({
    socket: '/tmp/one.sock',
    profile: 'beta',
    env: { FLEET_SOCKET: '/tmp/two.sock', FLEET_PROFILE: 'gamma' },
    home: HOME,
    running: ['alpha'],
  })
  assert.deepEqual(found, { kind: 'socket', socketPath: '/tmp/one.sock', profile: 'beta', via: 'setting' })
})

test('a socket setting expands ~ against the extension host home', () => {
  const found = discover({ ...base, socket: '~/.fleet/x/daemon/fleetd.sock' })
  assert.deepEqual(found, {
    kind: 'socket',
    socketPath: `${HOME}/.fleet/x/daemon/fleetd.sock`,
    via: 'setting',
  })
})

test('a profile setting is the layout, not a guess at the file', () => {
  const found = discover({ ...base, profile: 'beta' })
  assert.equal(found.kind, 'socket')
  assert.deepEqual(found, { kind: 'socket', socketPath: `${HOME}/.fleet/beta/daemon/fleetd.sock`, profile: 'beta', via: 'profile' })
})

test('the environment is read when no setting names a fleet, socket before profile', () => {
  assert.deepEqual(discover({ ...base, env: { FLEET_SOCKET: '/tmp/env.sock', FLEET_PROFILE: 'gamma' } }), {
    kind: 'socket',
    socketPath: '/tmp/env.sock',
    profile: 'gamma',
    via: 'env',
  })
  assert.deepEqual(discover({ ...base, env: { FLEET_PROFILE: 'gamma' } }), {
    kind: 'socket',
    socketPath: `${HOME}/.fleet/gamma/daemon/fleetd.sock`,
    profile: 'gamma',
    via: 'env',
  })
})

test('one running profile needs no question; several do; none is a state, not an error', () => {
  assert.deepEqual(discover({ ...base, running: ['alpha'] }), {
    kind: 'socket',
    socketPath: `${HOME}/.fleet/alpha/daemon/fleetd.sock`,
    profile: 'alpha',
    via: 'profile',
  })
  assert.deepEqual(discover({ ...base, running: ['beta', 'alpha', 'beta'] }), { kind: 'choose', profiles: ['alpha', 'beta'] })
  assert.deepEqual(discover({ ...base, running: [] }), { kind: 'none' })
})

test('a blank setting is a setting nobody wrote', () => {
  // Whitespace, not an empty path: it must fall through to the scan, not be
  // expanded into `/.fleet/...` and reported as a missing socket.
  assert.deepEqual(discover({ ...base, socket: '   ', profile: '', running: ['alpha'] }), {
    kind: 'socket',
    socketPath: `${HOME}/.fleet/alpha/daemon/fleetd.sock`,
    profile: 'alpha',
    via: 'profile',
  })
})

test('a profile name the layout rejects is a state, not a throw (§ the poll loop)', () => {
  // `fleet.profile` is a workspace setting, so its bytes arrive with the
  // repository. `profilePaths` throws on a name it cannot take, and this runs on
  // the poll loop: throwing here stopped every later poll.
  for (const profile of ['../elsewhere', 'Upper', 'with_underscore', 'a/b']) {
    const found = discover({ ...base, profile })
    assert.equal(found.kind, 'invalid', `"${profile}" is not a profile name`)
    assert.ok(found.kind === 'invalid')
    assert.match(found.reason, /not a profile name/)
  }

  const fromEnv = discover({ ...base, env: { FLEET_PROFILE: '../elsewhere' } })
  assert.equal(fromEnv.kind, 'invalid', 'the environment is held to the same rule')
})

test('a directory under ~/.fleet that is not a profile name is dropped, never thrown', () => {
  // Something else on the machine keeping a socket at `~/.fleet/<odd name>/...`
  // is not a fleet and must not take the scan's answer down with it.
  assert.deepEqual(discover({ ...base, running: ['.DS_Store'] }), { kind: 'none' })
  assert.deepEqual(discover({ ...base, running: ['.DS_Store', 'alpha'] }), {
    kind: 'socket',
    socketPath: `${HOME}/.fleet/alpha/daemon/fleetd.sock`,
    profile: 'alpha',
    via: 'profile',
  })
})

test('expandHome touches ~ and nothing else', () => {
  assert.equal(expandHome('~', '/h'), '/h')
  assert.equal(expandHome('~/x', '/h'), '/h/x')
  assert.equal(expandHome('/abs/x', '/h'), '/abs/x')
  assert.equal(expandHome('rel/x', '/h'), 'rel/x')
  // `~user` is not a home this extension can resolve, so it is left alone.
  assert.equal(expandHome('~other/x', '/h'), '~other/x')
})

test('the profile scan is the profiles with a socket file, sorted, and a missing ~/.fleet is empty', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fleet-editor-profiles-'))
  try {
    assert.deepEqual(await runningProfiles(home), [])

    for (const name of ['beta', 'alpha', 'no-socket']) {
      await mkdir(join(home, '.fleet', name, 'daemon'), { recursive: true })
    }
    // A socket file is not proof of a live daemon — `profiles.ts` says so — so a
    // regular file stands in for one in a test that cannot bind a socket twice.
    await writeFile(join(home, '.fleet', 'alpha', 'daemon', 'fleetd.sock'), '')
    await writeFile(join(home, '.fleet', 'beta', 'daemon', 'fleetd.sock'), '')

    assert.deepEqual(await runningProfiles(home), ['alpha', 'beta'])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
