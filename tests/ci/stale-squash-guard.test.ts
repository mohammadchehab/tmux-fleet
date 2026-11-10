// tests/ci/stale-squash-guard.test.ts — the stale-squash guard's two halves, tested apart and then together.
//
// #179 was squash-merged from a branch that predated seven merged PRs. The squash applied a diff computed against
// the branch's own merge-base, so the merge deleted everything those seven had added to the files it touched — and
// CI stayed green, because the reverted tests were deleted along with the code they covered. #187 is the restore.
//
// The guard is a `git diff` rule, not a model judgement: a PR that deletes a line that landed on `main` after it
// branched is either stale or lying about it. Either way a person has to look, and the check names the file and the
// commit that added the line. A PR body that declares the revert (`Revert: #180`) is the deliberate case and passes.
//
// Two levels here, deliberately:
//   * `judge` and `parseDeclaredReverts` are pure, and tested with data — no repository, no clock, no git.
//   * the fixtures below are real repositories with real commits, because the half that can be wrong is the
//     plumbing: which commits count, what a two-dot diff against `main` deletes, which files the merge would touch.
//     A unit test of the parser would not have caught a guard that compared the wrong two trees, and that is exactly
//     the bug this check exists to catch.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  judge,
  parseDeclaredReverts,
  type DeletedLine,
  type MainAddition,
} from '../../.github/scripts/stale-squash-guard.ts'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SCRIPT = join(REPO_ROOT, '.github/scripts/stale-squash-guard.ts')

const tempDirs: string[] = []

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

// ---------------------------------------------------------------- the pure half

const addition = (file: string, text: string, commit: string, subject = 'a main commit'): MainAddition => ({
  file,
  text,
  commit,
  subject,
})

const deletion = (file: string, text: string): DeletedLine => ({ file, text })

test('judge: a deleted line that main added after the merge-base is a finding', () => {
  const findings = judge(
    [addition('src/a.ts', 'export const fixed = true', 'abc1234', 'fix: the later change')],
    [deletion('src/a.ts', 'export const fixed = true')],
  )

  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.file, 'src/a.ts')
  assert.equal(findings[0]?.commit, 'abc1234')
  assert.match(findings[0]?.subject ?? '', /later change/)
})

test('judge: the same text in a different file is not a finding', () => {
  const findings = judge(
    [addition('src/a.ts', 'shared line', 'abc1234')],
    [deletion('src/b.ts', 'shared line')],
  )

  assert.deepEqual(findings, [])
})

test('judge: a line main did not add is not a finding, even if the PR deletes it', () => {
  // Main added nothing in the window; the PR deletes a line that was already there. This is an ordinary edit.
  const findings = judge([], [deletion('src/a.ts', 'export const old = true')])

  assert.deepEqual(findings, [])
})

test('judge: a deletion of blank or whitespace-only text is ignored', () => {
  const findings = judge(
    [addition('src/a.ts', '', 'abc1234'), addition('src/a.ts', '   ', 'def5678')],
    [deletion('src/a.ts', ''), deletion('src/a.ts', '   ')],
  )

  assert.deepEqual(findings, [])
})

test('judge: one line added by two commits names both, so a reader sees the whole gap', () => {
  const findings = judge(
    [addition('src/a.ts', 'same text', 'aaa1111'), addition('src/a.ts', 'same text', 'bbb2222')],
    [deletion('src/a.ts', 'same text')],
  )

  assert.deepEqual(findings.map((f) => f.commit).sort(), ['aaa1111', 'bbb2222'])
})

test('parseDeclaredReverts: a bare `Revert:` line names the PRs it reverts', () => {
  assert.deepEqual(parseDeclaredReverts('Some body.\n\nRevert: #180 #183\n'), ['#180', '#183'])
})

test('parseDeclaredReverts: GitHub\'s own revert body counts', () => {
  assert.deepEqual(parseDeclaredReverts('Reverts acme/fleet#183\n'), ['acme/fleet#183'])
})

test('parseDeclaredReverts: prose that mentions reverting is not a declaration', () => {
  // #179's actual body: "Nothing in #166 is reverted." A guard that matched the word would have passed the very
  // PR that caused this card.
  assert.deepEqual(parseDeclaredReverts('Nothing in #166 is reverted. See #180 for the rest.\n'), [])
})

test('parseDeclaredReverts: `Revert:` with no reference declares nothing', () => {
  assert.deepEqual(parseDeclaredReverts('Revert:\n'), [])
})

// ---------------------------------------------------------------- the fixtures

/**
 * The environment every fixture `git` runs in: the machine's global and system config are switched off, so a
 * developer whose `~/.gitconfig` signs commits or renames branches does not fail these tests, and CI does not pass
 * them for a reason this checkout cannot see.
 */
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Stale Squash Guard',
  GIT_AUTHOR_EMAIL: 'guard@example.test',
  GIT_COMMITTER_NAME: 'Stale Squash Guard',
  GIT_COMMITTER_EMAIL: 'guard@example.test',
  GIT_TERMINAL_PROMPT: '0',
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}:\n${result.stdout}${result.stderr}`)
  }
  return result.stdout
}

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'stale-squash-'))
  tempDirs.push(dir)
  git(dir, 'init', '--initial-branch=main')
  return dir
}

async function commit(dir: string, file: string, contents: string, message: string): Promise<void> {
  await mkdir(dirname(join(dir, file)), { recursive: true })
  await writeFile(join(dir, file), contents)
  git(dir, 'add', file)
  git(dir, 'commit', '-m', message)
}

const headOf = (dir: string): string => git(dir, 'rev-parse', 'HEAD').trim()

const START = 'export const a = 1\nexport const b = 2\n'
const MAIN_CHANGE = 'export const a = 1\nexport const b = 2\nexport const fixed = "later"\n'

function runGuard(dir: string, head: string, bodyFile: string): { status: number | null; out: string } {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, '--base', 'main', '--head', head, '--body-file', bodyFile],
    { cwd: dir, encoding: 'utf8' },
  )
  return { status: result.status, out: `${result.stdout}${result.stderr}` }
}

test('fixture: a stale branch that drops a line main added later fails, naming the file and the commit', async () => {
  const dir = await repo()
  await commit(dir, 'src/a.ts', START, 'initial')
  // The branch leaves main here — this is its merge-base.
  git(dir, 'checkout', '-b', 'stale')
  const mainCommit = await (async () => {
    git(dir, 'checkout', 'main')
    await commit(dir, 'src/a.ts', MAIN_CHANGE, 'fix: the change the stale branch never saw')
    const sha = headOf(dir)
    git(dir, 'checkout', 'stale')
    return sha
  })()
  // The stale branch edits the same file from its own old base: a squash of this applies a diff that deletes
  // `export const fixed`, exactly as #179 did.
  await commit(dir, 'src/a.ts', `${START}export const c = 3\n`, 'feature: what the branch was for')

  const body = join(dir, 'body.md')
  await writeFile(body, 'Adds c.\n')

  const { status, out } = runGuard(dir, 'stale', body)

  assert.equal(status, 1, `expected the guard to fail, got ${status}:\n${out}`)
  assert.match(out, /src\/a\.ts/)
  assert.match(out, new RegExp(mainCommit.slice(0, 7)))
  assert.match(out, /export const fixed/)
})

test('fixture: the same change rebased onto main passes', async () => {
  const dir = await repo()
  await commit(dir, 'src/a.ts', START, 'initial')
  git(dir, 'checkout', '-b', 'rebased')
  git(dir, 'checkout', 'main')
  await commit(dir, 'src/a.ts', MAIN_CHANGE, 'fix: the change the branch must carry')
  git(dir, 'checkout', 'rebased')
  git(dir, 'rebase', 'main')
  await commit(dir, 'src/a.ts', `${MAIN_CHANGE}export const c = 3\n`, 'feature: rebased onto main')

  const body = join(dir, 'body.md')
  await writeFile(body, 'Adds c.\n')

  const { status, out } = runGuard(dir, 'rebased', body)

  assert.equal(status, 0, `expected the guard to pass, got ${status}:\n${out}`)
})

test('fixture: a declared revert passes and says what it was told', async () => {
  const dir = await repo()
  await commit(dir, 'src/a.ts', START, 'initial')
  git(dir, 'checkout', '-b', 'reverting')
  git(dir, 'checkout', 'main')
  await commit(dir, 'src/a.ts', MAIN_CHANGE, 'fix: the change being reverted on purpose')
  git(dir, 'checkout', 'reverting')
  // The branch carries its own change and never had main's: exactly the shape of #179's squash.
  await commit(dir, 'src/a.ts', `${START}export const d = 4\n`, 'revert the thing')

  const body = join(dir, 'body.md')
  await writeFile(body, 'This undoes a bad fix.\n\nRevert: #183\n')

  const { status, out } = runGuard(dir, 'reverting', body)

  assert.equal(status, 0, `expected a declared revert to pass, got ${status}:\n${out}`)
  assert.match(out, /#183/)
})

test("fixture: prose that mentions reverting does not excuse the revert", async () => {
  const dir = await repo()
  await commit(dir, 'src/a.ts', START, 'initial')
  git(dir, 'checkout', '-b', 'prose')
  git(dir, 'checkout', 'main')
  await commit(dir, 'src/a.ts', MAIN_CHANGE, 'fix: the change that would be silently lost')
  git(dir, 'checkout', 'prose')
  await commit(dir, 'src/a.ts', `${START}export const d = 4\n`, 'not a revert, really')

  const body = join(dir, 'body.md')
  await writeFile(body, 'Nothing in #166 is reverted.\n')

  const { status, out } = runGuard(dir, 'prose', body)

  assert.equal(status, 1, `expected prose not to count as a declaration, got ${status}:\n${out}`)
})

test('fixture: a branch that only touches a file main left alone passes', async () => {
  // The merge cannot drop main's change here: the squash applies a diff with no hunks in that file.
  const dir = await repo()
  await commit(dir, 'src/a.ts', START, 'initial')
  await commit(dir, 'src/other.ts', 'export const other = 0\n', 'other file')
  git(dir, 'checkout', '-b', 'elsewhere')
  git(dir, 'checkout', 'main')
  await commit(dir, 'src/a.ts', MAIN_CHANGE, 'fix: in a file nobody else touches')
  git(dir, 'checkout', 'elsewhere')
  await commit(dir, 'src/other.ts', 'export const other = 1\n', 'feature: in the other file')

  const body = join(dir, 'body.md')
  await writeFile(body, 'Changes other.ts.\n')

  const { status, out } = runGuard(dir, 'elsewhere', body)

  assert.equal(status, 0, `expected a disjoint change to pass, got ${status}:\n${out}`)
})

test('fixture: a ref that does not exist is an error, not a pass', async () => {
  // A check that could not run must never look like a check that passed.
  const dir = await repo()
  await commit(dir, 'src/a.ts', START, 'initial')
  const body = join(dir, 'body.md')
  await writeFile(body, '')

  const { status, out } = runGuard(dir, 'no-such-branch', body)

  assert.equal(status, 2, `expected a tool error, got ${status}:\n${out}`)
})

test('fixture: the working directory does not decide the answer', async () => {
  // CI checks out a detached head; the guard must not depend on HEAD pointing at the branch under review.
  const dir = await repo()
  await commit(dir, 'src/a.ts', START, 'initial')
  git(dir, 'checkout', '-b', 'stale')
  git(dir, 'checkout', 'main')
  await commit(dir, 'src/a.ts', MAIN_CHANGE, 'fix: lost by the squash')
  git(dir, 'checkout', 'stale')
  await commit(dir, 'src/a.ts', `${START}export const c = 3\n`, 'feature')
  git(dir, 'checkout', '--detach', 'main')

  const body = join(dir, 'body.md')
  await writeFile(body, '')

  const { status } = runGuard(dir, 'stale', body)

  assert.equal(status, 1)
})
