// apps/clients/cli/test/init.test.ts — `fleet init` writes a starter profile once, and the starter is the whole
// documented config surface: every routine kind and every model id the repo knows, generated from the same
// constants the daemon validates against so the two cannot drift.
//
// The writer runs against a temp directory, never `$HOME`: a test that wrote a real profile would be a test that
// breaks someone's first `fleet up`.

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { profileProviders, providerModels, routineKinds } from '@fleet/foundation-contracts'
import { FleetError, profilePaths } from '@fleet/foundation-core'
import { starterProfile, writeStarter } from '../src/init.ts'
import { parseArgv } from '../src/run.ts'
import { run, type RunDeps } from '../src/run.ts'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'fleet-init-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('the starter profile', () => {
  it('names the profile it was asked for, in both the field and the header', () => {
    const text = starterProfile('squad')
    assert.match(text, /^profile: squad$/m)
    assert.match(text, /fleet up squad/)
  })

  it('lists every routine kind the fleet has, so a person can turn one off', () => {
    const text = starterProfile('squad')
    for (const kind of routineKinds) assert.match(text, new RegExp(`\\b${kind}\\b`))
  })

  it('lists every model id this repo knows, by provider', () => {
    const text = starterProfile('squad')
    for (const provider of profileProviders) {
      assert.match(text, new RegExp(provider))
      for (const model of providerModels[provider]) assert.match(text, new RegExp(model.replace(/[/.]/g, '\\$&')))
    }
  })

  it('says what it is: the file `fleet up` reads, not a blank to fill in', () => {
    const text = starterProfile('squad')
    assert.match(text, /repos:/)
    assert.match(text, /peers:/)
    // The one field a starter cannot know, and the only one it leaves wrong.
    assert.match(text, /\/path\/to\/a\/repo/)
  })
})

describe('writing it', () => {
  it('writes the file `fleet up` reads, and says where it went', async () => {
    const written = await writeStarter('squad', { home })
    assert.equal(written.profileFile, profilePaths('squad', { home }).profileFile)
    assert.equal(await readFile(written.profileFile, 'utf8'), starterProfile('squad'))
  })

  it('creates the profiles directory, so a first run has nothing to mkdir', async () => {
    const written = await writeStarter('squad', { home })
    assert.equal(await readFile(written.profileFile, 'utf8'), starterProfile('squad'))
  })

  it('never overwrites a profile that is already there', async () => {
    const { profileFile } = await writeStarter('squad', { home })
    await assert.rejects(writeStarter('squad', { home }), (thrown: unknown) => {
      assert.ok(thrown instanceof FleetError)
      assert.equal(thrown.code, 'conflict')
      assert.match(thrown.message, /already there/)
      return true
    })
    // And the first file is untouched.
    assert.equal(await readFile(profileFile, 'utf8'), starterProfile('squad'))
  })

  it('refuses a name that would not be a file name', async () => {
    await assert.rejects(writeStarter('../evil', { home }), /not a valid name/)
  })
})

describe('the command line', () => {
  it('parses `init <profile>` and takes no socket', () => {
    const parsed = parseArgv(['node', 'fleet', 'init', 'squad'])
    assert.deepEqual(parsed.command, { kind: 'init', profile: 'squad' })
  })

  it('refuses `init` with no name, and with two', () => {
    assert.throws(() => parseArgv(['node', 'fleet', 'init']), /usage: fleet init <profile>/)
    assert.throws(() => parseArgv(['node', 'fleet', 'init', 'a', 'b']), /usage: fleet init <profile>/)
  })

  it('answers before resolving a socket: a first run has no fleet to talk to', async () => {
    const out: string[] = []
    // No `FLEET_PROFILE`, no `FLEET_SOCKET`, no home with a fleet in it: `ls`
    // would be refused here, and `init` must not be.
    const deps: RunDeps = {
      call: () => {
        throw new Error('init must not reach the daemon')
      },
      env: {},
      home,
      out: (text) => out.push(text),
      initProfile: async (profile) => ({ profileFile: `/somewhere/${profile}.yaml` }),
    }
    assert.equal(await run(['node', 'fleet', 'init', 'squad'], deps), 0)
    assert.match(out[0] ?? '', /\/somewhere\/squad\.yaml/)
    assert.match(out[0] ?? '', /fleet up squad/)
  })

  it('says so when this build cannot write one, rather than writing nothing', async () => {
    const err: string[] = []
    const deps: RunDeps = {
      call: () => {
        throw new Error('init must not reach the daemon')
      },
      env: {},
      home,
      out: () => {},
      err: (text) => err.push(text),
    }
    assert.equal(await run(['node', 'fleet', 'init', 'squad'], deps), 1)
    assert.match(err[0] ?? '', /cannot write a profile/)
  })
})
