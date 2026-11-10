/**
 * Self-purge (§8): the peer hands its context off to a fresh session, without
 * a PM, a routine or a hook in the middle.
 *
 * ```
 * working ──(turn ends, usage is past the limit)──► saving
 * saving  ── ask the peer for its state file (twice at most) ──► saved | degraded
 * saved / degraded ── stop; start fresh from brief + state file ──► working
 * ```
 *
 * This module is the middle of that: it assumes the trigger has already fired
 * at a turn boundary (`policy.ts` decides that, the session wrapper owns the
 * loop) and does the part that touches the session — ask, validate, stop,
 * restart — so it can be tested without a provider, a process or a model.
 *
 * Why the state file is a file and not a parsed reply: the `Provider`
 * interface has no method that returns text meant to be parsed (§4), so a peer
 * cannot "answer" a state file at all. It can *write* one, to the path it is
 * given, and the supervisor reads and validates it against `StateFile` — still
 * typed, and honest about the one direction the fleet reads from a peer.
 */

import { peerActor, type Clock, type PeerId } from '@fleet/foundation-core'
import type { StateFile } from '@fleet/foundation-contracts'
import type { Provider, SessionHandle } from '@fleet/runtime-provider-sdk'

import { sessionIdOf, type PurgeRecord } from './records.ts'
import {
  STATE_FILE_ASKS,
  mechanicalStateFile,
  readStateFile,
  renderStateMarkdown,
  stateFileAsk,
  type MechanicalFacts,
} from './state.ts'

/** The four §8 events, as the contract registers them: `subject` is the peer, `data` the registry's. */
export type PurgeEvent = PurgeRecord

/** A fresh session, and how much newer mail was replayed into it (§7, §8). */
export interface RestartResult {
  readonly handle: SessionHandle
  /** Messages the mailbox replayed because they arrived after the state file. */
  readonly replayedMessages: number
}

/**
 * Everything a purge needs, injected: the provider methods it calls, the
 * session it is purging, and the three things the supervisor does not own —
 * the mailbox's replay, the store's facts, and the filesystem.
 */
export interface PurgePorts {
  /** Only what a purge calls; a provider that leaves out `usage()` is a type error, not a hope. */
  readonly provider: Pick<Provider, 'usage' | 'stop'>
  readonly handle: SessionHandle
  readonly peerId: PeerId
  /** The brief version the fresh session must be started against (§7, §12). */
  readonly briefVersion: number
  /**
   * Send one turn and resolve when it has ended. The session wrapper supplies
   * it because it owns the event loop; a purge never reads the events itself.
   */
  readonly ask: (text: string) => Promise<void>
  /** The peer's state file as it last wrote it, or `undefined` if it wrote none. */
  readonly stateFileText: () => Promise<string | undefined>
  /**
   * Stop the exiting session and start a fresh one from role + re-resolved
   * brief + the state file, replaying newer messages. The mailbox and the
   * provider both live behind this one call.
   */
  readonly restart: (stateFile: StateFile, from: SessionHandle) => Promise<RestartResult>
  /** What the store already knows, for the degraded handoff. */
  readonly facts: () => MechanicalFacts | Promise<MechanicalFacts>
  /** Awaited at every call: the store's `append` is what makes a purge visible. */
  readonly record: (event: PurgeRecord) => void | Promise<void>
  readonly writeFile: (path: string, text: string) => Promise<void>
  /** `~/.fleet/<profile>/peers/<peerId>/state.md` (§1.1). */
  readonly stateFilePath: (peerId: PeerId) => string
  readonly clock: Clock
}

/**
 * A purge that reached a saved or degraded handoff and then could not start the
 * fresh session.
 *
 * It carries the state file because that file is the one thing the peer must
 * not lose: whoever recovers the peer starts the new session *from* it, with
 * the newer mail replayed, instead of from role and brief alone (§8).
 */
export class PurgeRestartFailed extends Error {
  readonly stateFile: StateFile
  readonly degraded: boolean

  constructor(stateFile: StateFile, degraded: boolean, cause: unknown) {
    super('the session after a purge could not be started', { cause })
    this.name = 'PurgeRestartFailed'
    this.stateFile = stateFile
    this.degraded = degraded
  }
}

/** The state file a failed purge already handed off, or `undefined` if none was reached. */
export const restartStateFileOf = (failure: unknown): StateFile | undefined =>
  failure instanceof PurgeRestartFailed ? failure.stateFile : undefined

/** What the caller gets back: the running session, and how honestly it got there. */
export interface PurgeOutcome {
  readonly handle: SessionHandle
  readonly stateFile: StateFile
  /** True when the peer wrote nothing valid twice and the handoff is mechanical. */
  readonly degraded: boolean
  /** Why, when degraded. Absent otherwise. */
  readonly reason?: string
}

/**
 * Run one purge to completion: ask for the state file, keep it or replace it
 * with facts, stop, restart, and record each step.
 *
 * A failure in `restart` propagates — a purge that could not produce a session
 * must be visible, not silently reported as a peer that is merely idle — but
 * as a `PurgeRestartFailed`, so the recovery that follows can start the fresh
 * session from the handoff this purge already recorded (§8).
 */
export const selfPurge = async (ports: PurgePorts): Promise<PurgeOutcome> => {
  const { handle, peerId, record } = ports
  const sessionId = sessionIdOf(handle)
  const actor = peerActor(peerId)
  const usage = await ports.provider.usage(handle)

  await record({
    type: 'purge.started',
    ts: ports.clock.now(),
    subject: peerId,
    actor,
    data: {
      peerId,
      sessionId,
      contextTokens: usage.contextTokens,
      contextLimit: usage.contextLimit,
    },
  })

  const collected = await collectStateFile(ports)

  await record(
    collected.degraded
      ? {
          type: 'purge.degraded',
          ts: ports.clock.now(),
          subject: peerId,
          actor,
          data: { peerId, sessionId, reason: collected.reason ?? 'no valid state file' },
        }
      : {
          type: 'purge.saved',
          ts: ports.clock.now(),
          subject: peerId,
          actor,
          data: { peerId, sessionId, stateFile: collected.stateFile },
        },
  )

  // The human copy is derived from what was validated, never from the raw file
  // (§8): a peer that wrote an unparseable file still leaves a readable state.md.
  await ports.writeFile(
    ports.stateFilePath(peerId),
    renderStateMarkdown(collected.stateFile, ports.clock.now()),
  )

  await ports.provider.stop(handle)
  let restarted: RestartResult
  try {
    restarted = await ports.restart(collected.stateFile, handle)
  } catch (failure) {
    // The handoff was already written and recorded: the state file is the one
    // thing the peer must not lose, so the failure carries it out.
    throw new PurgeRestartFailed(collected.stateFile, collected.degraded, failure)
  }

  await record({
    type: 'purge.completed',
    ts: ports.clock.now(),
    subject: peerId,
    actor,
    data: {
      peerId,
      fromSessionId: sessionId,
      toSessionId: sessionIdOf(restarted.handle),
      replayedMessages: restarted.replayedMessages,
    },
  })

  return {
    handle: restarted.handle,
    stateFile: collected.stateFile,
    degraded: collected.degraded,
    ...(collected.reason === undefined ? {} : { reason: collected.reason }),
  }
}

interface Collected {
  readonly stateFile: StateFile
  readonly degraded: boolean
  readonly reason?: string
}

/**
 * Ask, read, validate — `STATE_FILE_ASKS` times — then fall back to facts.
 *
 * The second ask carries the reason the first reply was refused, because a
 * peer told only "again" repeats the same mistake; a peer told which field was
 * missing fixes it.
 */
const collectStateFile = async (ports: PurgePorts): Promise<Collected> => {
  let reason: string | undefined
  for (let attempt = 1; attempt <= STATE_FILE_ASKS; attempt += 1) {
    await ports.ask(withReason(stateFileAsk(ports.briefVersion), reason))
    const text = await ports.stateFileText()
    if (text === undefined) {
      reason = 'no state file was written'
      continue
    }
    const reading = readStateFile(text, ports.peerId)
    if (reading.ok) return { stateFile: reading.stateFile, degraded: false }
    reason = reading.reason
  }
  const facts = await ports.facts()
  return { stateFile: mechanicalStateFile(facts), degraded: true, ...(reason === undefined ? {} : { reason }) }
}

const withReason = (ask: string, reason: string | undefined): string =>
  reason === undefined
    ? ask
    : `${ask}\n\nThe previous attempt was not accepted: ${reason}. Write the file again, complete and valid.`
