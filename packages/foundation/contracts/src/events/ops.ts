/**
 * The running machinery: routines (§6), worktrees (§9), self-purge (§8) and
 * the codegraph index (§6.2). A silent routine is a visible bug only if its
 * runs are events, so every one of them writes started and then finished or
 * failed.
 */

import {
  array,
  boolean,
  count,
  event,
  object,
  oneOf,
  optional,
  positiveInt,
  string,
  text,
} from '@fleet/foundation-core'
import { peerId, sessionId, timestamp, worktreeId } from '@fleet/foundation-core'
import { repo, sha } from '@fleet/foundation-core'
import { branchName } from '../shapes.ts'
import { stateFile } from '../provider.ts'
import { worktreeClasses } from '../projections/delivery.ts'

// ------------------------------------------------------------------- routines

export const routineKinds = [
  'dispatch',
  'keep-busy',
  'pr-babysit',
  'standup',
  'worktree-gc',
  'branch-cleanup',
  'reconcile',
  'security-scan',
  'notify',
  'tracker-sync',
] as const
export type RoutineKind = (typeof routineKinds)[number]

export const routineTriggers = ['event', 'heartbeat', 'schedule', 'startup', 'request'] as const
export type RoutineTrigger = (typeof routineTriggers)[number]

export const routineStarted = event(
  'routine.started',
  object({
    routineId: string({ minLength: 1, maxLength: 80 }),
    kind: oneOf(routineKinds),
    trigger: oneOf(routineTriggers),
    /** The event seq that woke it, for the heartbeat `undefined`. */
    causedBySeq: optional(positiveInt()),
  }),
)

export const routineFinished = event(
  'routine.finished',
  object({
    routineId: string({ minLength: 1, maxLength: 80 }),
    kind: oneOf(routineKinds),
    durationMs: count(),
    /** How many actions the run produced; zero is a legitimate, visible outcome. */
    actions: count(),
    /**
     * How many of those the fleet could not carry out (§5.2, §6). Recorded here
     * rather than only in the executor's log: a decision the fleet failed to
     * perform is exactly the kind of silence §6 exists to prevent, and the run
     * itself must not read as clean.
     */
    actionsFailed: count(),
  }),
)

export const routineFailed = event(
  'routine.failed',
  object({
    routineId: string({ minLength: 1, maxLength: 80 }),
    kind: oneOf(routineKinds),
    error: text(2000),
  }),
)

/**
 * A routine that keeps failing, escalated so the user hears about it (§6, §6.1).
 *
 * `routine.failed` says one attempt failed, and is appended whether or not
 * anyone will act on it. This one is the scheduler's deliberate decision that a
 * routine is broken rather than unlucky: it has failed three times running, and
 * the retries are being spaced out instead of hammered on every tick. The store
 * projects it into §6.1's `failure` notification — the loudest class there is —
 * so a broken routine reaches a person rather than a log nobody reads.
 *
 * `retryAt` is the fact a banner needs to be useful: "it failed" without "and
 * it will try again at 14:32" is a shrug. `failures` is what makes it
 * comparable to the last one.
 */
export const routineFailing = event(
  'routine.failing',
  object({
    routineId: string({ minLength: 1, maxLength: 80 }),
    kind: oneOf(routineKinds),
    error: text(2000),
    /** Attempts in a row that have failed, this one included. Three is when this event is written. */
    failures: count(),
    /** When the scheduler will try this routine again. */
    retryAt: timestamp(),
  }),
)

// ----------------------------------------------------------------- trackers

/**
 * One `tracker-sync` run, as the fleet saw it (§3). The routine's own
 * `routine.finished` says a run happened and how many actions it produced; this
 * says what the board *said* — how many tickets came back, how many were new,
 * and what the tracker answered when it was told to move. It is the difference
 * between "the sync ran" and "the sync agreed with the board", which is the only
 * way to see a drift between the two before a human does.
 */
export const trackerSynced = event(
  'tracker.synced',
  object({
    system: text(40),
    query: text(500),
    /** Tickets `pull` returned. */
    pulled: count(),
    /** `work.proposed` events appended for keys the fleet had never seen. */
    proposed: count(),
    /** `transition` calls the tracker accepted. */
    transitioned: count(),
    /** PR links the tracker accepted. */
    linked: count(),
    /**
     * Calls the tracker refused or that threw. Counted here and carried in
     * `error` rather than thrown: one ticket the board will not move does not
     * make the other nine lies, and the run still records what it did.
     */
    failed: count(),
    error: optional(text(1000)),
  }),
)

// ------------------------------------------------------------------ worktrees

/** A checkout was created for a topic, with its owner recorded at creation (§9). */
export const worktreeCreated = event(
  'worktree.created',
  object({
    worktreeId: worktreeId(),
    repo: repo(),
    branch: branchName(),
    path: string({ minLength: 1, maxLength: 1000 }),
    ownerPeerId: optional(peerId()),
    class: oneOf(worktreeClasses),
  }),
)

/**
 * Classification from git/gh facts on events, not scanned on demand. `holders`
 * are the processes whose cwd is inside the worktree; `gc` reports them and
 * never kills them (§9).
 */
export const worktreeClassified = event(
  'worktree.classified',
  object({
    worktreeId: worktreeId(),
    class: oneOf(worktreeClasses),
    dirty: optional(boolean()),
    unpushed: optional(boolean()),
    holders: array(object({ pid: positiveInt(), command: string({ maxLength: 200 }) })),
  }),
)

export const worktreeRemoved = event(
  'worktree.removed',
  object({ worktreeId: worktreeId(), reason: text(500) }),
)

// ---------------------------------------------------------------- self-purge

/** The trigger fired at a turn boundary: context is past the model's limit (§8). */
export const purgeStarted = event(
  'purge.started',
  object({
    peerId: peerId(),
    sessionId: sessionId(),
    contextTokens: count(),
    contextLimit: positiveInt(),
  }),
)

/** The peer wrote a valid state file; it is the single handoff into the next session. */
export const purgeSaved = event(
  'purge.saved',
  object({ peerId: peerId(), sessionId: sessionId(), stateFile: stateFile() }),
)

/** The peer wrote nothing valid after two asks: the mechanical summary is the fallback (§8). */
export const purgeDegraded = event(
  'purge.degraded',
  object({ peerId: peerId(), sessionId: sessionId(), reason: text(1000) }),
)

/** A fresh session is running from role + brief + state file, with newer messages replayed. */
export const purgeCompleted = event(
  'purge.completed',
  object({
    peerId: peerId(),
    fromSessionId: sessionId(),
    toSessionId: sessionId(),
    /** Messages newer than the state file, replayed in order (§8). */
    replayedMessages: count(),
  }),
)

// ------------------------------------------------------------------- codegraph

/** The index for a worktree is present and fresh enough to guard on (§6.2). */
export const indexReady = event(
  'index.ready',
  object({
    worktreeId: worktreeId(),
    repo: repo(),
    sha: optional(sha()),
    symbols: count(),
    ageSec: count(),
  }),
)

/** Indexing failed: the session starts unguarded and this is raised as a failure (§6.2). */
export const indexFailed = event(
  'index.failed',
  object({ worktreeId: worktreeId(), repo: repo(), message: text(2000) }),
)
