/**
 * The profile path layout (§2, "On disk").
 *
 * It is one function over two injected roots, so the whole file is an assertion
 * about derived strings: no filesystem, no `HOME`. What matters is that config
 * and state never share a directory, and that a name which would become a path
 * is refused rather than escaped.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseProfileName, persistentDirs, profilePaths } from '../src/index.ts'

describe('the path layout', () => {
  it('keeps config and state apart, under the two roots the architecture fixed (§2)', () => {
    const paths = profilePaths('engineer', { home: '/home/u', configHome: '/cfg' })
    assert.equal(paths.profileFile, '/cfg/fleet/profiles/engineer.yaml')
    assert.equal(paths.stateDir, '/home/u/.fleet/engineer')
    assert.equal(paths.storePath, '/home/u/.fleet/engineer/store/store.sqlite')
    assert.equal(paths.socketPath, '/home/u/.fleet/engineer/daemon/fleetd.sock')
    assert.equal(paths.pidPath, '/home/u/.fleet/engineer/daemon/fleetd.pid')
    assert.equal(paths.lockPath, '/home/u/.fleet/engineer/daemon/fleetd.lock')
    assert.equal(paths.logPath, '/home/u/.fleet/engineer/daemon/fleetd.log')
  })

  it('creates every directory a run writes into', () => {
    const paths = profilePaths('engineer', { home: '/home/u', configHome: '/cfg' })
    assert.deepEqual(persistentDirs(paths), [
      '/home/u/.fleet/engineer/store',
      '/home/u/.fleet/engineer/store/backup',
      '/home/u/.fleet/engineer/daemon',
      '/home/u/.fleet/engineer/peers',
      '/home/u/.fleet/engineer/transcripts',
      '/home/u/.fleet/engineer/artifacts',
      '/home/u/.fleet/engineer/artifacts/findings',
      '/home/u/.fleet/engineer/artifacts/builds',
      '/home/u/.fleet/engineer/notify',
    ])
  })

  it('refuses a name that would become a path', () => {
    for (const bad of ['../etc', 'Engineer', 'en gineer', '', '9lives', 'a/b']) {
      assert.throws(() => parseProfileName(bad), /is not a valid name/)
    }
    assert.equal(parseProfileName('engineer-2'), 'engineer-2')
  })
})
