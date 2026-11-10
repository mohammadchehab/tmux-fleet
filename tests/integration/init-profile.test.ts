// tests/integration/init-profile.test.ts — the profile `fleet init` writes is one `fleet up` accepts.
//
// Two packages own the two halves and neither may import the other: the CLI writes the starter
// (`apps/clients/cli`), the daemon decodes it (`apps/daemon`). A starter that drifted from the schema would
// fail on a person's first run, in a daemon they have not learned to read yet, so the join is tested here
// where importing both is allowed.
//
// The writer runs against a temp directory — the real `~/.config/fleet/profiles` is never touched.

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { parseStrict, repo } from '../../packages/foundation/core/src/index.ts'
import { writeStarter } from '../../apps/clients/cli/src/init.ts'
import { loadProfile } from '../../apps/daemon/src/config/profile.ts'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'fleet-init-profile-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('a profile written by `fleet init`', () => {
  it('decodes as the daemon reads it, with no edit', async () => {
    const { profileFile } = await writeStarter('starter', { home })
    const profile = await loadProfile(profileFile, 'starter')
    assert.equal(profile.profile, 'starter')
    // The placeholder is what the person is meant to replace, and `loadProfile`
    // alone does not prove it is usable: the daemon parses each entry as a
    // `Repo` when it composes, which is one step further than decoding. A
    // starter of `/path/to/a/repo` passed the check above and was refused on the
    // first `fleet up` — so the placeholder is checked here as the daemon will.
    assert.deepEqual(profile.repos, ['owner/name'])
    for (const name of profile.repos) assert.equal(parseStrict(repo(), name), name)
    assert.ok(profile.peers.length > 0)
    for (const peer of profile.peers) assert.ok(peer.id.length > 0)
  })

  it('uses a provider and model the daemon knows, so the first `up` is not a config error', async () => {
    const { profileFile } = await writeStarter('starter', { home })
    const profile = await loadProfile(profileFile, 'starter')
    assert.ok(profile.peers.every((peer) => peer.provider === 'claude'))
    assert.ok(profile.peers.every((peer) => peer.model.startsWith('claude-')))
  })
})
