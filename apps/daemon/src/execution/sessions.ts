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
  isParked,
  newBriefId,
  newWorktreeId,
  peerActor,
  ok,
  systemClock,
  type Clock,
  type DecisionId,
  type FleetError,
  type ProfilePaths,
  type PeerId,
  type Repo,
  type Actor,
  type ProviderSessionRef,
  type Result,
  type SessionId,
  type TurnId,
} from '@fleet/foundation-core'
import type {
  BriefHandoff,
  DisplayLine,
  EventSink,
  PeerHoldResult,
  PeerResumeResult,
  PeerStopResult,
  PeerSessionLease,
  PeerSessions,
  ReadModel,
  SessionSpec,
  Work,
  StateFile,
  WorktreeProvisioner,
  Turn,
} from '@fleet/foundation-contracts'
import { buildChildEnv, type Provider, type SessionHandle } from '@fleet/runtime-provider-sdk'
import {
  PeerSession,
  mechanicalStateFile,
  readStateFile,
  selfPurge,
  sessionIdOf,
  type BookkeepingFailure,
  type MechanicalFacts,
  type SessionRecord,
} from '@fleet/runtime-supervisor'

import { effortFor, modelFor, purgeLimitsOf, type PeerProfile, type Profile } from '../config/profile.ts'
import { toolPolicyFor } from '../config/tool-policy.ts'
import { heldWorksOf } from './held-work.ts'
import { roleStatement, type StandingBriefs } from './standards.ts'

/** What the pump needs that only the composition root can supply. */
export interface SupervisorDeps {
  readonly profile: Profile
  readonly paths: ProfilePaths
  /**
   * Read side of the store, for the Worktree rows: a peer starts in the active
   * worktree it owns (§9). Absent, a peer starts in its repo's profile checkout.
   */
  readonly read?: Pick<ReadModel, 'worktrees'> & Partial<Pick<ReadModel, 'peers' | 'sessions' | 'messages' | 'work'>>
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
  /**
   * Where a provider's display lines go (watch-and-attach §6): `fleet watch` reads
   * them back out. Absent, or for a provider with no `display`, a peer shows status
   * only. Display data is never stored, and nothing in the session depends on it.
   */
  readonly display?: { push(peerId: PeerId, line: DisplayLine): void }
  /** Where the page reports what it cannot do, so a failed session is visible rather than silent. */
  readonly onError?: (peer: PeerId, error: unknown) => void
  /**
   * Where a bookkeeping append the store refused is reported (TASK-57). Kept apart
   * from `onError` on purpose: `onError` is about a session that failed, and this
   * is about one that stayed alive while a row about it was lost. `compose.ts` wires
   * it to the daemon log.
   */
  readonly onBookkeepingFailure?: (failure: BookkeepingFailure) => void
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
  /**
   * Hand one peer's session to a person (watch-and-attach §4): stop it at the
   * next turn boundary — interrupting the turn first when `now` — and record it
   * held. A held peer is not run, delivered to, recovered or assigned. Asked
   * again while held, it answers the same.
   *
   * `signal` is the request's: when it aborts while the hold waits for the turn to
   * end, the hold is dropped and the session goes back to running as it was, so a
   * client that died cannot leave a peer half-taken (and `down` cannot hang on it).
   */
  hold(peerId: PeerId, options: { readonly now?: boolean; readonly by: Actor; readonly signal?: AbortSignal }): Promise<PeerHoldResult>
  /** Resume a held peer's session with a handback note, or start it fresh when that fails (§4). */
  release(peerId: PeerId): Promise<PeerResumeResult>
  /** As `hold`, but nobody owns the session afterwards (§7.2). */
  stopPeer(peerId: PeerId, options: { readonly now?: boolean; readonly by: Actor; readonly signal?: AbortSignal }): Promise<PeerStopResult>
  /** Start a stopped peer: resumed from its ref when it has one, fresh otherwise (§7.2). */
  startPeer(peerId: PeerId): Promise<PeerResumeResult>
  /**
   * Stop the turn a running peer is in and leave its session in place (§7). `false` when
   * there was nothing to stop: no running session, or none mid-turn.
   */
  interrupt(peerId: PeerId): Promise<boolean>
  /**
   * Answer a tool_approval decision by calling the peer's session's answerApproval method.
   * Returns false if the session no longer has the approval open (answered, abandoned, or session gone).
   */
  answerApproval(decisionId: DecisionId, peerId: PeerId, decision: 'allow' | 'deny'): Promise<boolean>
  /**
   * Answer a peer_question decision by calling the peer's session's `answerQuestion`
   * (TASK-118). Returns false if the session no longer has the question open
   * (answered, abandoned, or the session is gone).
   */
  answerQuestion(decisionId: DecisionId, peerId: PeerId, option: string): Promise<boolean>
}

/** Wait for `until`, or reject when `signal` aborts first; the waited-for promise is left running. */
const untilOrAbort = (until: Promise<void>, signal: AbortSignal | undefined): Promise<void> => {
  if (signal === undefined) return until
  if (signal.aborted) return Promise.reject(cancelled())
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => reject(cancelled())
    signal.addEventListener('abort', onAbort, { once: true })
    until.then(
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

const cancelled = (): Error =>
  fleetError('conflict', 'cancelled: the request that asked for this ended before the turn did')

/** Held by a person, or stopped by one: a peer deliberately not running (§4, §7.2). */
interface Parked {
  readonly kind: 'held' | 'stopped'
  /** What it resumes from; absent for a stopped peer that had no session. */
  readonly ref: ProviderSessionRef | undefined
  readonly since: string
}

/** How a resumed session is told what happened while it was parked (§4): not the brief again. */
export const handbackNote = (kind: 'held' | 'stopped', since: string, until: string, waiting: number): string =>
  [
    kind === 'held'
      ? `A person took this session over from ${since} to ${until} and has handed it back to the fleet.`
      : `This peer was stopped from ${since} to ${until} and has been started again.`,
    kind === 'held'
      ? 'The conversation above includes everything they did. Carry on from where it stands.'
      : 'Carry on from where the conversation stands.',
    waiting === 0
      ? 'No messages arrived for you meanwhile.'
      : `${String(waiting)} message${waiting === 1 ? '' : 's'} arrived for you meanwhile and follow${waiting === 1 ? 's' : ''} this one.`,
  ].join(' ')

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

  /**
   * One session record, as the store hears it. A turn's usage is recorded against the Work the peer is holding
   * (TASK-78): the provider reports the spend and not the Work, and the projection writes a per-Work row only
   * when a Work is named, so an unattributed turn leaves the Work-level cost view empty. A failed lookup records
   * the turn without one; the spend is what must not be lost.
   */
  const record = async (event: SessionRecord): Promise<void> => {
    await deps.store.append([event.type === 'turn.usage_recorded' ? await attributed(event) : event])
  }

  const attributed = async (
    event: Extract<SessionRecord, { type: 'turn.usage_recorded' }>,
  ): Promise<Extract<SessionRecord, { type: 'turn.usage_recorded' }>> => {
    if (event.data.workId !== undefined || deps.read?.work === undefined) return event
    let works: readonly Work[]
    try {
      works = await deps.read.work.all()
    } catch {
      return event
    }
    const [held] = heldWorksOf(works, event.data.peerId)
    return held === undefined ? event : { ...event, data: { ...event.data, workId: held.workId } }
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
      // Every claim, not only the running sessions: a held peer's checkout is one
      // a person is writing in, and a stopped one is a peer's work in progress
      // (watch-and-attach §4).
      for (const [otherId, otherPath] of workdirs) {
        const other = deps.profile.peers.find((candidate) => candidate.id === otherId)
        if (otherId === peer.id || other === undefined || !canWrite(other)) continue
        if (sameDir(otherPath, path)) {
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

  /**
   * Copy one session's display lines into the feed, for as long as the session
   * lives. A display that fails is a view that stops, never a session that does:
   * nothing here is awaited by the peer, and an error is dropped.
   */
  const tapDisplay = (peerId: PeerId, provider: Provider, handle: SessionHandle): void => {
    const sink = deps.display
    if (sink === undefined || provider.display === undefined) return
    const lines = provider.display(handle)
    void (async () => {
      try {
        for await (const line of lines) sink.push(peerId, line)
      } catch {
        // The view loses this session's lines; the session is unaffected.
      }
    })()
  }

  /** Start one session from the profile and hand it to the supervisor's pump. */
  const startPeer = async (
    peer: PeerProfile,
    from?: {
      /** What to resume; absent starts fresh. */
      readonly ref: ProviderSessionRef | undefined
      readonly opening: string
      /** Written once the session exists and before its first record: `peer.released` / `peer.started`. */
      readonly before: (outcome: { readonly resumed: boolean; readonly reason?: string }) => Promise<void>
    },
  ): Promise<Running> => {
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
    // TASK-119: the profile's tool policy, decided against this session's own worktree, so a routine read
    // is not a question. Absent for `ask-all`, which is the behaviour a session had before the block.
    const toolPolicy = toolPolicyFor(deps.profile.toolPolicy, cwd)
    const spec: SessionSpec = {
      peerId: peer.id,
      role: peer.role,
      cwd,
      model: modelFor(deps.profile, peer),
      ...(effort === undefined ? {} : { effort }),
      permissionMode: peer.permissionMode ?? 'default',
      env: await envFor(peer, deps),
      ...(toolPolicy === undefined ? {} : { toolPolicy }),
      brief,
      ...(standing?.systemPromptAppend === undefined ? {} : { systemPromptAppend: standing.systemPromptAppend }),
    }
    let handle: Awaited<ReturnType<Provider['start']>>
    let resumed = false
    let reason: string | undefined
    if (from === undefined) {
      handle = await provider.start(spec)
    } else {
      if (from.ref !== undefined) {
        try {
          handle = await provider.resume(from.ref, { ...spec, opening: from.opening })
          resumed = true
        } catch (thrown) {
          reason = `resume failed: ${thrown instanceof Error ? thrown.message : String(thrown)}`.slice(0, 500)
        }
      } else {
        reason = 'no session to resume'
      }
      // §4 "Resume failing": a fresh start from the state file, as recovery does.
      handle ??= await provider.start(await withStateFile(peer.id, spec))
      await from.before(reason === undefined ? { resumed } : { resumed, reason })
    }

    tapDisplay(peer.id, provider, handle)
    const session = new PeerSession({
      resumed,
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
      // TASK-57: the supervisor keeps the session and hands the refusal here; the
      // daemon's job is only to let it out of the process.
      ...(deps.onBookkeepingFailure === undefined ? {} : { onBookkeepingFailure: deps.onBookkeepingFailure }),
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
            tapDisplay(peer.id, provider, fresh)
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

  /** The spec with the peer's last state file when there is a readable one; the spec alone otherwise. */
  const withStateFile = async (peerId: PeerId, spec: SessionSpec): Promise<SessionSpec> => {
    try {
      const reading = readStateFile(await readFile(stateFilePath(peerId), 'utf8'), peerId)
      return reading.ok ? { ...spec, stateFile: reading.stateFile } : spec
    } catch {
      return spec
    }
  }

  const parked = new Map<PeerId, Parked>()
  /** Peers a hold, stop, release or start is moving right now: a second one waits its turn by being refused. */
  const moving = new Set<PeerId>()
  /** The move each peer is in the middle of, so `stop()` can end the ones still waiting for a turn. */
  const aborts = new Map<PeerId, AbortController>()
  const inflight = new Set<Promise<void>>()
  let restored = false

  const profileOf = (peerId: PeerId): PeerProfile => {
    const peer = deps.profile.peers.find((candidate) => candidate.id === peerId)
    if (peer === undefined) {
      throw fleetError('not_found', `no peer ${String(peerId)} in this profile`, { details: { peerId: String(peerId) } })
    }
    return peer
  }

  const providerOf = (peer: PeerProfile): Provider => {
    const provider = deps.providers.get(peer.provider)
    if (provider === undefined) {
      throw fleetError('unsupported', `no provider is wired for '${peer.provider}'`, { details: { provider: peer.provider } })
    }
    return provider
  }

  const lastRefOf = async (peerId: PeerId): Promise<ProviderSessionRef | undefined> =>
    (await deps.read?.sessions?.forPeer(peerId))?.at(-1)?.providerSessionRef

  /** Mail that will wait for the peer: not yet acked by any session it had (§7, §9). */
  const waitingFor = async (peerId: PeerId): Promise<number> =>
    (await deps.read?.messages?.forPeer(peerId, ['pending', 'delivered']))?.length ?? 0

  /**
   * The parked peers the store remembers (§4: "a daemon that restarts reads it").
   * Read once, before `start()` starts anything, so a restarted daemon never
   * starts a fresh session over a person.
   */
  const restoreParked = async (): Promise<void> => {
    if (restored || deps.read?.peers === undefined) return
    restored = true
    for (const peer of deps.profile.peers) {
      const row = await deps.read.peers.get(peer.id)
      if (row === undefined || !isParked(row.state) || parked.has(peer.id)) continue
      parked.set(peer.id, { kind: row.state === 'held' ? 'held' : 'stopped', ref: await lastRefOf(peer.id), since: row.updatedAt })
    }
  }

  /**
   * Run a hold or a stop as the one move the peer is in. The request's own signal
   * (its connection closing) and the supervisor's (`stop()`) both abort it.
   */
  const move = async <T>(peerId: PeerId, external: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    begin(peerId)
    const controller = new AbortController()
    const relay = (): void => controller.abort()
    if (external?.aborted === true) controller.abort()
    else external?.addEventListener('abort', relay, { once: true })
    aborts.set(peerId, controller)
    const running = run(controller.signal)
    const settled = running.then(
      () => undefined,
      () => undefined,
    )
    inflight.add(settled)
    try {
      return await running
    } finally {
      external?.removeEventListener('abort', relay)
      aborts.delete(peerId)
      moving.delete(peerId)
      inflight.delete(settled)
    }
  }

  const begin = (peerId: PeerId): void => {
    if (moving.has(peerId)) {
      throw fleetError('conflict', `peer ${String(peerId)} is already being held, stopped, released or started`, {
        details: { peerId: String(peerId) },
      })
    }
    moving.add(peerId)
  }

  /**
   * Take a peer out of the fleet's hands (§4, §7.2). It leaves the running map
   * first, so the Mailbox queues for it from here on; then the turn boundary,
   * then the stop. Its workdir claim stays.
   */
  const park = async (
    peer: PeerProfile,
    kind: 'held' | 'stopped',
    options: { readonly now?: boolean; readonly by: Actor; readonly signal?: AbortSignal },
  ): Promise<ProviderSessionRef | undefined> => {
    const running = sessions.get(peer.id)
    let ref: ProviderSessionRef | undefined
    if (running === undefined) {
      ref = await lastRefOf(peer.id)
      if (kind === 'held' && ref === undefined) {
        throw fleetError('not_found', `peer ${String(peer.id)} has no session to take over`, { details: { peerId: String(peer.id) } })
      }
    } else {
      sessions.delete(peer.id)
      if (options.now === true) {
        try {
          await running.session.interrupt()
        } catch (thrown) {
          // The turn could not be stopped, so the boundary this hold waits for
          // may never come (TASK-117: a failed interrupt used to be swallowed
          // and the hold waited forever). The session was never stopped, so it
          // goes back exactly as it was and the hold fails with the reason.
          sessions.set(peer.id, running)
          throw thrown
        }
      }
      try {
        await untilOrAbort(running.session.untilBoundary(), options.signal)
      } catch (thrown) {
        // Nobody is waiting for the hold any more: the session was never stopped,
        // so it goes back to running exactly as it was.
        sessions.set(peer.id, running)
        throw thrown
      }
      // Read after the boundary: a purge on the way to it replaces the session.
      ref = running.session.handle.sessionRef
      await running.session.stop().catch((error: unknown) => onError(peer.id, error))
      await pumps.get(peer.id)
      pumps.delete(peer.id)
    }
    const at = clock.now()
    await deps.store.append([
      kind === 'held'
        ? { type: 'peer.held', ts: at, subject: peer.id, actor: options.by, data: { peerId: peer.id, sessionRef: ref as ProviderSessionRef, by: options.by } }
        : {
            type: 'peer.stopped',
            ts: at,
            subject: peer.id,
            actor: options.by,
            data: { peerId: peer.id, ...(ref === undefined ? {} : { sessionRef: ref }), by: options.by },
          },
    ])
    parked.set(peer.id, { kind, ref, since: at })
    return ref
  }

  /** What a person needs to take a held peer over: built fresh at each ask, so a rotated key is the current one. */
  const holdAnswer = async (peer: PeerProfile, provider: Provider, ref: ProviderSessionRef): Promise<PeerHoldResult> => {
    const cwd = workdirs.get(peer.id) ?? (await workdirFor(peer))
    const effort = effortFor(deps.profile, peer)
    const spec: SessionSpec = {
      peerId: peer.id,
      role: peer.role,
      cwd,
      model: modelFor(deps.profile, peer),
      ...(effort === undefined ? {} : { effort }),
      permissionMode: peer.permissionMode ?? 'default',
      env: await envFor(peer, deps),
      brief: briefFor(peer),
    }
    const command = provider.attachCommand?.(ref, spec)
    if (command === undefined) {
      throw fleetError('unsupported', `provider ${provider.id} has no CLI a person can take a session over in`)
    }
    return {
      peerId: peer.id,
      providerId: provider.id,
      sessionRef: ref,
      cwd,
      model: spec.model,
      // The allowlist the headless session's process gets, and nothing else from fleetd.
      env: buildChildEnv(spec).env,
      command,
      pendingMessages: await waitingFor(peer.id),
    }
  }

  /** Back into the fleet's hands: resume with the handback note, or start fresh and say why (§4, §7.2). */
  const unpark = async (peer: PeerProfile, kind: 'held' | 'stopped'): Promise<PeerResumeResult> => {
    const was = parked.get(peer.id)
    if (was?.kind !== kind) {
      throw fleetError(
        'conflict',
        was === undefined
          ? `peer ${String(peer.id)} is not ${kind}`
          : `peer ${String(peer.id)} is ${was.kind}, not ${kind}: ${was.kind === 'held' ? 'release' : 'start'} it instead`,
        { details: { peerId: String(peer.id), state: was?.kind ?? 'running' } },
      )
    }
    const opening = handbackNote(kind, was.since, clock.now(), await waitingFor(peer.id))
    let outcome: PeerResumeResult = { peerId: peer.id, resumed: false }
    const written = async (result: { readonly resumed: boolean; readonly reason?: string }): Promise<void> => {
      outcome = { peerId: peer.id, ...result }
      const ref = was.ref
      await deps.store.append([
        kind === 'held'
          ? {
              type: 'peer.released',
              ts: clock.now(),
              subject: peer.id,
              actor: 'user',
              data: { peerId: peer.id, sessionRef: ref as ProviderSessionRef, ...result },
            }
          : {
              type: 'peer.started',
              ts: clock.now(),
              subject: peer.id,
              actor: 'user',
              data: { peerId: peer.id, ...(ref === undefined ? {} : { sessionRef: ref }), ...result },
            },
      ])
      parked.delete(peer.id)
    }
    try {
      await startPeer(peer, { ref: was.ref, opening, before: written })
    } catch (thrown) {
      // Neither the resume nor a fresh start came up. The peer is not left parked
      // with nobody holding it (§4): it is failed, visibly, as a refused start is.
      if (parked.has(peer.id)) {
        await written({ resumed: false, reason: `no session could be started: ${thrown instanceof Error ? thrown.message : String(thrown)}`.slice(0, 500) })
      }
      await refused(peer, thrown)
      throw thrown
    }
    return outcome
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
      await restoreParked()
      for (const peer of deps.profile.peers) {
        // A held or stopped peer is a person's decision, not a peer that failed to start (§4, §7.2).
        if (sessions.has(peer.id) || parked.has(peer.id) || moving.has(peer.id)) continue
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
      // A hold still waiting for a turn would leave its session outside the map, so
      // nothing below would stop it and the pump would never end: end the waits
      // first, and let each put its session back.
      for (const controller of aborts.values()) controller.abort()
      await Promise.all([...inflight])
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

    async hold(peerId, options) {
      const peer = profileOf(peerId)
      const provider = providerOf(peer)
      // Refused before anything stops: a provider with no CLI cannot be taken over.
      if (provider.attachCommand === undefined) {
        throw fleetError('unsupported', `provider ${provider.id} has no CLI a person can take a session over in`, {
          details: { peerId: String(peerId), provider: provider.id },
        })
      }
      await restoreParked()
      const was = parked.get(peerId)
      if (was?.kind === 'stopped') {
        throw fleetError('conflict', `peer ${String(peerId)} is stopped: start it, or take it over once it is running`, {
          details: { peerId: String(peerId) },
        })
      }
      if (was?.kind === 'held' && was.ref !== undefined) return holdAnswer(peer, provider, was.ref)
      return move(peerId, options.signal, async (signal) => {
        const ref = await park(peer, 'held', { ...options, signal })
        return holdAnswer(peer, provider, ref as ProviderSessionRef)
      })
    },

    async release(peerId) {
      const peer = profileOf(peerId)
      await restoreParked()
      begin(peerId)
      try {
        return await unpark(peer, 'held')
      } finally {
        moving.delete(peerId)
      }
    },

    async stopPeer(peerId, options) {
      const peer = profileOf(peerId)
      await restoreParked()
      const was = parked.get(peerId)
      if (was?.kind === 'held') {
        throw fleetError('conflict', `peer ${String(peerId)} is held by a person: release it first`, {
          details: { peerId: String(peerId) },
        })
      }
      if (was?.kind === 'stopped') return { peerId, ...(was.ref === undefined ? {} : { sessionRef: was.ref }) }
      return move(peerId, options.signal, async (signal) => {
        const ref = await park(peer, 'stopped', { ...options, signal })
        return { peerId, ...(ref === undefined ? {} : { sessionRef: ref }) }
      })
    },

    async interrupt(peerId) {
      const running = sessions.get(peerId)
      if (running === undefined || running.session.isAtBoundary()) return false
      await running.session.interrupt()
      return true
    },

    async answerApproval(decisionId: DecisionId, peerId: PeerId, decision: 'allow' | 'deny') {
      const running = sessions.get(peerId)
      if (running === undefined) return false
      return await running.session.answerApproval(decisionId, decision)
    },

    async answerQuestion(decisionId: DecisionId, peerId: PeerId, option: string) {
      const running = sessions.get(peerId)
      if (running === undefined) return false
      return await running.session.answerQuestion(decisionId, option)
    },

    async startPeer(peerId) {
      const peer = profileOf(peerId)
      await restoreParked()
      begin(peerId)
      try {
        return await unpark(peer, 'stopped')
      } finally {
        moving.delete(peerId)
      }
    },
  }

  return supervisor
}

/** Where a peer's state file lives, exported so the CLI and the tests agree with the pump (§1.1). */
export const stateFilePathOf = (paths: ProfilePaths, peerId: PeerId): string =>
  paths.peersDir + '/' + String(peerId) + '/state.md'
