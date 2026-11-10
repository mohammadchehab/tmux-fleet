/**
 * The tool policy evaluator: pure, ordered, and the only thing standing between
 * a peer and a tool the profile never granted it (§4).
 *
 * The shape is held locally until `SessionSpec.toolPolicy` lands in the
 * contracts, so these tests are written against `policy.ts`'s types and will
 * keep passing when the type is swapped for the contract's — that is the
 * point of testing the pure function rather than the session.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { compilePolicy, defaultToolPolicy, evaluatePolicy, primaryString, QUESTION_TOOL } from '../src/index.ts'

const decide = (
  policy: Parameters<typeof compilePolicy>[0],
  tool: string,
  input: Record<string, unknown> = {},
): string => evaluatePolicy(compilePolicy(policy), tool, input)

test('no policy asks about everything, which is what a session did before policies existed', () => {
  assert.equal(defaultToolPolicy.defaultAction, 'ask')
  assert.deepEqual(defaultToolPolicy.rules, [])
  assert.equal(decide(undefined, 'Bash', { command: 'rm -rf /' }), 'ask')
  assert.equal(decide(undefined, 'Read', { file_path: '/etc/passwd' }), 'ask')
  assert.equal(decide(defaultToolPolicy, 'Anything'), 'ask')
})

test('rules are tried in order and the first match wins, not the most specific', () => {
  const policy = {
    defaultAction: 'deny' as const,
    rules: [
      { tool: 'Bash', pattern: '^git ', action: 'allow' as const },
      { tool: 'Bash', action: 'deny' as const },
    ],
  }
  assert.equal(decide(policy, 'Bash', { command: 'git status' }), 'allow')
  assert.equal(decide(policy, 'Bash', { command: 'rm -rf /' }), 'deny', 'the second rule, not the default')

  const reversed = { defaultAction: 'allow' as const, rules: [policy.rules[1]!, policy.rules[0]!] }
  assert.equal(decide(reversed, 'Bash', { command: 'git status' }), 'deny', 'order, not specificity')
})

test('a rule names one tool or every tool, and no match falls through to the default', () => {
  const policy = {
    defaultAction: 'deny' as const,
    rules: [{ tool: 'Read', action: 'allow' as const }],
  }
  assert.equal(decide(policy, 'Read', { file_path: 'a' }), 'allow')
  assert.equal(decide(policy, 'Write', { file_path: 'a' }), 'deny', 'a named rule does not leak to siblings')
  assert.equal(decide(policy, 'Bash', { command: 'ls' }), 'deny')

  assert.equal(decide({ defaultAction: 'allow', rules: [{ tool: '*', action: 'deny' }] }, 'Write', {}), 'deny')
})

test('a rule without a pattern matches every call of its tool', () => {
  const policy = { defaultAction: 'ask' as const, rules: [{ tool: 'Read', action: 'allow' as const }] }
  assert.equal(decide(policy, 'Read', { file_path: '/anywhere/at/all' }), 'allow')
  assert.equal(decide(policy, 'Read', {}), 'allow', 'even with no input at all')
})

test('a pattern sees the shell command, not the JSON around it', () => {
  const policy = {
    defaultAction: 'deny' as const,
    rules: [{ tool: 'Bash', pattern: '^git (status|diff|log)\\b', action: 'allow' as const }],
  }
  assert.equal(decide(policy, 'Bash', { command: 'git status --short', description: 'check' }), 'allow')
  assert.equal(decide(policy, 'Bash', { command: 'git push --force' }), 'deny')
  // The pattern is anchored, so a command that merely mentions git elsewhere is not allowed.
  assert.equal(decide(policy, 'Bash', { command: 'echo "git status"' }), 'deny')
})

test('a pattern sees the file path for the file tools, whichever key the SDK used', () => {
  const policy = {
    defaultAction: 'deny' as const,
    rules: [{ tool: 'Read', pattern: '^/worktrees/', action: 'allow' as const }],
  }
  assert.equal(decide(policy, 'Read', { file_path: '/worktrees/x/README.md' }), 'allow')
  assert.equal(decide(policy, 'Read', { path: '/worktrees/x/README.md' }), 'allow')
  assert.equal(decide(policy, 'Read', { file_path: '/Users/me/.ssh/id_ed25519' }), 'deny')
})

test('every other tool is matched against its input as JSON, bounded at 500 characters', () => {
  const policy = {
    defaultAction: 'deny' as const,
    rules: [{ tool: 'WebFetch', pattern: 'example\\.com', action: 'allow' as const }],
  }
  assert.equal(decide(policy, 'WebFetch', { url: 'https://example.com/x' }), 'allow')
  assert.equal(decide(policy, 'WebFetch', { url: 'https://elsewhere.test/x' }), 'deny')

  // Inside the window: visible to the pattern.
  const early = { tool: 'Grep', pattern: 'needle', action: 'allow' as const }
  assert.equal(decide({ defaultAction: 'deny', rules: [early] }, 'Grep', { query: 'needle' }), 'allow')

  // Past the 500-character window: not matched, because the subject is truncated.
  const far = { tool: 'Grep', pattern: 'needle', action: 'allow' as const }
  const padded = { padding: 'x'.repeat(600), note: 'needle' }
  assert.equal(primaryString('Grep', padded).length, 500)
  assert.equal(decide({ defaultAction: 'deny', rules: [far] }, 'Grep', padded), 'deny')
})

test('a question is never allowed or denied by policy: it always takes the question path', () => {
  const denyAll = { defaultAction: 'deny' as const, rules: [{ tool: '*', action: 'deny' as const }] }
  assert.equal(decide(denyAll, QUESTION_TOOL, { questions: [] }), 'ask')
  const allowAll = { defaultAction: 'allow' as const, rules: [] }
  assert.equal(decide(allowAll, QUESTION_TOOL, { questions: [] }), 'ask')
})

test('an invalid pattern fails at compile time, so a session cannot start with a broken policy', () => {
  assert.throws(
    () => compilePolicy({ defaultAction: 'ask', rules: [{ tool: 'Bash', pattern: '([unclosed', action: 'allow' }] }),
    (thrown: unknown) => (thrown as { code?: string }).code === 'invalid_input',
  )
})

test('a compiled policy cannot be mutated under the session that is using it', () => {
  const compiled = compilePolicy({ defaultAction: 'ask', rules: [{ tool: 'Bash', action: 'allow' }] })
  assert.ok(Object.isFrozen(compiled))
  assert.ok(Object.isFrozen(compiled.rules))
  assert.ok(Object.isFrozen(compiled.rules[0]))
})
