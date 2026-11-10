/**
 * The `judge` suite's promptfoo provider: it calls the **real** Judge path (§17), not a stand-in.
 *
 * What runs per case is the production code, unchanged:
 *
 *   case `input`  →  `createJudge`  →  `prompts.ts` (the kind's system prompt and the labelled data block)
 *                                   →  `JudgeTransport.complete`  →  `createStructuredCompletion` (the provider's
 *                                      one-shot schema-constrained call, its own env allowlist, no tools)
 *                                   →  `readAnswer` (schema validation, then the rules a schema cannot state)
 *                                   →  one retry, then a failure
 *
 * So an eval measures what a peer's decision costs and how often it is right, on the same prompt, the same schema and
 * the same retry policy. Two things are deliberately local: the **event sink** (an eval process has no store; §17's
 * adapter is what turns the run into events afterwards) and the **answer log** (an eval answer must never be replayed
 * from a previous run — a cached answer would score a model that was not called). Neither is on the path under test:
 * the transport, the prompt, the parse and the validation all are.
 *
 * The provider is built from the environment rather than from flags because promptfoo constructs it:
 * `FLEET_EVAL_PROVIDER` (`claude` | `deepinfra`), `FLEET_EVAL_MODEL`, `DEEPINFRA_API_KEY` (deepinfra only) and
 * `FLEET_EVAL_CWD`. The key is read here and handed to `deepInfraEnv`, which is the only builder of a DeepInfra env
 * fragment: it never reaches an output, a metadata field or an error message.
 */

import {
  fleetError,
  newQuestionId,
  toFleetError,
  type FleetError,
} from '@fleet/foundation-core'
import type { AppendEvent, EventSink, QuestionKind } from '@fleet/foundation-contracts'
import {
  createJudge,
  hashInputs,
  type JudgeLog,
  type JudgeService,
  type JudgeTransport,
} from '@fleet/orchestration-judge'
import { createStructuredCompletion } from '@fleet/runtime-provider-claude'
import { DEEP_INFRA_CONTEXT_LIMITS, deepInfraEnv } from '@fleet/runtime-provider-deepinfra'

import type { JudgeCase } from './case.ts'
import { decisionOf, renderDecision } from './decision.ts'

/** The two providers §17's first slice runs. */
export const EVAL_PROVIDERS = ['claude', 'deepinfra'] as const
export type EvalProvider = (typeof EVAL_PROVIDERS)[number]

/** Who answers, with what, and where the one-shot call runs. */
export interface JudgeTarget {
  readonly provider: EvalProvider
  readonly model: string
  /** DeepInfra's key, in memory only; absent for `claude`, which uses the machine's own identity. */
  readonly token?: string
  /** A directory that exists: the one-shot process runs there, as a peer's does. */
  readonly cwd: string
  readonly timeoutMs?: number
}

/** A Claude id — the CLI's own models, which DeepInfra does not serve. */
const CLAUDE_MODEL_ID = /^(?:claude-|anthropic\/)/

/**
 * Refuse a provider/model pair that would measure the wrong thing (§17, #80): a DeepSeek id on the Claude provider is
 * a 404 mid-run, and a Claude id on DeepInfra is a request to the wrong vendor — the drift the DeepInfra guard
 * exists to stop. A DeepInfra model also has to be one whose context window the fleet measured, which is the same
 * list the provider itself refuses against.
 */
export function refuseTarget(target: JudgeTarget): FleetError | undefined {
  if (target.provider === 'deepinfra') {
    if (DEEP_INFRA_CONTEXT_LIMITS[target.model] === undefined) {
      return fleetError(
        'config_mismatch',
        `${target.model} is not a DeepInfra model the fleet has measured; a DeepInfra eval runs a DeepSeek id only`,
        { details: { provider: target.provider, model: target.model, known: Object.keys(DEEP_INFRA_CONTEXT_LIMITS) } },
      )
    }
    if (target.token === undefined || target.token.trim() === '') {
      return fleetError('config_mismatch', 'a deepinfra eval needs DEEPINFRA_API_KEY in its environment', {
        details: { provider: target.provider, expected: 'DEEPINFRA_API_KEY' },
      })
    }
    return undefined
  }
  if (CLAUDE_MODEL_ID.test(target.model)) return undefined
  return fleetError(
    'config_mismatch',
    `${target.model} is not a Claude model; the claude provider runs a Claude id (a DeepSeek model is a deepinfra run)`,
    { details: { provider: target.provider, model: target.model } },
  )
}

/** The transport the daemon would inject, built the same way: one schema-constrained call on the provider. */
export const judgeTransportFor = (target: JudgeTarget): JudgeTransport => {
  const refused = refuseTarget(target)
  if (refused !== undefined) throw refused
  // The env fragment is the provider's own builder; the Claude provider passes none and keeps the ambient identity.
  const env = target.provider === 'deepinfra' ? deepInfraEnv(target.token ?? '', { model: target.model }) : undefined
  const completion = createStructuredCompletion({
    cwd: target.cwd,
    ...(env === undefined ? {} : { env }),
  })
  return { complete: (request) => completion.complete(request) }
}

/** One run's events, kept only so a case can report how many the Judge wrote; nothing reads them after. */
export interface JudgeRunLog {
  readonly sink: EventSink
  readonly log: JudgeLog
  readonly events: readonly AppendEvent[]
}

/**
 * A fresh, empty log per case. `findAnswered` answers `undefined` because nothing was answered before this run: an
 * eval that read a previous run's answer would score a model it never called (§5.4 is a store's rule, not a suite's).
 */
export const createRunLog = (): JudgeRunLog => {
  const events: AppendEvent[] = []
  let seq = 0
  const sink: EventSink = {
    append: async (batch) => {
      for (const event of batch) {
        events.push(event)
        seq += 1
      }
      return [seq]
    },
  }
  return {
    sink,
    log: { findAnswered: async () => undefined },
    events,
  }
}

/** Answer one case through the real Judge. The outcome is the Judge's own: an answer, or why it could not give one. */
export interface JudgeRun {
  readonly output?: string
  readonly error?: string
  readonly model?: string
  readonly retries?: number
  readonly durationMs: number
}

export const createJudgeRunner = (target: JudgeTarget) => {
  const transport = judgeTransportFor(target)
  return async (c: JudgeCase): Promise<JudgeRun> => {
    const runLog = createRunLog()
    const judge: JudgeService = createJudge({
      sink: runLog.sink,
      log: runLog.log,
      transport,
      model: target.model,
      ...(target.timeoutMs === undefined ? {} : { timeoutMs: target.timeoutMs }),
    })
    const startedAt = Date.now()
    const kind: QuestionKind = c.input.kind
    const result = await judge.ask({
      questionId: newQuestionId(),
      kind,
      input: c.input,
      inputsHash: hashInputs(kind, c.input),
    })
    const durationMs = Date.now() - startedAt
    if (!result.ok) return { error: `the judge failed: ${result.error.code}: ${result.error.message}`, durationMs }
    if (result.value.status === 'failed') {
      // §17: a malformed answer is a failure, not a zero-scored pass — the case did not get a decision to compare.
      return { error: `the judge could not answer: ${result.value.reason}`, durationMs }
    }
    return {
      output: renderDecision(decisionOf(result.value.answer)),
      model: result.value.model,
      retries: result.value.retries,
      durationMs,
    }
  }
}

/** What promptfoo hands `callApi`; only the parts this provider reads. */
export interface CallApiContext {
  readonly vars?: Readonly<Record<string, unknown>>
}

/** What promptfoo reads back from `callApi`; an `error` fails the case with its message. */
export interface CallApiResponse {
  readonly output?: string
  readonly error?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

/**
 * The provider class promptfoo instantiates. It answers one case per call, so N=3 repeats (§17) are three real model
 * calls, three Judge runs and three decisions — which is the only way a pass rate means anything.
 */
export class JudgeProvider {
  readonly #target: JudgeTarget
  readonly #run: (c: JudgeCase) => Promise<JudgeRun>

  constructor(target: JudgeTarget) {
    this.#target = target
    this.#run = createJudgeRunner(target)
  }

  id(): string {
    return providerIdFor(this.#target)
  }

  async callApi(_prompt: string, context: CallApiContext): Promise<CallApiResponse> {
    const c = context.vars?.['case'] as JudgeCase | undefined
    if (c === undefined || typeof c !== 'object') {
      return { error: 'the test carried no `case` var; the tests file is what supplies one' }
    }
    try {
      const run = await this.#run(c)
      const metadata = {
        provider: this.#target.provider,
        model: run.model ?? this.#target.model,
        retries: run.retries ?? 0,
        durationMs: run.durationMs,
      }
      return run.error === undefined
        ? { output: run.output ?? '', metadata }
        : { error: run.error, metadata }
    } catch (thrown) {
      // A transport that throws is a failure of the case, never of the run: one dead model call must not take the
      // other nine cases with it. The message is the fleet error's, which never carries a credential.
      return { error: `the judge call failed: ${toFleetError(thrown, 'external_failed').message}` }
    }
  }
}

/** The id promptfoo's report carries, and the one the adapter decodes back into a provider and a model. */
export const providerIdFor = (target: JudgeTarget): string => `fleet-judge:${target.provider}:${target.model}`

/**
 * The target the environment names. Read in one place so the promptfoo provider and the CLI runner cannot disagree
 * about which variable is which: `FLEET_EVAL_PROVIDER` (`claude` | `deepinfra`), `FLEET_EVAL_MODEL`, the DeepInfra key,
 * and `FLEET_EVAL_CWD` for the directory the one-shot process runs in.
 */
export const targetFromEnv = (environ: Readonly<Record<string, string | undefined>>): JudgeTarget => {
  const provider = (environ['FLEET_EVAL_PROVIDER'] ?? 'claude') as EvalProvider
  if (!EVAL_PROVIDERS.includes(provider)) {
    throw fleetError('config_mismatch', `FLEET_EVAL_PROVIDER is ${provider}; it is one of ${EVAL_PROVIDERS.join(', ')}`, {
      details: { expected: EVAL_PROVIDERS },
    })
  }
  const model = environ['FLEET_EVAL_MODEL']
  if (model === undefined || model.trim() === '') {
    throw fleetError('config_mismatch', 'FLEET_EVAL_MODEL names the model an eval run measures; it is required', {
      details: { provider },
    })
  }
  const token = environ['DEEPINFRA_API_KEY']
  const target: JudgeTarget = {
    provider,
    model,
    cwd: environ['FLEET_EVAL_CWD'] ?? process.cwd(),
    ...(token === undefined ? {} : { token }),
  }
  const refused = refuseTarget(target)
  if (refused !== undefined) throw refused
  return target
}

/** The provider a `file://` shim exports, built from the environment promptfoo was started with. */
export const providerFromEnv = (environ: Readonly<Record<string, string | undefined>>): JudgeProvider =>
  new JudgeProvider(targetFromEnv(environ))
