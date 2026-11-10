/**
 * §11's ledger as the daemon composes it: the profile's `builds.timeoutMinutes` is the
 * limit a build runs under, and a profile that names none runs under the ledger's own
 * default rather than none (TASK-67).
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { parse, repo, sha } from '@fleet/foundation-core'
import { openSqliteStore } from '@fleet/foundation-store'
import { DEFAULT_BUILD_TIMEOUT_MS, type ProcessInvocation } from '@fleet/orchestration-ledger'
import { decodeProfile } from '../src/config/profile.ts'
import { createDaemonBuilds } from '../src/wiring/builds.ts'

const dir = await mkdtemp(join(tmpdir(), 'fleet-builds-timeout-'))
after(async () => {
  await rm(dir, { recursive: true, force: true })
})

const profileWith = (builds: unknown) =>
  decodeProfile({
    profile: 'engineer',
    repos: ['acme/widgets'],
    peers: [{ id: 'engineer-1', role: 'engineer', provider: 'claude', model: 'sonnet' }],
    ...(builds === undefined ? {} : { builds }),
  })

const timeoutOf = async (builds: unknown, name: string): Promise<number | undefined> => {
  const store = await openSqliteStore({ path: join(dir, `${name}.db`) })
  await store.migrate()
  const seen: ProcessInvocation[] = []
  const ledger = createDaemonBuilds({
    profile: profileWith(builds),
    sink: { append: (batch) => store.append(batch) },
    builds: store.reader().builds,
    logDir: join(dir, name),
    process: async (invocation) => (seen.push(invocation), { code: 0, durationMs: 1 }),
  })
  await ledger.request({
    repo: parse(repo(), 'acme/widgets'),
    sha: parse(sha(), 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'),
    task: 'test',
    command: { bin: 'pnpm', args: ['test'] },
  })
  return seen[0]?.timeoutMs
}

describe('the build timeout a profile sets', () => {
  it('is the profile’s minutes, in milliseconds', async () => {
    assert.equal(await timeoutOf({ timeoutMinutes: 5 }, 'own'), 300_000)
  })

  it('is the ledger’s default when the profile says nothing', async () => {
    assert.equal(await timeoutOf(undefined, 'none'), DEFAULT_BUILD_TIMEOUT_MS)
    assert.equal(await timeoutOf({ heavy: [] }, 'block'), DEFAULT_BUILD_TIMEOUT_MS)
  })

  it('refuses a limit that is not a positive number of minutes', () => {
    assert.throws(() => profileWith({ timeoutMinutes: 0 }), /timeoutMinutes/)
    assert.throws(() => profileWith({ timeoutMinutes: -3 }), /timeoutMinutes/)
  })
})
