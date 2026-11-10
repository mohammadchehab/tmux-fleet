/**
 * One schema-constrained call: the §5.3 Judge's only need, and the one thing
 * §4's `Provider` interface does not offer.
 *
 * §4 is deliberate about the interface: it is the vocabulary of a *session* —
 * start, send, interrupt, stop — and no method returns text meant to be parsed.
 * A Judge question is not a session: it is one prompt in, one answer against a
 * schema out, with no history, no tools and no state to keep. Adding it to
 * `Provider` would put a call every provider must answer on an interface three
 * of them would implement by spawning a whole session and reading nothing, so
 * it lives here instead, next to the SDK that actually supports it
 * (`capabilities.structuredOutput`, `outputFormat` in the §4 spike), and
 * `apps/daemon` hands it to the Judge as a `JudgeTransport`.
 *
 * It is still a *provider* path, which is the point: same SDK, same child env
 * allowlist (`env.ts`), same model ids as a peer's session, so the answer's
 * model is one the fleet can name and its cost is one the fleet already knows.
 *
 * Two things make the call safe to make from a scheduler:
 *
 * - **No tools.** `tools: []` and no MCP servers, so a question cannot turn
 *   into an action. A Judge that could edit a file is a Judge whose answer
 *   depends on what it did on the way.
 * - **No ambient prompt.** `systemPrompt` is the question kind's instructions
 *   verbatim, and `settingSources: []` is SDK isolation (no user, project or
 *   local settings), so nothing on this machine can change how it answers.
 *
 * The abort signal is honoured through the SDK's `abortController`: the Judge
 * budgets each attempt (§5.3) and a call that outlives it must stop working,
 * not keep a process alive behind a settled race.
 */

import { query, type Options } from '@anthropic-ai/claude-agent-sdk'
import { fleetError, parse, peerId, toFleetError, type PeerId } from '@fleet/foundation-core'

import { buildChildEnv } from './env.ts'

/** One question for the model: a system prompt, a prompt, and the shape the answer must take. */
export interface StructuredRequest {
  readonly system: string
  readonly prompt: string
  /** The JSON Schema the answer must satisfy; the SDK enforces it and retries against it. */
  readonly schema: Readonly<Record<string, unknown>>
  readonly model: string
  /** Aborted when the call exceeds its budget; the call stops rather than being ignored. */
  readonly signal: AbortSignal
}

export interface StructuredAnswer {
  /** The answer as JSON text. The caller parses and validates it; this adapter does not. */
  readonly text: string
  /** The model that answered, as the run reported it — not the model that was asked for. */
  readonly model: string
}

export interface StructuredCompletion {
  complete(request: StructuredRequest): Promise<StructuredAnswer>
}

/** What every call in one daemon shares; the per-question fields come from the request. */
export interface StructuredCompletionConfig {
  /** Where the one-shot process runs. A directory that exists, or `start` fails in the CLI. */
  readonly cwd: string
  /** The endpoint/credential fragment, built per provider (§4). Absent means the parent's identity. */
  readonly env?: Readonly<Record<string, string>>
  /** Setting sources; `[]` is SDK isolation and the default here (§4 of the spike). */
  readonly settingSources?: readonly ('user' | 'project' | 'local')[]
  /** The parent env the allowlist reads. An argument so a test never depends on the machine. */
  readonly parentEnv?: Readonly<Record<string, string | undefined>>
  /** The identity recorded in a failure; `judge` unless the caller has a better one. */
  readonly peerId?: PeerId
}

/** The id a judge call reports when it fails. A `PeerId` shape, but nobody's peer (§3). */
export const JUDGE_CALLER: PeerId = parse(peerId(), 'judge')

/**
 * The answer as JSON text. The Judge's reader tolerates a code fence, but this
 * is the SDK's own structured output re-serialised, so it is already an object.
 */
const answerText = (value: unknown): string => JSON.stringify(value)

export const createStructuredCompletion = (config: StructuredCompletionConfig): StructuredCompletion => {
  const settingSources = config.settingSources ?? []

  return {
    async complete(request: StructuredRequest): Promise<StructuredAnswer> {
      // A budget that expired before the call is not a call: no process is
      // spawned for an answer the Judge has already stopped waiting for (§5.3).
      if (request.signal.aborted) {
        throw fleetError('timeout', 'the structured call was aborted before it started', {
          details: { model: request.model },
        })
      }

      // The child env is built the way a peer's is: the allowlist from the
      // parent, then the spec's fragment, and the SDK replaces the whole
      // environment with what it is given (`env.ts`).
      const { env } = buildChildEnv(
        { env: config.env ?? {}, peerId: config.peerId ?? JUDGE_CALLER },
        config.parentEnv ?? process.env,
      )

      const controller = new AbortController()
      const onAbort = (): void => controller.abort()
      request.signal.addEventListener('abort', onAbort, { once: true })

      const options: Options = {
        cwd: config.cwd,
        env: { ...env },
        model: request.model,
        // §5.3: a question, not a task. No tools and no MCP servers, so the only
        // thing this process can do is answer.
        tools: [],
        settingSources: [...settingSources],
        systemPrompt: { type: 'custom', prompt: request.system, snapshot: true },
        outputFormat: { type: 'json_schema', schema: { ...request.schema } },
        abortController: controller,
      }

      let answer: StructuredAnswer | undefined
      try {
        for await (const message of query({ prompt: request.prompt, options })) {
          if (message.type !== 'result') continue
          if (message.subtype !== 'success') {
            throw fleetError('provider_failed', `the structured call did not answer: ${message.subtype}`, {
              details: { subtype: message.subtype, model: request.model },
            })
          }
          if (message.structured_output === undefined) {
            throw fleetError('provider_failed', 'the structured call answered without structured output', {
              details: { subtype: message.subtype, model: request.model },
            })
          }
          // The run's own report of which model answered: a fallback model
          // answers under its own id, and the Judge records that one (§5.3).
          const reported = Object.keys(message.modelUsage)[0]
          answer = {
            text: answerText(message.structured_output),
            model: reported ?? request.model,
          }
        }
      } catch (thrown) {
        // An abort is the Judge's own budget expiring, and it says so: the
        // retry and the escalation read the reason (§5.3).
        throw request.signal.aborted
          ? fleetError('timeout', 'the structured call was aborted before it answered', {
              cause: thrown,
              details: { model: request.model },
            })
          : toFleetError(thrown, 'provider_failed')
      } finally {
        request.signal.removeEventListener('abort', onAbort)
      }

      if (answer === undefined) {
        throw fleetError('provider_failed', 'the structured call ended without a result', {
          details: { model: request.model },
        })
      }
      return answer
    },
  }
}
