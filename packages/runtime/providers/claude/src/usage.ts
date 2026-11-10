/**
 * `usage()` — context tokens against the model's limit, the self-purge trigger
 * (§8).
 *
 * The two halves come from different places, and the difference matters:
 *
 * - `contextTokens` is *measured*, from the SDK's own context-usage control
 *   call. Nothing else knows how much of the window a running conversation uses.
 * - `contextLimit` is *configured*. The spike showed the SDK reporting a
 *   `maxTokens` too, but a limit read off the same call it is being compared
 *   against cannot tell "the model has room" from "the SDK has the wrong
 *   window", and on a non-Anthropic endpoint it has no window to report at all.
 *   So the limit comes from the provider's config, per model (§4, §8).
 *
 * `costUsd` is emitted only when the provider declares `usageCost`: a number
 * that looks like money but is not comparable between endpoints is worse than
 * no number, and the spike found exactly that shape on DeepInfra.
 *
 * `autoCompactAt` is the third number and the one §8's guard reads: the count
 * at which the CLI will compact by itself. It comes from the same call as the
 * measurement, for the same reason `contextTokens` does — only the running
 * process knows when it will give up — and it can sit far below the configured
 * window, which is precisely the gap the guard exists to close.
 */

import { fleetError } from '@fleet/foundation-core'
import type { TurnSpend, Usage } from '@fleet/runtime-provider-sdk'

/** Configured context windows, per model id, with the one to use when a model is not listed. */
export interface ContextLimits {
  readonly byModel: Readonly<Record<string, number>>
  readonly fallback: number
}

/** The window `usage()` reports for `model`. A configured number always wins over a measured one. */
export const contextLimitFor = (limits: ContextLimits, model: string): number => {
  const configured = limits.byModel[model]
  if (configured !== undefined) return configured
  if (limits.fallback > 0) return limits.fallback
  throw fleetError('invalid_input', `no context limit configured for model ${model}`, {
    details: { model, known: Object.keys(limits.byModel) },
  })
}

/** The fields of the SDK's context-usage answer this adapter reads. */
export interface ContextUsageAnswer {
  readonly totalTokens?: number
  readonly maxTokens?: number
  /** The resolved autocompact window: what `maxTokens` is measured against. */
  readonly rawMaxTokens?: number
  /** The token count at which the CLI compacts by itself, when it reports one. */
  readonly autoCompactThreshold?: number
  /** Whether auto-compaction is on at all; `false` means nothing will compact behind us. */
  readonly autoCompactEnabled?: boolean
  /** The `/context` rows, where the compaction reserve is `autocompact_buffer`. */
  readonly categories?: readonly { readonly kind?: string; readonly id?: string; readonly tokens?: number }[]
}

/**
 * When the CLI will compact on its own, in tokens — the number a purge has to
 * beat (§8).
 *
 * It is read from the session rather than configured, unlike the window, and
 * the difference is deliberate. `contextLimit` answers "how much can this model
 * hold", which a vendor's SDK guesses wrong (it believes DeepInfra's 1M models
 * hold 200K); `autoCompactAt` answers "when will this process throw my context
 * away", which the process knows exactly and which is sometimes far below the
 * window (a 1M model under a 200K compaction policy). Trusting the SDK's guess
 * where it is *wrong about the window* is fine here, because the compaction
 * really does fire there: beating it is the whole job.
 */
export const autoCompactAtFrom = (answer: ContextUsageAnswer | undefined): number | undefined => {
  if (answer === undefined || answer.autoCompactEnabled === false) return undefined
  const threshold = answer.autoCompactThreshold
  if (typeof threshold === 'number' && threshold > 0) return Math.round(threshold)
  // Older CLIs answer without the threshold but with the pieces: the window it
  // measures against, and the reserve it keeps for the compaction itself.
  const window = answer.rawMaxTokens
  const reserved = answer.categories?.find((row) => row.id === 'autocompact_buffer')?.tokens
  if (typeof window === 'number' && window > 0 && typeof reserved === 'number' && reserved > 0) {
    return Math.max(1, Math.round(window - reserved))
  }
  return undefined
}

/**
 * Build the `Usage` from a live context-usage answer.
 *
 * `totalTokens` is trusted when it is a positive number. When it is missing or
 * zero — the spike saw `detail: 'summary'` answer emptily on DeepInfra — the
 * caller's fallback (the input-side token count of the last assistant message,
 * which every endpoint reports) is used instead, and a limit is still reported
 * so a supervisor can tell "unmeasured" from "unlimited".
 */
export const usageFrom = (input: {
  readonly answer: ContextUsageAnswer | undefined
  readonly fallbackTokens?: number
  readonly model: string
  readonly limits: ContextLimits
  readonly costUsd?: number
}): Usage => {
  const measured = input.answer?.totalTokens
  const tokens =
    typeof measured === 'number' && measured > 0 ? measured : Math.max(0, input.fallbackTokens ?? 0)
  const contextLimit = contextLimitFor(input.limits, input.model)
  const autoCompactAt = autoCompactAtFrom(input.answer)
  const base = {
    contextTokens: Math.round(tokens),
    contextLimit,
    ...(autoCompactAt === undefined ? {} : { autoCompactAt }),
  }
  return input.costUsd === undefined ? base : { ...base, costUsd: input.costUsd }
}

/**
 * The counters a `result` reports cumulatively over the whole query, as the
 * adapter carries them from one boundary to the next (`#reported`).
 */
export interface SpendTotals {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cachedTokens: number
  readonly costUsd: number
}

/** Nothing measured yet: the baseline a session starts from. */
export const noSpend: SpendTotals = Object.freeze({ inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 })

const whole = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0

/**
 * `result.modelUsage` summed over every model the query called: the only field
 * that covers **Task subagents, sidechains and internal calls** as well as the
 * main loop. It is why this is the number §6.2 wants — a transcript reader sees
 * the main loop and, at best, whichever sidechains it knows to look for.
 */
const modelUsageTotals = (value: unknown): SpendTotals | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const rows = Object.values(value as Record<string, unknown>)
  if (rows.length === 0) return undefined
  let totals: SpendTotals = noSpend
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const entry = row as Record<string, unknown>
    const cost = entry['costUSD']
    totals = {
      inputTokens: totals.inputTokens + whole(entry['inputTokens']),
      outputTokens: totals.outputTokens + whole(entry['outputTokens']),
      cachedTokens: totals.cachedTokens + whole(entry['cacheReadInputTokens']),
      costUsd: totals.costUsd + (typeof cost === 'number' && Number.isFinite(cost) && cost > 0 ? cost : 0),
    }
  }
  return totals
}

/**
 * `result.usage`: the main loop's own counters, the fallback for a boundary
 * message that carries no `modelUsage` (a crash result, or an SDK that predates
 * the field). Under-counts subagents by construction — better a small number
 * than none, and the field is documented as per-turn in streaming input.
 */
const mainLoopTotals = (value: unknown): SpendTotals | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const used = value as Record<string, unknown>
  const totals: SpendTotals = {
    inputTokens: whole(used['input_tokens']),
    outputTokens: whole(used['output_tokens']),
    cachedTokens: whole(used['cache_read_input_tokens']),
    costUsd: 0,
  }
  return totals.inputTokens === 0 && totals.outputTokens === 0 && totals.cachedTokens === 0 ? undefined : totals
}

/**
 * One turn's spend, as the difference between this boundary message and the one
 * before it.
 *
 * Four things this deliberately does:
 *
 * - **Reads `modelUsage` first**, so a turn that fanned out to subagents is
 *   billed for them.
 * - **Never goes negative.** The running total resets on `/clear`, and a resumed
 *   session continues from a transcript total; a counter that went backwards
 *   means the baseline is stale, so that counter reports zero for the turn (what
 *   it spent is unknowable across the reset) and the baseline rebases here.
 * - **Reports the cost delta**, not the cumulative `total_cost_usd`, because
 *   `turn.usage_recorded` is one turn's row.
 * - **Reports nothing when the message measured nothing** (a startup error
 *   carries zeroed usage), because a zeroed row reads as a turn that was free.
 */
export const spendFrom = (record: unknown, seen: SpendTotals): { totals: SpendTotals; spend?: TurnSpend } => {
  if (typeof record !== 'object' || record === null) return { totals: seen }
  const message = record as Record<string, unknown>
  const totals = modelUsageTotals(message['modelUsage']) ?? mainLoopTotals(message['usage'])
  if (totals === undefined) return { totals: seen }

  const delta = (now: number, before: number): number => Math.max(0, Math.round(now - before))
  const costUsd = totals.costUsd >= seen.costUsd ? totals.costUsd - seen.costUsd : undefined
  return {
    totals,
    spend: {
      inputTokens: delta(totals.inputTokens, seen.inputTokens),
      outputTokens: delta(totals.outputTokens, seen.outputTokens),
      cachedTokens: delta(totals.cachedTokens, seen.cachedTokens),
      ...(costUsd === undefined || costUsd === 0 ? {} : { costUsd }),
    },
  }
}

/**
 * The fallback token count from a provider `result`: what the prompt side of the
 * last exchange cost, which is the conversation so far plus this turn's input.
 */
export const fallbackTokensFrom = (resultUsage: unknown): number | undefined => {
  if (typeof resultUsage !== 'object' || resultUsage === null) return undefined
  const u = resultUsage as Record<string, unknown>
  const sum = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
    .map((key) => (typeof u[key] === 'number' ? (u[key] as number) : 0))
    .reduce((a, b) => a + b, 0)
  return sum > 0 ? sum : undefined
}
