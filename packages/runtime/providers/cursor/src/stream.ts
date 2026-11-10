/**
 * `cursor-agent --output-format stream-json`, one line at a time (§4).
 *
 * The CLI writes one JSON object per line: a `system`/`init` line describing how
 * the process came up, an echo of the `user` message, zero or more `assistant`
 * and `tool_call` lines, and one `result` line closing the turn. Reading it here
 * — a pure function over a string, no process, no clock — is what lets the
 * shapes be tested against recorded lines instead of a paid session.
 *
 * Everything the adapter does not act on is `other`, deliberately: an unknown
 * line is not an error (a newer CLI is allowed to say more than this reads), but
 * it is also not something to guess at.
 *
 * Two things the CLI says badly and this parser does not pretend otherwise:
 *
 * - `init.model` is the model's *display name* ("Claude Sonnet 4.5"), not the id
 *   the process was started with, so it cannot confirm what a session runs. The
 *   adapter reports the requested id instead and says so.
 * - `init.permissionMode` is the CLI's own vocabulary and has read as `default`
 *   in a process started with `--mode plan`; the adapter therefore treats plan
 *   mode as a claim it enforces at `start()`, not one it re-reads from here. The
 *   field is parsed so a caller can log it, never to decide anything.
 */

/** The turn's token counts, under either spelling the CLI has used for them. */
export interface CursorTurnUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

export const emptyTurnUsage: CursorTurnUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
})

/** One line of the stream, as much of it as the adapter acts on. */
export type CursorLine =
  | {
      readonly kind: 'init'
      readonly sessionId?: string
      /** The display name, not the requested id. Never used to decide anything. */
      readonly model?: string
      readonly permissionMode?: string
    }
  | { readonly kind: 'assistant'; readonly text: string }
  | {
      readonly kind: 'tool'
      readonly phase: 'started' | 'completed'
      readonly callId?: string
      readonly tool: string
    }
  | {
      readonly kind: 'result'
      readonly failed: boolean
      /** The CLI's own error text, when it said one. */
      readonly error?: string
      readonly durationMs?: number
      readonly usage: CursorTurnUsage
    }
  /** A line this adapter does not act on; `type` is the CLI's word for it. */
  | { readonly kind: 'other'; readonly type: string }

/**
 * Parse one line. `undefined` means there was nothing there — a blank line, or
 * output that is not JSON at all (the CLI prints a warning to stdout when its
 * config is odd), which is not worth failing a turn over.
 */
export const parseLine = (line: string): CursorLine | undefined => {
  const trimmed = line.trim()
  if (trimmed === '') return undefined
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (!isRecord(value)) return undefined
  const type = typeof value.type === 'string' ? value.type : 'unknown'
  switch (type) {
    case 'system':
      return value.subtype === 'init' ? { kind: 'init', ...initFields(value) } : { kind: 'other', type }
    case 'assistant':
      return assistantLine(value)
    case 'tool_call':
      return toolLine(value)
    case 'result':
      return resultLine(value)
    default:
      return { kind: 'other', type }
  }
}

/** Every line in a chunk of stdout, in order, with the unparseable ones dropped. */
export const parseLines = (chunk: string): readonly CursorLine[] => {
  const lines: CursorLine[] = []
  for (const line of chunk.split('\n')) {
    const parsed = parseLine(line)
    if (parsed !== undefined) lines.push(parsed)
  }
  return lines
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const initFields = (value: Record<string, unknown>): Omit<Extract<CursorLine, { kind: 'init' }>, 'kind'> => ({
  ...(typeof value.session_id === 'string' ? { sessionId: value.session_id } : {}),
  ...(typeof value.model === 'string' ? { model: value.model } : {}),
  ...(typeof value.permissionMode === 'string' ? { permissionMode: value.permissionMode } : {}),
})

/**
 * The assistant line's text. Content is a list of parts, and only the text parts
 * are prose a person reads; anything else is left alone rather than stringified
 * into a summary nobody asked for.
 */
const assistantLine = (value: Record<string, unknown>): CursorLine => {
  const message = isRecord(value.message) ? value.message : {}
  const content = Array.isArray(message.content) ? message.content : []
  const text = content
    .filter((part): part is Record<string, unknown> => isRecord(part) && part.type === 'text')
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('')
  return { kind: 'assistant', text }
}

/**
 * A tool call. The tool's name is the `tool_call` object's key when the object is
 * keyed by tool (`{"shellToolCall": …}`), its `name` when it names one, and the
 * empty-ish "tool" otherwise — the event it becomes needs a name and an untidy
 * one is better than a call that vanishes.
 *
 * No summary is derived from the arguments. The contract says a `tool.use`
 * summary is "already redacted", and there is no way to redact a shell command or
 * a path this CLI hands over without reading what it means.
 */
const toolLine = (value: Record<string, unknown>): CursorLine => {
  const call = isRecord(value.tool_call) ? value.tool_call : {}
  const named = typeof value.name === 'string' ? value.name : typeof call.name === 'string' ? call.name : undefined
  const keyed = Object.keys(call).find((key) => key !== 'name')
  return {
    kind: 'tool',
    phase: value.subtype === 'completed' ? 'completed' : 'started',
    ...(typeof value.call_id === 'string' ? { callId: value.call_id } : {}),
    tool: named ?? keyed ?? 'tool',
  }
}

const resultLine = (value: Record<string, unknown>): CursorLine => {
  const failed = value.is_error === true || value.subtype !== 'success'
  const result = typeof value.result === 'string' ? value.result : undefined
  return {
    kind: 'result',
    failed,
    // A failed turn's own words are the only explanation there is; a successful
    // one's are the answer, which is not an error and is not kept here.
    ...(failed && result !== undefined && result.trim() !== '' ? { error: result.trim() } : {}),
    ...(typeof value.duration_ms === 'number' ? { durationMs: value.duration_ms } : {}),
    usage: usageFrom(value.usage),
  }
}

/**
 * The turn's token counts. The CLI has spelled the cache keys two ways — the
 * OpenAI-style `cache_read_tokens` and the Anthropic-style
 * `cache_read_input_tokens` — and a missing number is zero rather than a guess.
 */
export const usageFrom = (value: unknown): CursorTurnUsage => {
  if (!isRecord(value)) return emptyTurnUsage
  const count = (...keys: readonly string[]): number => {
    for (const key of keys) {
      const found = value[key]
      if (typeof found === 'number' && Number.isFinite(found) && found > 0) return Math.round(found)
    }
    return 0
  }
  return {
    inputTokens: count('input_tokens'),
    outputTokens: count('output_tokens'),
    cacheReadTokens: count('cache_read_tokens', 'cache_read_input_tokens'),
    cacheWriteTokens: count('cache_write_tokens', 'cache_creation_input_tokens'),
  }
}

/**
 * The prompt side of a turn: what the conversation held when the turn started.
 * The output is what the *next* turn will also carry, so counting it here would
 * report a context larger than the one the next turn actually sends.
 */
export const promptTokens = (usage: CursorTurnUsage): number =>
  usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
