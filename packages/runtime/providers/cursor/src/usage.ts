/**
 * `usage()` for a cursor session (§8).
 *
 * Both halves are compromises, and each is a different kind:
 *
 * - **`contextTokens` is a proxy.** A cursor session is one `cursor-agent`
 *   process per turn, and the CLI reports only that turn's token counts — there
 *   is no control call that asks a running conversation how full its window is.
 *   What it does report is the prompt side of the last turn: input plus cache
 *   read plus cache write. That is the conversation as the turn sent it, which is
 *   the same number the next turn will send plus this turn's output, so it
 *   tracks the window closely enough for §8's trigger and not exactly. The
 *   adapter reports it, and reports it as a proxy rather than as a measurement.
 *   Nothing accumulates on top of it: a turn that fails before its `result` line
 *   leaves the previous number standing rather than adding a guess to it.
 * - **`contextLimit` is configured.** Same argument as every other provider here:
 *   a window read off the vendor's own answer cannot tell "the model has room"
 *   from "the vendor has the wrong window", and the model list `cursor-agent`
 *   serves changes without a fleet commit. A model with no configured window is
 *   refused at `start()` rather than handed a default nobody measured (§8), so
 *   `usage()` always has a number to divide by.
 *
 * `costUsd` is absent because `capabilities.usageCost` is false: Cursor bills by
 * subscription and request, not at list rates this repo could price a turn at, so
 * the spend ledger records null instead of a number that looks like money (§11).
 * `autoCompactAt` is absent because this CLI does not say when it compacts — which
 * is why the configured window has to be accurate rather than generous.
 */

import { fleetError } from '@fleet/foundation-core'
import type { Usage } from '@fleet/runtime-provider-sdk'

import { promptTokens, type CursorTurnUsage } from './stream.ts'

/** The configured window for `model`, or a refusal naming what is configured. */
export const contextLimitFor = (limits: Readonly<Record<string, number>>, model: string): number => {
  const configured = limits[model]
  if (configured !== undefined && configured > 0) return configured
  throw fleetError(
    'invalid_input',
    `no context limit configured for cursor model ${model}; a cursor session will not start without one ` +
      'because there is no other source for the window it has left',
    { details: { providerId: 'cursor', model, known: Object.keys(limits) } },
  )
}

/**
 * The `Usage` a session reports, from the last turn's counts. `previous` keeps
 * the number standing while no new one has arrived — a session between turns
 * reports what its last turn measured, not zero.
 */
export const usageOf = (input: {
  readonly turn: CursorTurnUsage | undefined
  readonly previousTokens: number
  readonly model: string
  readonly limits: Readonly<Record<string, number>>
}): Usage => ({
  contextTokens: input.turn === undefined ? input.previousTokens : promptTokens(input.turn),
  contextLimit: contextLimitFor(input.limits, input.model),
})
