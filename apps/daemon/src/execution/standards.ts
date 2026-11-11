/**
 * A peer's standing brief, with the standards it works under (§12.1, §4).
 *
 * The claude provider runs with `settingSources: []`, so a peer never reads the
 * repo's `AGENTS.md`, `CLAUDE.md` or the fleet's non-negotiables on its own, and
 * turning `user` settings on instead would leak hooks and env into it. So this
 * file reads them and hands them over in `SessionSpec.systemPromptAppend`.
 *
 * **Where from.** The repo's files are read from its default branch's commit
 * (`RepoFiles`), not from a working tree: until a peer has a worktree of its own
 * its cwd is the checkout, and a peer that could edit its own rules would be
 * judged against what it wrote. The profile's own documents are read from disk,
 * relative to the directory the profile file is in.
 *
 * **A change is a new Brief, and it is an event.** `peer.standards_set` is written
 * only when the digest of what the peer would be handed differs from the last one
 * recorded, *before* the session that carries it starts, so the store (whose
 * `peer.briefVersion` the Mailbox judges mail against) and the session agree. The
 * version goes up on the per-peer counter a Work's brief also moves. The bytes go
 * to a content-addressed file first — a cache and an archive, never the truth —
 * and the event records what was read and what could not be, so a filesystem read
 * is replayable and a peer without its repo's standards is visible, not quiet.
 *
 * Read when a session starts and kept for it: §8 restarts a purged peer on *the
 * same brief*, so an edited standard reaches a peer at its next start.
 *
 * **Fail closed where the profile asked.** A declared document that cannot be
 * read, or any over its cap, refuses the peer with the key and the fix. A repo
 * file that is not on the default branch is recorded as skipped and the peer
 * starts: the repo may have none, and refusing would make the fleet unusable on a
 * fresh clone.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

import { deriveId, fleetError, systemClock, type BriefId, type Clock, type ProfilePaths } from '@fleet/foundation-core'
import type { BriefHandoff, EventSink, FleetEvent, ReadModel, RepoFiles } from '@fleet/foundation-contracts'
import { buildStandards, standardsLine, type StandardsSource } from '@fleet/orchestration-briefs'

import type { PeerProfile, Profile } from '../config/profile.ts'

/** The role the profile gave the peer, said plainly: the brief's first sentence, with or without standards. */
export const roleStatement = (peer: PeerProfile): string =>
  `You are ${String(peer.id)}, the ${peer.role}. Follow the fleet's protocol: work in your own worktree, open PRs, and report through the mailbox.`

export interface StandingBrief {
  readonly brief: BriefHandoff
  /** The standards, for `SessionSpec.systemPromptAppend`; absent when there are none. */
  readonly systemPromptAppend?: string
}

export interface StandingBriefs {
  /**
   * The brief this peer starts a session against, with `cwd` the repository to read
   * its files from. Always one: a peer with no standards at all still gets the event
   * that says so (`skipped`), so the board shows "no repo standards loaded" instead
   * of a peer quietly working without them.
   */
  for(peer: PeerProfile, cwd: string): Promise<StandingBrief>
}

export interface StandingBriefsDeps {
  readonly profile: Profile
  readonly paths: ProfilePaths
  readonly repoFiles: RepoFiles
  /** The newest event of a type about a subject: `EventStore.latest`. */
  readonly events: { latest(type: FleetEvent['type'], subject: string): Promise<FleetEvent | undefined> }
  /** The peer row, for the version floor a Work's brief may already have raised. */
  readonly read: Pick<ReadModel, 'peers'>
  /** The waking append (§5.2), like every other event the daemon writes. */
  readonly append: EventSink['append']
  readonly clock?: Clock
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

const REPO_FILES = ['AGENTS.md', 'CLAUDE.md'] as const

export const createStandingBriefs = (deps: StandingBriefsDeps): StandingBriefs => {
  const clock = deps.clock ?? systemClock
  const profileDir = dirname(deps.paths.profileFile)

  /** A document the profile named: required, so a failure to read it names the key and the fix. */
  const declared = async (key: string, name: string, declaredPath: string): Promise<StandardsSource> => {
    const file = isAbsolute(declaredPath) ? declaredPath : join(profileDir, declaredPath)
    try {
      // Empty is refused by the builder, which knows the document is a declared one.
      return { name, text: await readFile(file, 'utf8'), mode: 'refuse' }
    } catch (thrown) {
      throw fleetError(
        'not_found',
        `${key} names ${file}, which cannot be read (${thrown instanceof Error ? thrown.message : String(thrown)}): ` +
          `create it, or remove ${key} from ${deps.paths.profileFile}`,
        { details: { key, file }, cause: thrown },
      )
    }
  }

  return {
    async for(peer, cwd) {
      const sources: StandardsSource[] = []
      const skipped: { name: string; reason: string }[] = []

      const nonNegotiables = deps.profile.standards?.nonNegotiables
      if (nonNegotiables !== undefined) {
        sources.push(await declared('standards.nonNegotiables', `Non-negotiables (${nonNegotiables})`, nonNegotiables))
      }
      for (const path of deps.profile.standards?.skills?.[peer.role] ?? []) {
        sources.push(await declared(`standards.skills.${peer.role}`, `skill:${path}`, path))
      }
      for (const name of REPO_FILES) {
        const found = await deps.repoFiles.read(cwd, name)
        if (found === undefined) {
          skipped.push({ name, reason: "not on the repository's default branch (no origin default branch, or no such file there)" })
        } else {
          sources.push({ name, text: found.text, mode: 'truncate', ref: found.ref })
        }
      }

      const standards = buildStandards({ sources })
      // What the peer is handed, whole: a changed role is a changed brief too. One
      // digest, the event's, which the brief's own line shows.
      const digest = sha(`${roleStatement(peer)}\n\u0000\n${standards.text}`)
      const text = standards.text === '' ? roleStatement(peer) : `${roleStatement(peer)}\n\n${standardsLine(digest)}`
      const systemPromptAppend = standards.text === '' ? undefined : standards.text

      const peerId = String(peer.id)
      const last = await deps.events.latest('peer.standards_set', peerId)
      const lastData = last?.type === 'peer.standards_set' ? last.data : undefined

      if (lastData?.digest === digest) {
        return {
          brief: { briefId: lastData.briefId, version: lastData.version, contractVersions: [], text },
          ...(systemPromptAppend === undefined ? {} : { systemPromptAppend }),
        }
      }

      // The floor is the peer's own counter, which a Work's brief may have raised
      // past the last standards version: a version only goes up (§12.1).
      const floor = Math.max((await deps.read.peers.get(peer.id))?.briefVersion ?? 0, lastData?.version ?? 0)
      const version = floor + 1
      const briefId = deriveId('brf', { peerId, standards: version }) as BriefId

      // The bytes first, then the event that names them: an event never points at
      // a file that is not there. Named by digest, so a rewrite is the same bytes.
      const archive = join(deps.paths.artifactsDir, 'standards', `${digest}.md`)
      await mkdir(dirname(archive), { recursive: true })
      await writeFile(archive, `${text}\n${standards.text === '' ? '' : `\n---\n\n${standards.text}`}`, 'utf8')

      await deps.append([
        {
          type: 'peer.standards_set',
          ts: clock.now(),
          subject: peerId,
          actor: 'pm',
          data: { peerId: peer.id, version, briefId, digest, sources: standards.sources, skipped },
        },
      ])

      return {
        brief: { briefId, version, contractVersions: [], text },
        ...(systemPromptAppend === undefined ? {} : { systemPromptAppend }),
      }
    },
  }
}
