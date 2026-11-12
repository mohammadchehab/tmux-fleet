/**
 * One `ActionExecutor`, several executors (§5.2, §10).
 *
 * A tick's actions are decided together but carried out by different things: a
 * `send_message` by the Mailbox (§7), a `merge` by the PR gate (§10), a
 * `request_judge` by the judge, a `render_standup` by the notifier (§6.1). §5.2
 * says every action is attempted, in order, even after one fails — so this
 * router calls *one action at a time* rather than handing each executor its
 * subset. Handing over a subset would let the gate reorder or batch, and the
 * order is the PM's.
 *
 * A kind nobody claims is a `failed` outcome, not a throw: it means the daemon
 * was built without an executor for something the PM is allowed to decide, and
 * a visible `actionsFailed` is how §6 wants that to look.
 */

import { fleetError, toFleetError, type Seq } from '@fleet/foundation-core'
import type {
  ActionExecutor,
  ActionOutcome,
  ExecuteRequest,
  ExecutionReport,
  PmAction,
  PmActionKind,
} from '@fleet/foundation-contracts'

/** An executor and the kinds it carries out. `gate.kinds` is where this comes from (§10). */
export interface KindExecutor {
  readonly kinds: readonly PmActionKind[]
  readonly executor: ActionExecutor
}

export interface RouterDeps {
  readonly executors: readonly KindExecutor[]
  /** Every append a delegated action made, so the router can report one flat list of seqs. */
  readonly onAppended?: (seqs: readonly Seq[]) => void
  /** Every action that failed, with its error: `actionsFailed` alone says how many, never why. */
  readonly onFailed?: (outcome: ActionOutcome) => void
}

export interface Router extends ActionExecutor {
  /** For `fleet ls` and for a start-up check that every §5.2 kind has somewhere to go. */
  readonly kinds: ReadonlyMap<PmActionKind, KindExecutor>
}

const one = (action: PmAction, request: ExecuteRequest): ExecuteRequest => ({
  actions: [action],
  routineId: request.routineId,
  ...(request.causedBySeq === undefined ? {} : { causedBySeq: request.causedBySeq }),
})

export const createExecutorRouter = (deps: RouterDeps): Router => {
  const kinds = new Map<PmActionKind, KindExecutor>()
  for (const entry of deps.executors) {
    for (const kind of entry.kinds) {
      if (kinds.has(kind)) {
        throw fleetError(
          'invalid_input',
          `two executors claim '${kind}'; the daemon wires one per kind so an action cannot be carried out twice`,
        )
      }
      kinds.set(kind, entry)
    }
  }

  const runOne = async (action: PmAction, request: ExecuteRequest): Promise<ActionOutcome> => {
    const route = kinds.get(action.kind)
    if (route === undefined) {
      return {
        action,
        ok: false,
        seqs: [],
        error: `no executor is wired for '${action.kind}'; the daemon is missing a group`,
      }
    }
    try {
      const report = await route.executor.execute(one(action, request))
      const outcome = report.outcomes[0]
      if (outcome !== undefined) {
        if (outcome.seqs.length > 0) deps.onAppended?.(outcome.seqs)
        return outcome
      }
      // An executor that returned no outcome for the action it was given did not run it.
      return { action, ok: false, seqs: [], error: `the '${action.kind}' executor returned no outcome` }
    } catch (thrown) {
      // §5.2: a throw would lose the rest of the tick, so it becomes this action's failure.
      const error = toFleetError(thrown, 'internal')
      return { action, ok: false, seqs: [], error: `${error.code}: ${error.message}` }
    }
  }

  return {
    kinds,
    async execute(request: ExecuteRequest): Promise<ExecutionReport> {
      const outcomes: ActionOutcome[] = []
      for (const action of request.actions) {
        const outcome = await runOne(action, request)
        if (!outcome.ok) deps.onFailed?.(outcome)
        outcomes.push(outcome)
      }
      return {
        outcomes,
        executed: outcomes.filter((outcome) => outcome.ok).length,
        failed: outcomes.filter((outcome) => !outcome.ok).length,
      }
    },
  }
}
