/**
 * §11's routing rule: the profile names the heavy classes, this file decides the
 * host. The two tests that matter are the edge ones — a task that is not heavy
 * still goes somewhere, and a routing that names the remote host with no remote
 * runner is refused when the ledger is built rather than on the first heavy task.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { routeBuildHost, validateRouting, type BuildRouting } from '../src/host.ts'

const routing = (overrides: Partial<BuildRouting> = {}): BuildRouting => ({
  host: 'local',
  heavy: ['evals'],
  ...overrides,
})

describe('routeBuildHost', () => {
  it('sends a heavy class to the remote host', () => {
    assert.equal(routeBuildHost('evals:judge:claude:opus', routing()), 'remote')
  })

  it('sends every other class to the profile default', () => {
    assert.equal(routeBuildHost('test:unit', routing()), 'local')
    assert.equal(routeBuildHost('evals-ish', routing()), 'local')
  })

  it('routes by class, so the whole class is heavy or none of it is', () => {
    assert.equal(routeBuildHost('evals:other-suite:other:model', routing()), 'remote')
  })

  it('sends everything to the default when nothing is heavy', () => {
    assert.equal(routeBuildHost('evals:judge:claude:opus', routing({ heavy: [] })), 'local')
    assert.equal(routeBuildHost('test', routing({ heavy: [], host: 'remote' })), 'remote')
  })
})

describe('validateRouting', () => {
  it('accepts a routing whose hosts all have a runner', () => {
    const input = routing()
    assert.equal(validateRouting(input, ['local', 'remote']), input)
  })

  it('accepts a routing with nothing heavy, with or without a remote host', () => {
    assert.deepEqual(validateRouting(routing({ heavy: [] }), ['local']), { host: 'local', heavy: [] })
  })

  it('refuses a heavy class with no remote runner, and names the class and the fix', () => {
    assert.throws(
      () => validateRouting(routing({ heavy: ['evals', 'e2e'] }), ['local']),
      (error: Error & { code?: string }) =>
        error.code === 'invalid_input' &&
        error.message.includes('evals, e2e') &&
        error.message.includes('builds.heavy'),
    )
  })
})
