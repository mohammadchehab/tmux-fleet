/**
 * The tool policy: which tool calls this session may make without asking,
 * which it must not make at all, and which go to the person supervising it.
 *
 * The shape is the architect's §4 fold. It is **held locally** until
 * `SessionSpec.toolPolicy` lands in `foundation/contracts` (engineer-1's
 * follow-up PR), and then this file's types become re-exports — the evaluator,
 * its tests and the adapter's use of it do not change.
 *
 * Evaluation is pure and ordered, so a policy can be read like the rule it is:
 * rules are tried in order and the first match wins; `tool` matches the tool
 * name exactly or as `*`; `pattern` is a RegExp source tested against the tool's
 * primary string; a rule with no pattern matches every call of its tool. No rule
 * matching means `defaultAction`. Absent policy means
 * `{defaultAction: 'ask', rules: []}` — the behaviour every session had before
 * policies existed, so adding the field changes nothing by omission.
 *
 * `AskUserQuestion` is never evaluated: it is the peer asking its supervisor a
 * question, not a tool being permitted, and a policy that could deny it would
 * silently answer "no" to a question nobody read. It always takes the question
 * path, whatever the policy says.
 */

import { fleetError } from '@fleet/foundation-core'

/** What to do with a tool call. */
export type ToolAction = 'allow' | 'ask' | 'deny'

export interface ToolPolicyRule {
  /** A tool name (`Bash`, `Read`, …), or `*` for every tool. */
  readonly tool: string
  /** A RegExp source, tested against the tool's primary string. Absent = any call of `tool`. */
  readonly pattern?: string
  readonly action: ToolAction
}

export interface ToolPolicy {
  readonly defaultAction: ToolAction
  readonly rules: readonly ToolPolicyRule[]
}

/** What a session with no `toolPolicy` does: ask about everything, as before. */
export const defaultToolPolicy: ToolPolicy = Object.freeze({
  defaultAction: 'ask',
  rules: Object.freeze([]),
})

/** The tool the model asks a human with. Never allowed or denied by a policy. */
export const QUESTION_TOOL = 'AskUserQuestion'

/** The longest `JSON.stringify(input)` a pattern is tested against (§4). */
const MAX_SUMMARY_PATTERN_LENGTH = 500

/** A rule with its pattern compiled once, so a bad regular expression fails at start, not mid-turn. */
export interface CompiledRule {
  readonly tool: string
  readonly match: RegExp | undefined
  readonly action: ToolAction
}

export interface CompiledToolPolicy {
  readonly defaultAction: ToolAction
  readonly rules: readonly CompiledRule[]
}

/**
 * The string a `pattern` is tested against: what the tool would actually act on,
 * not the whole input object. A policy that has to match a file path should not
 * depend on JSON key order, and one that matches a shell command should see the
 * command.
 */
export const primaryString = (tool: string, input: Readonly<Record<string, unknown>>): string => {
  if (tool === 'Bash') return typeof input.command === 'string' ? input.command : ''
  if (tool === 'Read' || tool === 'Write' || tool === 'Edit') {
    const path = input.file_path ?? input.path
    return typeof path === 'string' ? path : ''
  }
  return stringifyBounded(input)
}

/** A policy that fails to compile is a configuration error, surfaced before the session starts. */
export const compilePolicy = (policy: ToolPolicy | undefined): CompiledToolPolicy => {
  const source = policy ?? defaultToolPolicy
  const rules = source.rules.map((rule): CompiledRule => {
    let match: RegExp | undefined
    if (rule.pattern !== undefined) {
      try {
        match = new RegExp(rule.pattern)
      } catch (thrown) {
        throw fleetError('invalid_input', `tool policy rule for ${rule.tool} has an invalid pattern: ${rule.pattern}`, {
          cause: thrown,
          details: { tool: rule.tool, pattern: rule.pattern },
        })
      }
    }
    return Object.freeze({ tool: rule.tool, match, action: rule.action })
  })
  return Object.freeze({ defaultAction: source.defaultAction, rules: Object.freeze(rules) })
}

/**
 * The action for one tool call. Rules in order, first match wins; no match is
 * `defaultAction`. `AskUserQuestion` is always `ask` — see the file comment.
 */
export const evaluatePolicy = (
  policy: CompiledToolPolicy,
  tool: string,
  input: Readonly<Record<string, unknown>>,
): ToolAction => {
  if (tool === QUESTION_TOOL) return 'ask'
  const subject = primaryString(tool, input)
  for (const rule of policy.rules) {
    if (rule.tool !== '*' && rule.tool !== tool) continue
    if (rule.match !== undefined && !rule.match.test(subject)) continue
    return rule.action
  }
  return policy.defaultAction
}

const stringifyBounded = (input: Readonly<Record<string, unknown>>): string => {
  let json: string
  try {
    json = JSON.stringify(input) ?? ''
  } catch {
    // A circular or otherwise unserialisable input still has to be decided on;
    // an empty subject means a patterned rule does not match, which is the
    // conservative answer (`defaultAction`).
    return ''
  }
  return json.length <= MAX_SUMMARY_PATTERN_LENGTH ? json : json.slice(0, MAX_SUMMARY_PATTERN_LENGTH)
}
