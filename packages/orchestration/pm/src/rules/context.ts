/**
 * What a rule is given, and what it answers (architecture §5.2).
 *
 * A rule is a pure function of the context that returns *drafts* rather than emitting anything: a draft is an
 * action plus the claim it makes ("this Work", "this PR", "this question"). `decide` collects the drafts in rule
 * order and keeps the first claim of each, so two rules that would both act on one Work cannot both win, and the
 * order in `decide.ts` is the only place that precedence is written.
 *
 * `questioned` is the one piece of per-tick state, because §5.2's table says `dedupe` runs *before* `assign`: a
 * Work the tick already asked the Judge about must not be handed to a peer in the same breath.
 */

import type { Seq } from '@fleet/foundation-core'
import type { FleetEvent, FleetState, PmAction, PmTick } from '@fleet/foundation-contracts'
import type { ResolvedPmOptions } from '../options.ts'
import type { StateIndex } from '../state.ts'

export interface Draft {
  /** What the action acts on: the same claim twice in one tick is one action, not two. */
  readonly claim: string
  readonly action: PmAction
}

export type Rule = (ctx: RuleContext) => readonly Draft[]

export interface RuleContext {
  /** The fleet as the tick saw it. A value: the rules cannot read it twice and see two fleets (§5.2). */
  readonly state: FleetState
  readonly index: StateIndex
  readonly options: ResolvedPmOptions
  /** The run that asked; absent when a caller decided without a clock. */
  readonly tick?: PmTick
  /** The event this tick answers, when one woke it. */
  readonly event?: FleetEvent
  /** The event seqs the decision is made from, copied onto every action (§5.4). */
  readonly causedBy: readonly Seq[]
  /** Work ids this tick already asked a question about (§5.2 `dedupe` before `assign`). */
  readonly questioned: Set<string>
}

/** One action, with what it claims. */
export const draft = (claim: string, action: PmAction): Draft => ({ claim, action })
