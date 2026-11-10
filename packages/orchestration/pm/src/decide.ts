/**
 * `decide`: §5.2's `decide(state, event) → Action[]`, with §5.4's `inputsHash`.
 *
 * Pure and synchronous, with no store handle and no I/O, for the reason the port gives: a rule that awaited
 * something could not be replayed, and the one thing the PM may not decide by rule — a typed Judge question — is an
 * action, not an `await`. Everything this function needs is in the request; everything it produces is data.
 *
 * The order of the two loops is the whole of the precedence story: `pmRules` in `rules/index.ts` decides which rule
 * gets first claim on a Work or a PR, and within a rule the drafts are in iteration order, which is a stable sort
 * over the snapshot. So two runs over the same request produce the same actions in the same order — which is what
 * `fleet replay --from <seq>` diffs, and what makes a diff mean "the code changed" (§5.4).
 */

import type { Seq } from '@fleet/foundation-core'
import type { DecideRequest, DecideResult, FleetState, PmAction, ProjectManager } from '@fleet/foundation-contracts'
import { shortHash } from './digest.ts'
import type { PmOptions } from './options.ts'
import { resolveOptions } from './options.ts'
import type { RuleContext } from './rules/context.ts'
import { pmRules } from './rules/index.ts'
import { byOrder, indexOf, prOrder, workOrder } from './state.ts'

/** One tick: the rules over a snapshot, deduped by claim, in rule order. */
export const decide = (request: DecideRequest, options: PmOptions = {}): DecideResult => {
  const ctx: RuleContext = {
    state: request.state,
    index: indexOf(request.state),
    options: resolveOptions(options),
    tick: request.tick,
    event: request.event,
    causedBy: causedByOf(request),
    questioned: new Set<string>(),
  }

  const claims = new Set<string>()
  const actions: PmAction[] = []
  for (const rule of pmRules) {
    for (const { claim, action } of rule(ctx)) {
      // the first rule to claim a Work or a PR decides it this tick; a later one would be a second answer
      if (claims.has(claim)) continue
      claims.add(claim)
      actions.push(action)
    }
  }

  return { actions, inputsHash: inputsHashOf(request) }
}

/**
 * What every action the tick emits was decided from: the event's seq, when one woke the tick. A heartbeat cites
 * nothing, because nothing happened — `causedBy` is a trace of evidence, not a field that must be non-empty (§5.4).
 */
const causedByOf = (request: DecideRequest): readonly Seq[] =>
  request.event === undefined ? [] : [request.event.seq]

/**
 * The tick's `inputsHash`: a hash of everything the rules could have read — the snapshot, the event, the clock.
 *
 * Each projection is sorted before hashing, because the hash answers "are these the same inputs?" and a store's
 * answer order is not an input (§5.4). `event` and `tick` are hashed as given: a heartbeat and an event over the
 * same fleet are different inputs, and saying so is the point.
 */
export const inputsHashOf = (request: DecideRequest): string =>
  shortHash({
    state: canonicalState(request.state),
    event: request.event ?? null,
    tick: request.tick ?? null,
  })

const canonicalState = (state: FleetState): unknown => ({
  peers: [...state.peers].sort(byOrder((row) => String(row.peerId))),
  sessions: [...state.sessions].sort(byOrder((row) => String(row.sessionId))),
  work: [...state.work].sort(byOrder(workOrder)),
  decisions: [...state.decisions].sort(byOrder((row) => String(row.decisionId))),
  messages: [...state.messages].sort(byOrder((row) => String(row.msgId))),
  pullRequests: [...state.pullRequests].sort(byOrder(prOrder)),
  worktrees: [...state.worktrees].sort(byOrder((row) => String(row.worktreeId))),
  routines: [...state.routines].sort(byOrder((row) => row.routineId)),
  findings: [...state.findings].sort(byOrder((row) => String(row.findingId))),
  notifications: [...state.notifications].sort(byOrder((row) => String(row.key))),
})

/** The port, closed over a policy: what `apps/daemon` registers and what a test constructs (§5.2). */
export const createProjectManager = (options: PmOptions = {}): ProjectManager => ({
  decide: (request: DecideRequest) => decide(request, options),
})
