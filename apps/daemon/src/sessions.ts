/**
 * The peer-session pump (§2, §4, §7, §8): the daemon half of `runtime/supervisor`.
 *
 * The supervisor package owns *a session* — the event pump, the purge protocol,
 * the state file. This file owns *the fleet's sessions*: which peer gets which
 * provider, how a `SessionSpec` is built from the profile, where the store's
 * `record` and the filesystem's `writeFile` come from, and what `PeerSessions`
 * answers when the Mailbox asks to reach a peer.
 *
 * It is also the only thing here that knows a provider by name. Everything
 * below takes a `Provider` it was handed; `compose.ts` is what constructs them.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import {
  err,
  fleetError,
  newBriefId,
  ok,
  systemClock,
  type Clock,
  type FleetError,
  type PeerId,
  type Result,
  type SessionId,
  type TurnId,
} from '@fleet/foundation-core'
import type {
  BriefHandoff,
  PeerSessionLease,
  PeerSessions,
  SessionSpec,
  StateFile,
  Turn,
} from '@fleet/foundation-contracts'
import type { EventStore } from '@fleet/foundation-store'
import type { Provider, SessionHandle } from '@fleet/runtime-provider-sdk'
import {
  PeerSession,
  mechanicalStateFile,
  selfPurge,
  type MechanicalFacts,
  type PurgeLimits,
  type SessionRecord,
} from '@fleet/runtime-supervisor'

import type { PeerProfile, Profile } from './profile.ts'
import type { ProfilePaths } from './paths.ts'

/**
 * §8's purge thresholds. A profile names the ones it cares about; the rest come
 * from the model's own limits where they are known (§4 says the window is
 * config, never the SDK's guess), and these defaults are the conservative floor.
 */
export const defaultPurgeLimits: PurgeLimits = Object.freeze({
  contextRatio: 0.8,
  maxTurns: 400,
  maxSessionMillis: 6 * 60 * 60 * 1000,
})

/** What the pump needs that only the composition root can supply. */
export interface SupervisorDeps {
  readonly profile: Profile
  readonly paths: ProfilePaths
  readonly store: EventStore
  /** Concrete providers, by the profile's `provider` name. Built in `compose.ts`, never here. */
  readonly providers: ReadonlyMap<string, Provider>
  readonly clock?: Clock
  /**
   * The brief a peer starts against (§7, §12). `orchestration/briefs` is not on
   * main yet, so the default is the profile's role statement at version 1: a
   * session always starts from *a* brief, and swapping the source later changes
   * this one function rather than the pump.
   */
  readonly briefFor?: (peer: PeerProfile) => BriefHandoff
  /** Where the page reports what it cannot do, so a failed session is visible rather than silent. */
  readonly onError?: (peer: PeerId, error: unknown) => void
}

/** One peer's running session, and the handle the Mailbox sends through. */
interface Running {
  readonly handle: SessionHandle
  readonly session: PeerSession
  readonly peer: PeerProfile
}

/**
 * The fleet's sessions: `PeerSessions` for the Mailbox (§7), `BriefVersions`
 * for it too, and start/stop for the daemon's own `up`/`down` (§2).
 */
export interface Supervisor extends PeerSessions {
  readonly briefs: { current(peerId: PeerId): Promise<number | undefined> }
  /** Start every peer the profile names. Idempotent: a peer already running is left alone. */
  start(): Promise<void>
  /** Stop every session, newest first, and wait for the pumps to settle. */
  stop(): Promise<void>
  /** The peers that are running, for `ls` and for the tests. */
  running(): readonly PeerId[]
}

const envFor = (peer: PeerProfile): Readonly<Record<string, string>> => ({
  // The peer's own identity on the line, so a transcript says which peer wrote it.
  FLEET_PEER: String(peer.id),
  FLEET_ROLE: peer.role,
})

/**
 * The default brief: the role the profile gave the peer, said plainly. It is a
 * real `BriefHandoff` — versioned, with the contract versions it was written
 * against (none yet) — because a session that starts from an unversioned
 * string is a session the Mailbox cannot judge a stale reply against (§7).
 */
export const roleBrief = (peer: PeerProfile, id = newBriefId()): BriefHandoff => ({
  briefId: id,
  version: 1,
  contractVersions: [],
  text: `You are ${String(peer.id)}, the ${peer.role}. Follow the fleet's protocol: work in your own worktree, open PRs, and report through the mailbox.`,
})

export const createSupervisor = (deps: SupervisorDeps): Supervisor => {
  const clock = deps.clock ?? systemClock
  const onError = deps.onError ?? (() => {})
  /** One brief per peer, minted once: a peer's brief does not change id mid-flight (§12). */
  const briefs = new Map<PeerId, BriefHandoff>()
  const briefFor = (peer: PeerProfile): BriefHandoff => {
    if (deps.briefFor !== undefined) return deps.briefFor(peer)
    const existing = briefs.get(peer.id)
    if (existing !== undefined) return existing
    const minted = roleBrief(peer)
    briefs.set(peer.id, minted)
    return minted
  }

  const sessions = new Map<PeerId, Running>()
  const pumps = new Map<PeerId, Promise<void>>()

  const stateFilePath = (peerId: PeerId): string => deps.paths.peersDir + '/' + String(peerId) + '/state.md'

  const record = async (event: SessionRecord): Promise<void> => {
    await deps.store.append([event])
  }

  /** Start one session from the profile and hand it to the supervisor's pump. */
  const startPeer = async (peer: PeerProfile): Promise<Running> => {
    const provider = deps.providers.get(peer.provider)
    if (provider === undefined) {
      throw fleetError('unsupported', `no provider is wired for '${peer.provider}'`, {
        details: { provider: peer.provider, wired: [...deps.providers.keys()] },
      })
    }

    const brief = briefFor(peer)
    const spec: SessionSpec = {
      peerId: peer.id,
      role: peer.role,
      cwd: deps.paths.stateDir,
      model: peer.model,
      permissionMode: peer.permissionMode ?? 'default',
      env: envFor(peer),
      brief,
    }
    const handle = await provider.start(spec)

    const session = new PeerSession({
      provider,
      handle,
      peerId: peer.id,
      briefVersion: brief.version,
      limits: defaultPurgeLimits,
      clock,
      record,
      purge: async (input) =>
        selfPurge({
          provider,
          handle: input.handle,
          peerId: peer.id,
          briefVersion: input.briefVersion,
          ask: input.ask,
          stateFileText: async () => {
            try {
              return await readFile(stateFilePath(peer.id), 'utf8')
            } catch {
              return undefined
            }
          },
          restart: async (stateFile: StateFile) => {
            // §8: the fresh session starts from role + the same brief + the state
            // file. The Mailbox replays anything newer, which is why this reports
            // zero: nothing was measured here, so nothing is claimed.
            const fresh = await provider.start({ ...spec, stateFile })
            return { handle: fresh, replayedMessages: 0 }
          },
          facts: (): MechanicalFacts => ({
            peerId: peer.id,
            briefVersion: brief.version,
            goal: peer.role,
            assignedWork: [],
            prs: [],
          }),
          record,
          writeFile: async (path, text) => {
            await mkdir(dirname(path), { recursive: true })
            await writeFile(path, text, 'utf8')
          },
          stateFilePath,
          clock,
        }),
      recover: async (from, _failure, stateFile) => {
        await provider.stop(from).catch(() => {})
        // A recovery that cannot start a session propagates: §8 says a peer with
        // no session must be visible, not silently idle.
        return provider.start(stateFile === undefined ? spec : { ...spec, stateFile })
      },
    })

    const running: Running = { handle, session, peer }
    sessions.set(peer.id, running)
    pumps.set(
      peer.id,
      session.run().catch((error: unknown) => {
        onError(peer.id, error)
      }),
    )
    return running
  }

  const supervisor: Supervisor = {
    briefs: {
      async current(peerId) {
        const running = sessions.get(peerId)
        return running === undefined ? undefined : briefFor(running.peer).version
      },
    },

    /**
     * §7: resume-then-deliver in one call. A peer with no session is a typed
     * `not_found`, never a throw — the Mailbox turns that into a delivery
     * failure the user can see.
     */
    async acquire(peerId: PeerId): Promise<Result<PeerSessionLease, FleetError>> {
      const running = sessions.get(peerId)
      if (running === undefined) {
        return err(fleetError('not_found', `peer ${String(peerId)} has no running session`, { details: { peerId: String(peerId) } }))
      }
      return ok({
        sessionId: String(running.handle.sessionId) as SessionId,
        resumed: false,
        send: (turn: Turn): Promise<TurnId> => running.session.deliver(turn),
      })
    },

    async start() {
      for (const peer of deps.profile.peers) {
        if (sessions.has(peer.id)) continue
        await startPeer(peer)
      }
    },

    async stop() {
      const running = [...sessions.values()]
      sessions.clear()
      for (const peer of running) {
        await peer.session.stop().catch((error: unknown) => onError(peer.peer.id, error))
      }
      // The pumps resolve once their session ends; wait so `down` means stopped.
      await Promise.allSettled([...pumps.values()])
      pumps.clear()
    },

    running() {
      return [...sessions.keys()]
    },
  }

  return supervisor
}

/** Where a peer's state file lives, exported so the CLI and the tests agree with the pump (§1.1). */
export const stateFilePathOf = (paths: ProfilePaths, peerId: PeerId): string =>
  paths.peersDir + '/' + String(peerId) + '/state.md'
