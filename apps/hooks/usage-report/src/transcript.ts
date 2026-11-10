/**
 * What one turn cost, read from the transcript Claude Code wrote (§6.2, §8).
 *
 * A **turn** is everything after the last real user prompt: the assistant
 * messages and the tool results between that prompt and the Stop. Reading the
 * transcript rather than asking the model is the point: usage is measured by
 * the harness, and exploration is counted by tool name, not by what the model
 * says it did.
 *
 * Pure: lines in, numbers out. The transcript is the peer's, so nothing in it
 * is trusted as more than a number or a tool name; a malformed line is skipped,
 * never thrown on, because a hook that crashed the Stop would be worse than a
 * turn with no usage.
 */

/** The counts `turn.usage_recorded` carries, minus identity and the profile's context limit. */
export interface TurnMeasure {
  /** The context the last call of the turn saw: the self-purge trigger's input (§8). */
  readonly contextTokens: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cachedTokens: number
  readonly toolCalls: { readonly grep: number; readonly glob: number; readonly read: number; readonly codegraph: number }
}

interface Usage {
  readonly input_tokens?: unknown
  readonly output_tokens?: unknown
  readonly cache_read_input_tokens?: unknown
  readonly cache_creation_input_tokens?: unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const whole = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0

const parseLine = (line: string): Record<string, unknown> | undefined => {
  if (line.trim() === '') return undefined
  try {
    const value: unknown = JSON.parse(line)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** A prompt a person (or the fleet) typed: a user line that is not a tool result, a side chain or meta. */
const isPrompt = (entry: Record<string, unknown>): boolean => {
  if (entry['type'] !== 'user' || entry['isSidechain'] === true || entry['isMeta'] === true) return false
  const message = entry['message']
  if (!isRecord(message)) return false
  const content = message['content']
  if (typeof content === 'string') return true
  return Array.isArray(content) && content.some((block) => isRecord(block) && block['type'] === 'text')
}

const toolKind = (name: string): keyof TurnMeasure['toolCalls'] | undefined => {
  if (name === 'Grep') return 'grep'
  if (name === 'Glob') return 'glob'
  if (name === 'Read') return 'read'
  if (name.startsWith('mcp__codegraph__')) return 'codegraph'
  return undefined
}

/** The turn's measure, or `undefined` when the transcript holds no assistant message after the last prompt. */
export const measureTurn = (transcript: string): TurnMeasure | undefined => {
  const entries = transcript.split('\n').map(parseLine).filter((e): e is Record<string, unknown> => e !== undefined)

  let start = 0
  entries.forEach((entry, index) => {
    if (isPrompt(entry)) start = index + 1
  })

  // The same assistant message is written more than once while it streams; the last copy is the complete one.
  const byMessage = new Map<string, { usage: Usage; blocks: unknown[] }>()
  let anonymous = 0
  for (const entry of entries.slice(start)) {
    if (entry['type'] !== 'assistant' || entry['isSidechain'] === true) continue
    const message = entry['message']
    if (!isRecord(message)) continue
    const key = typeof message['id'] === 'string' ? message['id'] : `anonymous-${String((anonymous += 1))}`
    const usage = isRecord(message['usage']) ? (message['usage'] as Usage) : {}
    const blocks = Array.isArray(message['content']) ? (message['content'] as unknown[]) : []
    byMessage.set(key, { usage, blocks })
  }
  if (byMessage.size === 0) return undefined

  const calls = { grep: 0, glob: 0, read: 0, codegraph: 0 }
  let inputTokens = 0
  let outputTokens = 0
  let cachedTokens = 0
  let last: Usage = {}
  for (const { usage, blocks } of byMessage.values()) {
    inputTokens += whole(usage.input_tokens)
    outputTokens += whole(usage.output_tokens)
    cachedTokens += whole(usage.cache_read_input_tokens)
    last = usage
    for (const block of blocks) {
      if (!isRecord(block) || block['type'] !== 'tool_use' || typeof block['name'] !== 'string') continue
      const kind = toolKind(block['name'])
      if (kind !== undefined) calls[kind] += 1
    }
  }

  return {
    // What the last call carried in: fresh input, plus what it read from and wrote to the cache.
    contextTokens: whole(last.input_tokens) + whole(last.cache_read_input_tokens) + whole(last.cache_creation_input_tokens),
    inputTokens,
    outputTokens,
    cachedTokens,
    toolCalls: calls,
  }
}
