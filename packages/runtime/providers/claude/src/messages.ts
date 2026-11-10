/**
 * Stream messages in, adapter events out. Pure, so the mapping is unit-testable
 * without spawning a CLI: the pump is the only code that talks to the SDK.
 *
 * Only five of the SDK's message kinds carry provider signal (§4):
 *
 * - `system/init` — the session is up, and it says which model and permission
 *   mode it really came up in. It is re-emitted at the start of every turn, so
 *   the *latest* one is the truth about the process right now.
 * - `assistant` — the tool calls in the turn.
 * - `result` — the turn boundary, with `is_error`, `terminal_reason` and usage.
 * - `system/compact_boundary` — the model compacted (§8).
 * - nothing else; a provider that returned text for a host to parse is exactly
 *   what §4 forbids.
 */

import type { Timestamp, TurnId } from '@fleet/foundation-core'
import type { ProviderSessionRef } from '@fleet/runtime-provider-sdk'

import type { AdapterEvent, AskedQuestion, TurnEndReason } from './events.ts'

/** What the turn boundary needs to know that the message itself does not say. */
export interface TurnState {
  /** Set by `interrupt()`, so the `result` that follows is reported as `interrupted` and not `failed`. */
  readonly interrupted: boolean
  /** Context tokens when the turn started, so compaction can report a `before` it can trust. */
  readonly contextTokensBefore?: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Map one SDK message. `turnId` is the turn the pump believes is running; a
 * message that arrives with no turn open (a re-emitted `init`, a replay) still
 * maps, because a session can be initialised before anyone has sent anything.
 */
export const mapMessage = (
  message: unknown,
  turnId: TurnId | undefined,
  state: TurnState,
  now: Timestamp,
): AdapterEvent[] => {
  if (!isRecord(message) || typeof message.type !== 'string') return []

  if (message.type === 'system' && message.subtype === 'init') {
    const sessionRef = typeof message.session_id === 'string' ? message.session_id : undefined
    if (sessionRef === undefined) return [{ type: 'error', message: 'init carried no session_id', retryable: false }]
    return [
      {
        type: 'session.started',
        at: now,
        sessionRef: sessionRef as ProviderSessionRef,
        model: typeof message.model === 'string' ? message.model : 'unknown',
        permissionMode: typeof message.permissionMode === 'string' ? message.permissionMode : 'unknown',
      },
    ]
  }

  if (message.type === 'system' && message.subtype === 'compact_boundary') {
    // A compaction is not an intra-turn event: an auto-compaction can land
    // between turns and a person's `/compact` always does. Dropping those was
    // how a peer could lose its context without the fleet ever seeing it (§8).
    const meta = isRecord(message.compact_metadata) ? message.compact_metadata : undefined
    const after = typeof meta?.post_tokens === 'number' ? meta.post_tokens : undefined
    const before = typeof meta?.pre_tokens === 'number' ? meta.pre_tokens : state.contextTokensBefore
    if (before === undefined) return []
    const trigger =
      meta?.trigger === 'auto' || meta?.trigger === 'manual' ? meta.trigger : ('unknown' as const)
    return [
      {
        type: 'compaction',
        ...(turnId === undefined ? {} : { turnId }),
        trigger,
        contextTokensBefore: before,
        ...(after === undefined ? {} : { contextTokensAfter: after }),
      },
    ]
  }

  if (message.type === 'assistant') {
    if (turnId === undefined) return []
    return toolUses(message).map((block) => {
      const summary = summariseToolUse(block.name, block.input)
      return {
        type: 'tool.use' as const,
        turnId,
        tool: block.name,
        ...(summary === undefined ? {} : { summary }),
      }
    })
  }

  if (message.type === 'result') {
    if (turnId === undefined) return []
    const isError = message.is_error === true
    const reason: TurnEndReason = state.interrupted ? 'interrupted' : isError ? 'failed' : 'completed'
    const errorText =
      reason === 'failed'
        ? typeof message.result === 'string' && message.result.length > 0
          ? message.result
          : `the turn failed (subtype ${String(message.subtype ?? 'unknown')})`
        : undefined
    return [
      {
        type: 'turn.ended',
        turnId,
        at: now,
        reason,
        ...(errorText === undefined ? {} : { error: errorText }),
      },
    ]
  }

  return []
}

interface ToolUseBlock {
  readonly name: string
  readonly input: Record<string, unknown>
}

const toolUses = (message: Record<string, unknown>): ToolUseBlock[] => {
  const body = message.message
  if (!isRecord(body)) return []
  const content = body.content
  if (!Array.isArray(content)) return []
  const out: ToolUseBlock[] = []
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'tool_use' || typeof block.name !== 'string') continue
    out.push({ name: block.name, input: isRecord(block.input) ? block.input : {} })
  }
  return out
}

/**
 * A short summary of a tool call for the event stream — never the whole input
 * (§4). One safe, already-short field per tool; anything else gets none, and
 * the store keeps only `tool`.
 */
export const summariseToolUse = (name: string, input: Record<string, unknown>): string | undefined => {
  const first = (key: string): string | undefined => {
    const value = input[key]
    return typeof value === 'string' && value.length > 0 ? truncate(value, 200) : undefined
  }
  switch (name) {
    case 'Bash':
      return first('command')
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return first('file_path')
    case 'Task':
    case 'Agent':
      return first('description')
    case 'WebFetch':
    case 'WebSearch':
      return first('url') ?? first('query')
    default:
      return undefined
  }
}

const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`

/**
 * The `answers` payload the `AskUserQuestion` tool expects on an allowed call:
 * one entry per question, keyed by the question text. `answer` is the contract's
 * `QuestionAnswer` — one label per question, in the order asked. A question the
 * answer does not reach falls back to its first option, so a partial answer can
 * only ever narrow a choice, never invent one.
 */
export const questionAnswers = (
  questions: readonly { readonly question: string; readonly options?: readonly { readonly label: string }[] }[],
  answer: readonly string[],
): Record<string, string> => {
  const answers: Record<string, string> = {}
  questions.forEach((question, index) => {
    const chosen = answer[index]
    const literal = question.options?.find((o) => o.label === chosen)
    answers[question.question] = literal?.label ?? chosen ?? question.options?.[0]?.label ?? ''
  })
  return answers
}

/** The questions of an `AskUserQuestion` tool input, or `undefined` when the input is not one. */
export const readQuestions = (input: Record<string, unknown>): AskedQuestion[] | undefined => {
  if (!Array.isArray(input.questions)) return undefined
  const questions: AskedQuestion[] = []
  for (const raw of input.questions) {
    if (!isRecord(raw) || typeof raw.question !== 'string') return undefined
    questions.push({
      question: raw.question,
      ...(typeof raw.header === 'string' ? { header: raw.header } : {}),
      ...(typeof raw.multiSelect === 'boolean' ? { multiSelect: raw.multiSelect } : {}),
      ...(Array.isArray(raw.options)
        ? {
            options: raw.options.flatMap((option) =>
              isRecord(option) && typeof option.label === 'string'
                ? [{ label: option.label, ...(typeof option.description === 'string' ? { description: option.description } : {}) }]
                : [],
            ),
          }
        : {}),
    })
  }
  return questions.length > 0 ? questions : undefined
}

