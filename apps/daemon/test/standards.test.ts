/**
 * A peer's standing brief (§12.1): what it is handed, when that counts as a new
 * Brief, and what stops a peer from starting without its rules.
 *
 * The repo's files, the log and the peer row are fakes, because what the daemon
 * decides is what to ask for and what to write; `RepoFiles` is pinned against real
 * git in `workspace/worktree`, and the supervisor's use of this in `sessions.test`.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import { fixedClock, profilePaths } from '@fleet/foundation-core'
import type { AppendEvent, FleetEvent, RepoFiles } from '@fleet/foundation-contracts'
import { MAX_SOURCE_CHARS } from '@fleet/orchestration-briefs'

import { decodeProfile, type PeerProfile, type Profile } from '../src/config/profile.ts'
import { createStandingBriefs } from '../src/execution/standards.ts'

const SHA = 'c'.repeat(40)
const clock = fixedClock('2026-11-10T09:00:00.000Z')

interface Rig {
  readonly standing: ReturnType<typeof createStandingBriefs>
  readonly appended: AppendEvent[]
  readonly profileDir: string
  readonly artifactsDir: string
  /** The repo's files on its default branch; change an entry to change what a restart reads. */
  readonly repo: Map<string, string>
  /** What a Work's brief has already raised the peer's version to. */
  carried: number
  readonly peer: PeerProfile
}

const profileOf = (standards?: Record<string, unknown>): Profile =>
  decodeProfile({
    profile: 'test',
    repos: ['acme/widgets'],
    peers: [{ id: 'engineer-1', role: 'engineer', provider: 'claude', model: 'm' }],
    ...(standards === undefined ? {} : { standards }),
  })

/** One rig is one daemon; `restart` builds a new one over the same log, files and disk. */
const rig = async (standards?: Record<string, unknown>, files: Record<string, string> = { 'AGENTS.md': 'Run pnpm test.' }) => {
  const paths = profilePaths('test', { home: await mkdtemp(join(tmpdir(), 'fleet-standards-')) })
  const profileDir = dirname(paths.profileFile)
  await mkdir(profileDir, { recursive: true })
  const appended: AppendEvent[] = []
  const repo = new Map(Object.entries(files))
  const state = { carried: 0 }

  const make = (profile: Profile) =>
    createStandingBriefs({
      profile,
      paths,
      repoFiles: {
        read: async (_cwd, path) => (repo.has(path) ? { text: repo.get(path) ?? '', ref: SHA } : undefined),
      } satisfies RepoFiles,
      events: {
        latest: async (type, subject) => {
          const found = [...appended].reverse().find((event) => event.type === type && event.subject === subject)
          return found === undefined ? undefined : ({ ...found, seq: appended.indexOf(found) + 1 } as FleetEvent)
        },
      },
      read: { peers: { get: async () => ({ briefVersion: state.carried }) as never, all: async () => [] } },
      append: async (batch) => {
        appended.push(...batch)
        return batch.map((_, index) => appended.length - batch.length + index + 1)
      },
      clock,
    })

  const profile = profileOf(standards)
  return {
    standing: make(profile),
    restart: () => make(profile),
    appended,
    profileDir,
    artifactsDir: paths.artifactsDir,
    repo,
    setCarried: (n: number) => (state.carried = n),
    peer: profile.peers[0] as PeerProfile,
  }
}

const standardsEvents = (appended: readonly AppendEvent[]) => appended.filter((event) => event.type === 'peer.standards_set')

test('the first start writes the standards, the brief that carries them, and an event that says what was read', async () => {
  const r = await rig({ nonNegotiables: 'non-negotiables.md' }, { 'AGENTS.md': 'Run pnpm test.', 'CLAUDE.md': 'Use codegraph.' })
  await writeFile(join(r.profileDir, 'non-negotiables.md'), 'Never push to main.')

  const got = await r.standing.for(r.peer, '/work/widgets')

  assert.equal(got.brief.version, 1)
  assert.match(String(got.brief.briefId), /^brf_[0-9a-f]{16}$/)
  assert.match(got.brief.text, /^You are engineer-1, the engineer\./)
  assert.match(got.brief.text, /Your standards are in your system prompt \(digest [0-9a-f]{12}\); follow them\.$/)
  // Precedence: the profile's rule first, then the repo's own.
  const text = got.systemPromptAppend ?? ''
  assert.ok(text.indexOf('Never push to main.') < text.indexOf('Run pnpm test.'))
  assert.ok(text.indexOf('Run pnpm test.') < text.indexOf('Use codegraph.'))

  const [event] = standardsEvents(r.appended)
  assert.equal(standardsEvents(r.appended).length, 1)
  assert.equal(event?.subject, 'engineer-1')
  assert.deepEqual(event?.data.sources, [
    { name: 'Non-negotiables (non-negotiables.md)', chars: 19, truncated: false },
    { name: 'AGENTS.md', chars: 14, truncated: false, ref: SHA },
    { name: 'CLAUDE.md', chars: 14, truncated: false, ref: SHA },
  ])
  assert.deepEqual(event?.data.skipped, [])
  assert.equal(event?.data.briefId, got.brief.briefId)
  // The bytes are archived under the digest the event names, before the event.
  assert.match(await readFile(join(r.artifactsDir, 'standards', `${String(event?.data.digest)}.md`), 'utf8'), /Never push to main\./)
})

test('the same standards after a restart are the same Brief, and write nothing', async () => {
  const r = await rig()
  const first = await r.standing.for(r.peer, '/work/widgets')
  const again = await r.restart().for(r.peer, '/work/widgets')

  assert.deepEqual(again, first)
  assert.equal(standardsEvents(r.appended).length, 1)
})

test('a changed standard is a new Brief: the next version, a new id, and an event with the new digest', async () => {
  const r = await rig()
  const first = await r.standing.for(r.peer, '/work/widgets')
  r.repo.set('AGENTS.md', 'Run pnpm test, then pnpm typecheck.')
  const second = await r.restart().for(r.peer, '/work/widgets')

  assert.equal(second.brief.version, first.brief.version + 1)
  assert.notEqual(second.brief.briefId, first.brief.briefId)
  assert.notEqual(second.brief.text, first.brief.text, 'the digest in the text moves, so the text is a new brief’s')
  const events = standardsEvents(r.appended)
  assert.equal(events.length, 2)
  assert.notEqual(events[1]?.data.digest, events[0]?.data.digest)
  assert.equal(events[1]?.data.version, 2)
})

test('the version goes above what a Work’s brief has already raised the peer to', async () => {
  const r = await rig()
  await r.standing.for(r.peer, '/work/widgets')
  r.setCarried(5)
  r.repo.set('AGENTS.md', 'changed')

  assert.equal((await r.restart().for(r.peer, '/work/widgets')).brief.version, 6)
})

test('a changed role is a changed brief even when the standards are the same', async () => {
  const r = await rig()
  const first = await r.standing.for(r.peer, '/work/widgets')
  const renamed = { ...r.peer, role: 'architect' } as PeerProfile
  const second = await r.restart().for(renamed, '/work/widgets')

  assert.equal(second.brief.version, first.brief.version + 1)
  assert.match(second.brief.text, /the architect\./)
})

test('a missing AGENTS.md or CLAUDE.md is skipped and recorded, and the peer still starts', async () => {
  const r = await rig(undefined, { 'AGENTS.md': 'Run pnpm test.' })
  const got = await r.standing.for(r.peer, '/work/widgets')

  assert.ok(got.systemPromptAppend?.includes('Run pnpm test.'))
  const [event] = standardsEvents(r.appended)
  assert.deepEqual((event?.data.skipped as readonly { name: string }[]).map((skipped) => skipped.name), ['CLAUDE.md'])
})

test('with no repo standards at all the peer still starts, and the log says "none loaded" rather than saying nothing', async () => {
  const r = await rig(undefined, {})
  const got = await r.standing.for(r.peer, '/work/widgets')

  assert.equal(got.systemPromptAppend, undefined)
  assert.match(got.brief.text, /^You are engineer-1, the engineer\./)
  assert.doesNotMatch(got.brief.text, /standards/)
  const [event] = standardsEvents(r.appended)
  assert.deepEqual(event?.data.sources, [])
  assert.deepEqual((event?.data.skipped as readonly { name: string }[]).map((skipped) => skipped.name), ['AGENTS.md', 'CLAUDE.md'])
  assert.equal(event?.data.version, 1)
})

test('a declared non-negotiables doc that is missing refuses the peer, naming the key, the file and the fix, and writes nothing', async () => {
  const r = await rig({ nonNegotiables: 'no-such-file.md' })

  await assert.rejects(r.standing.for(r.peer, '/work/widgets'), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'not_found')
    assert.ok(error.message.includes('standards.nonNegotiables'))
    assert.ok(error.message.includes(join(r.profileDir, 'no-such-file.md')))
    assert.match(error.message, /create it, or remove standards\.nonNegotiables from /)
    return true
  })
  assert.deepEqual(r.appended, [])
})

test('a non-negotiables doc over the cap refuses the peer instead of cutting its last rules', async () => {
  const r = await rig({ nonNegotiables: 'long.md' })
  await writeFile(join(r.profileDir, 'long.md'), `${'rule\n'.repeat(MAX_SOURCE_CHARS / 4)}`)

  await assert.rejects(r.standing.for(r.peer, '/work/widgets'), /Non-negotiables \(long\.md\) is \d+ characters.*never cut/s)
  assert.deepEqual(r.appended, [])
})

test('the non-negotiables path is the profile’s own: absolute, or relative to the profile’s directory — never the repo', async () => {
  const r = await rig({ nonNegotiables: 'rules.md' })
  await writeFile(join(r.profileDir, 'rules.md'), 'from the profile directory')
  // A file of the same name in the repo must not be the one used.
  r.repo.set('rules.md', 'from the repo')
  assert.ok((await r.standing.for(r.peer, '/work/widgets')).systemPromptAppend?.includes('from the profile directory'))

  const absolute = join(r.profileDir, 'elsewhere', 'abs.md')
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, 'by absolute path')
  const viaAbsolute = await rig({ nonNegotiables: absolute })
  assert.ok((await viaAbsolute.standing.for(viaAbsolute.peer, '/work/widgets')).systemPromptAppend?.includes('by absolute path'))
})

test('a role’s skill documents are inlined, and only that role’s', async () => {
  const r = await rig({ skills: { engineer: ['skills/tdd.md'], architect: ['skills/review.md'] } })
  await mkdir(join(r.profileDir, 'skills'), { recursive: true })
  await writeFile(join(r.profileDir, 'skills/tdd.md'), 'Write the failing test first.')
  await writeFile(join(r.profileDir, 'skills/review.md'), 'Review the contract.')

  const text = (await r.standing.for(r.peer, '/work/widgets')).systemPromptAppend ?? ''
  assert.ok(text.includes('<document name="skill:skills/tdd.md">'))
  assert.ok(text.includes('Write the failing test first.'))
  assert.ok(!text.includes('Review the contract.'))

  const missing = await rig({ skills: { engineer: ['skills/absent.md'] } })
  await assert.rejects(missing.standing.for(missing.peer, '/work/widgets'), /standards\.skills\.engineer names .*absent\.md.*cannot be read/s)
})

test('a repo file over the cap is cut with a marker, and the event says it was', async () => {
  const r = await rig(undefined, { 'AGENTS.md': 'x'.repeat(MAX_SOURCE_CHARS + 100) })
  const got = await r.standing.for(r.peer, '/work/widgets')

  assert.match(got.systemPromptAppend ?? '', /\[truncated: AGENTS\.md is 16100 characters/)
  const [event] = standardsEvents(r.appended)
  assert.deepEqual((event?.data.sources as readonly { truncated: boolean }[]).map((source) => source.truncated), [true])
})

test('a profile without a standards block is valid, so an existing profile and the starter come up unchanged', () => {
  assert.equal(profileOf().standards, undefined)
})
