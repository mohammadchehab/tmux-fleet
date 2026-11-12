/**
 * The default tool policy a peer starts with (TASK-119, decision-6 option 1).
 *
 * Judged through the Claude adapter's own matcher, not by inspecting the rule
 * list: what matters is what a peer is asked about, and the adapter is the thing
 * that asks. Allowed reads and in-worktree git inspection run silently; writes
 * and shell ask; network and anything outside the worktree are denied.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { compilePolicy, evaluatePolicy, type ToolAction } from '@fleet/runtime-provider-claude'

import { decodeProfile } from '../src/config/profile.ts'
import { toolPolicyFor } from '../src/config/tool-policy.ts'

const cwd = '/work/widgets'
const policy = compilePolicy(toolPolicyFor(undefined, cwd), { cwd })

const decide = (tool: string, input: Record<string, unknown>): ToolAction => evaluatePolicy(policy, tool, input)

test('reads inside the worktree run without asking, relative or absolute', () => {
  assert.equal(decide('Read', { file_path: '/work/widgets/src/a.ts' }), 'allow')
  assert.equal(decide('Read', { file_path: 'src/a.ts' }), 'allow')
  assert.equal(decide('Grep', { pattern: 'needle' }), 'allow', 'no path means the worktree')
  assert.equal(decide('Grep', { pattern: 'needle', path: '/work/widgets/src' }), 'allow')
  assert.equal(decide('Glob', { pattern: '**/*.ts' }), 'allow')
  assert.equal(decide('Glob', { pattern: '**/*.ts', path: 'src' }), 'allow')
})

test('reads outside the worktree are denied, including a sibling that shares its prefix', () => {
  assert.equal(decide('Read', { file_path: '/etc/hosts' }), 'deny')
  assert.equal(decide('Read', { file_path: '../../etc/passwd' }), 'deny')
  assert.equal(decide('Read', { file_path: '../widgets-evil/x' }), 'deny')
  assert.equal(decide('Grep', { pattern: 'x', path: '/etc' }), 'deny')
  assert.equal(decide('Grep', { pattern: 'x', path: '~/.ssh' }), 'deny', 'a home path names the home directory')
  assert.equal(decide('Grep', { pattern: 'x', path: '../secrets' }), 'deny')
  assert.equal(decide('Glob', { pattern: '*', path: '/Users/me' }), 'deny')
})

test('a glob that names a path outside the worktree is denied, whatever key carries it', () => {
  assert.equal(decide('Glob', { pattern: '/Users/me/.ssh/*' }), 'deny', 'an absolute glob names its own root')
  assert.equal(decide('Glob', { pattern: '~/.ssh/*' }), 'deny')
  assert.equal(decide('Glob', { pattern: '../../**' }), 'deny')
  assert.equal(decide('Glob', { pattern: 'src/../../etc/*' }), 'deny')
  assert.equal(decide('Grep', { pattern: 'x', glob: '/etc/*' }), 'deny')
  assert.equal(decide('Grep', { pattern: 'x', glob: '../secrets/*' }), 'deny')
  assert.equal(decide('Grep', { pattern: '../relative-regex' }), 'allow', 'Grep pattern is a regex, not a path')
  assert.equal(decide('Glob', { pattern: 'src/**/*.ts' }), 'allow')
})

test('a glob with braces, brackets or extglob syntax asks, never allows, so it cannot hide a path', () => {
  assert.equal(decide('Glob', { pattern: '{/etc,src}/*' }), 'ask', 'a brace alternative can start with a root')
  assert.equal(decide('Glob', { pattern: 'src/{../..,a}/*' }), 'ask', 'a brace alternative can climb')
  assert.equal(decide('Glob', { pattern: '[/]etc/*' }), 'ask')
  assert.equal(decide('Glob', { pattern: '@(/etc|src)/*' }), 'ask')
  assert.equal(decide('Grep', { pattern: 'x', glob: '{/etc,src}/*' }), 'ask')
  assert.equal(decide('Grep', { pattern: 'x', glob: '*.ts' }), 'allow', 'a plain glob is still allowed')
})

test('git status and git diff run silently; other git and any chained command ask', () => {
  assert.equal(decide('Bash', { command: 'git status' }), 'allow')
  assert.equal(decide('Bash', { command: 'git status --porcelain' }), 'allow')
  assert.equal(decide('Bash', { command: 'git diff --stat' }), 'allow')
  assert.equal(decide('Bash', { command: 'git diff HEAD~1 -- src/a.ts' }), 'allow')
  assert.equal(decide('Bash', { command: 'git diff --output=/etc/x' }), 'ask', 'a flag that writes a file is not a read')
  assert.equal(decide('Bash', { command: 'git push origin main' }), 'ask')
  assert.equal(decide('Bash', { command: 'git status; rm -rf build' }), 'ask', 'a chained command is never covered by an allow')
  assert.equal(decide('Bash', { command: 'rm -rf build' }), 'ask')
})

test('network is denied: the web tools, and curl, wget and ssh from the shell', () => {
  assert.equal(decide('WebFetch', { url: 'https://example.com' }), 'deny')
  assert.equal(decide('WebSearch', { query: 'x' }), 'deny')
  assert.equal(decide('Bash', { command: 'curl https://example.com' }), 'deny')
  assert.equal(decide('Bash', { command: 'git status && wget https://example.com' }), 'deny')
  assert.equal(decide('Bash', { command: 'ssh build-host' }), 'deny')
})

test('writes ask, even inside the worktree; a write outside it is denied', () => {
  assert.equal(decide('Write', { file_path: 'src/a.ts', content: 'x' }), 'ask')
  assert.equal(decide('Edit', { file_path: '/work/widgets/a.ts' }), 'ask')
  assert.equal(decide('MultiEdit', { file_path: 'a.ts' }), 'ask')
  assert.equal(decide('Write', { file_path: '/etc/x', content: 'x' }), 'deny')
})

test('a question always reaches a person, whatever the policy says', () => {
  assert.equal(decide('AskUserQuestion', {}), 'ask')
})

test('a profile that asks for the ask-everything behaviour gets no policy at all', () => {
  assert.equal(toolPolicyFor({ preset: 'ask-all' }, cwd), undefined)
})

test('the routine preset is the same as no block: both give the default set', () => {
  assert.deepEqual(toolPolicyFor({ preset: 'routine' }, cwd), toolPolicyFor(undefined, cwd))
})

test('a misspelled preset is refused at load, not silently read as the routine default', () => {
  const profile = (toolPolicy: unknown) =>
    decodeProfile({
      profile: 'test',
      repos: ['acme/widgets'],
      peers: [{ id: 'engineer-1', role: 'engineer', provider: 'claude', model: 'claude-opus-5-5' }],
      toolPolicy,
    })
  assert.equal(profile({ preset: 'ask-all' }).toolPolicy?.preset, 'ask-all')
  assert.throws(() => profile({ preset: 'allow-all' }))
})
