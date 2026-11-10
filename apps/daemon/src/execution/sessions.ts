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
  newWorktreeId,
  peerActor,
  ok,
  systemClock,
  type Clock,
  type FleetError,
  type ProfilePaths,
  type PeerId,
  type Repo,
  type Result,
  type SessionId,
  type TurnId,
} from '@fleet/foundation-core'
import type {
  BriefHandoff,
  EventSink,
  PeerSessionLease,
  PeerSessions,
  ReadModel,
  SessionSpec,
  StateFile,
  WorktreeProvisioner,
  Turn,
} from '@fleet/foundation-contracts'
import type { Provider } from '@fleet/runtime-provider-sdk'
import {
  PeerSession,
  mechanicalStateFile,
  selfPurge,
  sessionIdOf,
  type MechanicalFacts,
  type SessionRecord,
} from '@fleet/runtime-supervisor'

import { effortFor, modelFor, purgeLimitsOf, type PeerProfile, type Profile } from '../config/profile.ts'
import { roleStatement, type StandingBriefs } from './standards.ts'

/** What the pump needs that only the composition root can supply. */
export interface SupervisorDeps {
  readonly profile: Profile
  readonly paths: ProfilePaths
  /**
   * Read side of the store, for the Worktree rows: a peer starts in the active
   * worktree it owns (§9). Absent, a peer starts in its repo's profile checkout.
   */
  readonly read?: Pick<ReadModel, 'worktrees'>
  /**
   * §9's creator. A peer that can write and owns no worktree is given one, under
   * its repo's checkout, so engineers each work in their own tree and the
   * shared-checkout guard is only what is left for a fleet that wires none.
   */
  readonly worktrees?: WorktreeProvisioner
  /**
   * §12.1: the standards a peer works under, as a versioned brief and the text for
   * `systemPromptAppend`. Absent, or when a peer has none, the peer starts on the
   * plain role brief.
   */
  readonly standing?: StandingBriefs
  /** The append-only sink, waking as it goes (§5.2): this is where `session.started` comes from. */
  readonly store: EventSink
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
  /**
   * The env a peer's provider needs on top of its identity — an endpoint and a
   * key, for a provider that has one. Built in `compose.ts` from the profile and
   * asked for at each session start, so the key is read then and not at boot.
   *
   * Absent, a peer's env is only its identity, which is what a provider that
   * inherits its credentials can run on.
   */
  readonly providerEnv?: (peer: PeerProfile) => Promise<Readonly<Record<string, string>>>
  /** Where the page reports what it cannot do, so a failed session is visible rather than silent. */
  readonly onError?: (peer: PeerId, error: unknown) => void
}

/**
 * One peer's running session, and the pump the Mailbox sends through.
 *
 * No handle is kept here. The one `provider.start` returned goes stale as soon
 * as the pump recovers or purges: `PeerSession` swaps its own handle under
 * `run()`, and a copy in this map would go on naming the session that ended.
 * Everything that needs a handle asks the session, which is what `acquire` does.
 */
interface Running {
  /** The brief this session carries; a purge restart reuses it (§8), so it is what `briefs.current` reports. */
  readonly brief: BriefHandoff
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

/**
 * A peer's env: its identity and the fleet facts a peer process needs to talk
 * back, plus whatever its provider needs to reach its endpoint. The fleet facts
 * are this file's business; the rest is a fragment built by the composition
 * root, because an endpoint and a key belong to a provider this file must not
 * know by name (§2).
 *
 * Three of these are exactly what §6.2's Stop hook reads, and provisioning only
 * `FLEET_PEER` is why it reported nothing: it skips, with a reason, unless the
 * env also names the socket and the model's window
 * (`apps/hooks/usage-report/src/report.ts`). `FLEET_WORK_ID` is the hook's
 * fourth input and stays out on purpose — a session is started for a peer, and
 * the Work a peer is on changes turn by turn (§8).
 *
 * Built at **every** start, including a resume, so a rotated key is picked up
 * without restarting the daemon.
 */
const envFor = async (peer: PeerProfile, deps: SupervisorDeps): Promise<Readonly<Record<string, string>>> => {
  const limit = deps.providers.get(peer.provider)?.contextLimit?.(modelFor(deps.profile, peer))
  return {
    // The peer's own identity on the line, so a transcript says which peer wrote it.
    FLEET_PEER: String(peer.id),
    FLEET_ROLE: peer.role,
    // §2: the daemon this peer belongs to. A peer's own `fleet send` resolves it
    // from here before it looks at any directory it happens to stand in.
    FLEET_SOCKET: deps.paths.socketPath,
    // Absent when the provider knows no window for this model: the hook then
    // skips rather than reporting against a number nobody configured (§8).
    ...(limit === undefined ? {} : { FLEET_CONTEXT_LIMIT: String(limit) }),
    ...(deps.providerEnv === undefined ? {} : await deps.providerEnv(peer)),
  }
}

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
  text: roleStatement(peer),
})

/** A peer that is not in plan mode can change files (§13); `default` is the omitted mode. */
const canWrite = (peer: PeerProfile): boolean => (peer.permissionMode ?? 'default') !== 'plan'

const sameDir = (a: string | undefined, b: string): boolean =>
  a !== undefined && a.replace(/\/+$/, '') === b.replace(/\/+$/, '')

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
  /** Where each running peer's session was started, for the shared-checkout guard. */
  const workdirs = new Map<PeerId, string>()
  const pumps = new Map<PeerId, Promise<void>>()

  const stateFilePath = (peerId: PeerId): string => deps.paths.peersDir + '/' + String(peerId) + '/state.md'

  const record = async (event: SessionRecord): Promise<void> => {
    await deps.store.append([event])
  }

  /**
   * §9: a writing peer with no worktree of its own gets one, made under its repo's
   * checkout and recorded with the peer as owner. A peer that only reads keeps the
   * shared checkout (it cannot switch anything under anyone), and a fleet with no
   * provisioner falls through to the checkout and the guard.
   */
  const provisionFor = async (
    peer: PeerProfile,
    repo: string | undefined,
    checkout: string | undefined,
  ): Promise<string | undefined> => {
    if (deps.worktrees === undefined || repo === undefined || checkout === undefined || !canWrite(peer)) return undefined
    const topic = `peer-${String(peer.id)}`
    const made = await deps.worktrees.ensure({ root: checkout, topic, branch: `peer/${String(peer.id)}` })
    await deps.store.append([
      {
        type: 'worktree.created',
        ts: clock.now(),
        subject: repo,
        actor: 'pm',
        data: {
          worktreeId: newWorktreeId(),
          repo: repo as Repo,
          branch: `peer/${String(peer.id)}`,
          path: made.path,
          ownerPeerId: peer.id,
          class: 'active',
        },
      },
    ])
    return made.path
  }

  /**
   * Where this peer's session runs: the active worktree it owns, else its
   * repo's checkout — never the fleet's state directory, which holds the store
   * and the socket and none of the repo's instructions. Asked at every start,
   * a resume and a purge restart included, because a Worktree row can appear or
   * go between sessions.
   *
   * A peer that can write must not share a checkout with another that can:
   * two of them switch each other's branch. A plan-mode peer only reads, so it
   * may share. Refused with the other peer's name, not started anyway.
   */
  const workdirFor = async (peer: PeerProfile): Promise<string> => {
    const owned = (await deps.read?.worktrees.all())?.find(
      (worktree) => worktree.ownerPeerId === peer.id && worktree.class === 'active',
    )
    const repo = peer.repo ?? deps.profile.repos[0]
    const checkout = repo === undefined ? undefined : deps.profile.checkouts?.[repo]
    const path = owned?.path ?? (await provisionFor(peer, repo, checkout)) ?? checkout
    if (path === undefined) {
      throw fleetError(
        'config_mismatch',
        `peer ${String(peer.id)} has no worktree and no checkout: add checkouts.${repo ?? '<repo>'} (an absolute path) to the profile`,
        { details: { peerId: String(peer.id), repo } },
      )
    }
    if (canWrite(peer)) {
      for (const [otherId, other] of sessions) {
        if (otherId === peer.id || !canWrite(other.peer)) continue
        if (sameDir(workdirs.get(otherId), path)) {
          throw fleetError(
            'conflict',
            `peer ${String(peer.id)} would share ${path} with ${String(otherId)}, and both can write: give one its own worktree or checkout`,
            { details: { peerId: String(peer.id), otherPeerId: String(otherId), path } },
          )
        }
      }
    }
    workdirs.set(peer.id, path)
    return path
  }

  /** Start one session from the profile and hand it to the supervisor's pump. */
  const startPeer = async (peer: PeerProfile): Promise<Running> => {
    const provider = deps.providers.get(peer.provider)
    if (provider === undefined) {
      throw fleetError('unsupported', `no provider is wired for '${peer.provider}'`, {
        details: { provider: peer.provider, wired: [...deps.providers.keys()] },
      })
    }

    const cwd = await workdirFor(peer)
    // Before the session exists, so a standards event (§12.1) is in the log
    // before the session that carries it, and a refusal stops the peer here.
    const standing = await deps.standing?.for(peer, cwd)
    const brief = standing?.brief ?? briefFor(peer)
    // Resolved, not copied: a peer that names only a role takes the role's model
    // and effort (TASK-12's precedence peer > role > refuse).
    const effort = effortFor(deps.profile, peer)
    const spec: SessionSpec = {
      peerId: peer.id,
      role: peer.role,
      cwd,
      model: modelFor(deps.profile, peer),
      ...(effort === undefined ? {} : { effort }),
      permissionMode: peer.permissionMode ?? 'default',
      env: await envFor(peer, deps),
      brief,
      ...(standing?.systemPromptAppend === undefined ? {} : { systemPromptAppend: standing.systemPromptAppend }),
    }
    const handle = await provider.start(spec)

    const session = new PeerSession({
      provider,
      handle,
      peerId: peer.id,
      // What the profile asked for, so `session.started` can record the request
      // rather than the provider's silence about whether it honoured it.
      ...(effort === undefined ? {} : { effort }),
      briefVersion: brief.version,
      // §8's thresholds are the profile's, resolved over the supervisor's
      // defaults and validated at load, so this passes what the user asked for
      // rather than a second opinion about what it should have been.
      limits: purgeLimitsOf(deps.profile),
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
            // file, and that is all this does — it does **not** replay the
            // mailbox. Replay is `deliverOnSessionStart`'s (wake.ts): when the
            // replacement's `session.started` commits, the wake hands over every
            // message that is still unacked, including mail that arrived while
            // the purge was running. So nothing is stranded, and nothing was
            // measured here either — this reports zero because it replayed zero,
            // not because there was nothing to replay.
            const fresh = await provider.start({ ...spec, cwd: await workdirFor(peer), stateFile })
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
        const fresh = { ...spec, cwd: await workdirFor(peer) }
        return provider.start(stateFile === undefined ? fresh : { ...fresh, stateFile })
      },
      // §8: a compaction's price is the context the provider had to read again,
      // at the model's published rate. A peer with no `pricing` reports no cost
      // at all rather than a zero that would read as free.
      ...(peer.pricing === undefined
        ? {}
        : {
            estimateCompactionCost: (preTokens: number): number =>
              (preTokens / 1_000_000) * (peer.pricing?.inputUsdPerMillion ?? 0),
          }),
    })

    const running: Running = { brief, session, peer }
    sessions.set(peer.id, running)
    pumps.set(
      peer.id,
      session.run().catch((error: unknown) => {
        onError(peer.id, error)
      }),
    )
    return running
  }

  /** Why a peer did not start, in the log: `reason` is the closed set (§4), the message is the sentence a person reads. */
  const refused = async (peer: PeerProfile, thrown: unknown): Promise<void> => {
    const message = thrown instanceof Error ? thrown.message : String(thrown)
    try {
      await deps.store.append([
        {
          type: 'peer.failed',
          ts: clock.now(),
          subject: String(peer.id),
          actor: peerActor(peer.id),
          data: { peerId: peer.id, reason: 'provider_error', message: message.slice(0, 1000), retryable: false },
        },
      ])
    } catch (error) {
      onError(peer.id, error)
    }
  }

  const supervisor: Supervisor = {
    briefs: {
      async current(peerId) {
        const running = sessions.get(peerId)
        return running?.brief.version
      },
    },

    /**
     * §7: resume-then-deliver in one call. A peer with no session is a typed
     * `not_found`, never a throw — the Mailbox turns that into a delivery
     * failure the user can see.
     *
     * `sessionId` is a getter, not a value read here: the lease outlives the
     * session it was taken on. A purge or a recovery replaces the pump's handle
     * while the Mailbox still holds the lease, and `send` goes to the
     * replacement — so a frozen id would have the Mailbox record the turn
     * against a session that never received it, and its `deliveredSessionId`
     * check would then re-deliver every unacked message on the next pass.
     */
    async acquire(peerId: PeerId): Promise<Result<PeerSessionLease, FleetError>> {
      const running = sessions.get(peerId)
      if (running === undefined) {
        return err(fleetError('not_found', `peer ${String(peerId)} has no running session`, { details: { peerId: String(peerId) } }))
      }
      return ok({
        get sessionId(): SessionId {
          return sessionIdOf(running.session.handle)
        },
        resumed: false,
        send: (turn: Turn): Promise<TurnId> => running.session.deliver(turn),
      })
    },

    async start() {
      // Every peer is tried: one that is refused (no checkout, a standards document
      // that cannot be read, a provider that will not start) must not leave the ones
      // after it unstarted. Each refusal is written as `peer.failed`, which is what
      // `fleet ls` and the board show — a thrown error alone reaches only whoever ran
      // `up`. The first is still thrown at the end, so `up` itself fails loudly.
      let first: unknown
      for (const peer of deps.profile.peers) {
        if (sessions.has(peer.id)) continue
        try {
          await startPeer(peer)
        } catch (thrown) {
          first ??= thrown
          await refused(peer, thrown)
        }
      }
      if (first !== undefined) throw first
    },

    async stop() {
      const running = [...sessions.values()]
      sessions.clear()
      workdirs.clear()
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
