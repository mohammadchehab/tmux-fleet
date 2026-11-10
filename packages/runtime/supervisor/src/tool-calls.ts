/**
 * How one turn spent its exploration, counted by tool name (§6.2).
 *
 * The supervisor counts what the provider's stream already reported — every
 * `tool.use` event carries the tool's name — rather than reading a transcript:
 * one source for every provider, nothing to install in a session, and a tool
 * call that never happened cannot appear in the count because the model said it
 * did.
 *
 * The names are Claude Code's. A provider whose tools are called something else
 * contributes `tool.use` events that `countToolCall` does not recognise, and
 * they count nothing, which is the honest answer: a guard measured against a
 * mapping it invented is not a measurement.
 */

export interface ToolCalls {
  readonly grep: number
  readonly glob: number
  readonly read: number
  readonly codegraph: number
}

export const emptyToolCalls: ToolCalls = Object.freeze({ grep: 0, glob: 0, read: 0, codegraph: 0 })

/** Which bucket a tool name falls in, or `undefined` for the ones the guard does not watch. */
export const countToolCall = (name: string): keyof ToolCalls | undefined => {
  if (name === 'Grep') return 'grep'
  if (name === 'Glob') return 'glob'
  if (name === 'Read') return 'read'
  if (name.startsWith('mcp__codegraph__')) return 'codegraph'
  return undefined
}

/** The tally with one more call in it; the input is untouched. */
export const withToolCall = (calls: ToolCalls, name: string): ToolCalls => {
  const kind = countToolCall(name)
  return kind === undefined ? calls : { ...calls, [kind]: calls[kind] + 1 }
}
