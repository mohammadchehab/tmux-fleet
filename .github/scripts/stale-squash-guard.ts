#!/usr/bin/env node
// .github/scripts/stale-squash-guard.ts: fails a PR that would silently revert work already on main.
//
// #179 was squash-merged from a branch that predated seven merged PRs. A squash applies the diff between the branch's
// merge-base and its head, so the merge deleted every line those seven PRs had added to the files it touched — tests
// included, which is why CI stayed green: the reverted tests went with the reverted code. #187 is the restore.
//
// The rule, mechanically: take the lines `main` gained after this PR's merge-base, keep the files this PR touches, and
// ask whether the PR head still has them. A line `main` added that the head does not have is a line the merge would
// delete. No model, no similarity score: either the line is there or it is not, and the check names the file and the
// commit that put it there so a person can look.
//
// Only files the PR touches can be reverted: a squash applies the PR's own hunks, so a file with no hunk keeps main's
// version. That filter is what makes an ordinary PR that never opened the file main changed pass.
//
// A revert is legitimate: it is a decision, and a decision can be written down. A line in the PR body that declares it
// — `Revert: #180` or GitHub's own `Reverts owner/repo#180` — passes the check, names the declaration in the log, and
// still prints the lines being dropped. Prose that happens to contain the word does not count; #179's own body said
// "Nothing in #166 is reverted", which is why the declaration is a shape and not a search.
//
// Usage:
//   node .github/scripts/stale-squash-guard.ts [--base origin/main] [--head HEAD] [--body-file <path>]
//
// The PR body comes from --body-file, else from the checkout's event payload (GITHUB_EVENT_PATH, .pull_request.body),
// else the check runs without a declaration — a missing body is not a declaration of anything.
//
// Exit: 0 nothing would be reverted, or the revert is declared; 1 the PR drops lines main added after its merge-base;
// 2 the check could not run (missing ref, no merge-base, git failure). A check that did not run is never a pass.

import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** A line a commit on `main` added after the PR's merge-base, and the commit that added it. */
export interface MainAddition {
  readonly file: string
  readonly text: string
  readonly commit: string
  readonly subject: string
}

/** A line the PR head does not have, though `main` does. */
export interface DeletedLine {
  readonly file: string
  readonly text: string
}

/** A line this PR would delete, with the commit on main that added it. */
export interface Finding {
  readonly file: string
  readonly text: string
  readonly commit: string
  readonly subject: string
}

/** Lines shorter than this are not evidence of anything: `}`, `)` and a bare `import` occur everywhere. */
const TRIVIAL = 3
/** Enough to act on; the rest are counted rather than printed. */
const LISTED = 50
/** Example lines per (file, commit): the shape of a revert is visible in a few, and a reader can open the file. */
const SAMPLES = 3

/** What the guard suspects, gathered by where it came from: one entry per (file, commit that added it). */
interface FindingGroup {
  readonly file: string
  readonly commit: string
  readonly subject: string
  readonly texts: string[]
}

function groupByOrigin(findings: readonly Finding[]): FindingGroup[] {
  const groups = new Map<string, FindingGroup>()
  for (const finding of findings) {
    const key = `${finding.file}\u0000${finding.commit}`
    const group = groups.get(key)
    if (group === undefined) {
      groups.set(key, { file: finding.file, commit: finding.commit, subject: finding.subject, texts: [finding.text] })
    } else {
      group.texts.push(finding.text)
    }
  }
  return [...groups.values()].sort((a, b) => b.texts.length - a.texts.length || a.file.localeCompare(b.file))
}

/**
 * The rule itself: for every line the PR would delete, the commits on `main` that added that same line to that same
 * file. Empty means the PR deletes nothing that landed after it branched.
 *
 * Matching is on the file and the trimmed text, not on line numbers, because a stale squash re-adds whole old files:
 * the line numbers move, the text is whatever the branch last saw.
 */
export function judge(added: readonly MainAddition[], deleted: readonly DeletedLine[]): Finding[] {
  const byKey = new Map<string, MainAddition[]>()
  for (const line of added) {
    const key = keyOf(line.file, line.text)
    if (key === undefined) continue
    const bucket = byKey.get(key)
    if (bucket === undefined) byKey.set(key, [line])
    else bucket.push(line)
  }

  const findings: Finding[] = []
  const seen = new Set<string>()
  for (const line of deleted) {
    const key = keyOf(line.file, line.text)
    if (key === undefined) continue
    for (const source of byKey.get(key) ?? []) {
      const id = `${key}\u0000${source.commit}`
      if (seen.has(id)) continue
      seen.add(id)
      findings.push({ file: line.file, text: line.text, commit: source.commit, subject: source.subject })
    }
  }
  return findings
}

/** `undefined` for a line the rule declines to judge: blank, whitespace-only, or too short to be distinctive. */
function keyOf(file: string, text: string): string | undefined {
  const trimmed = text.trim()
  if (trimmed.length < TRIVIAL) return undefined
  return `${file}\u0000${trimmed}`
}

/**
 * The references a PR body declares it is reverting, or `[]`. Read as a line of its own so that prose about reverting
 * (a review thread, a "not a revert" note, #179's own body) is not mistaken for the decision.
 */
export function parseDeclaredReverts(body: string): string[] {
  const refs: string[] = []
  for (const line of body.split('\n')) {
    const match =
      /^\s{0,3}(?:reverts?|this reverts)\s*:?\s+(.+)$/i.exec(line) ??
      /^\s{0,3}this reverts commit\s+(.+)$/i.exec(line)
    if (match === null) continue
    const found = (match[1] ?? '').match(/(?:[\w.-]+\/[\w.-]+)?#[0-9]+|\b[0-9a-f]{7,40}\b/gi) ?? []
    refs.push(...found)
  }
  return refs
}

// ---------------------------------------------------------------- git plumbing

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function tryGit(cwd: string, args: readonly string[]): string | undefined {
  try {
    return git(cwd, args)
  } catch {
    return undefined
  }
}

function revParse(cwd: string, rev: string): string | undefined {
  return tryGit(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])?.trim() || undefined
}

/** One file of a unified diff, with the lines that were added and removed. */
interface FileDiff {
  readonly file: string
  readonly added: string[]
  readonly removed: string[]
}

/**
 * Parse `git diff`/`git log -p` output into per-file additions and removals. `-U0` is assumed, so every line inside a
 * hunk body is either `+` or `-` (a context line cannot appear), which makes the parse one pass and unambiguous.
 */
function parseDiffs(text: string): FileDiff[] {
  const files: FileDiff[] = []
  let current: { file: string; added: string[]; removed: string[] } | undefined
  let inHunk = false

  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.startsWith('diff --git ')) {
      current = { file: '', added: [], removed: [] }
      files.push(current)
      inHunk = false
      continue
    }
    if (current === undefined) continue

    if (line.startsWith('+++ ')) {
      current.file = pathOf(line.slice(4)) ?? current.file
      inHunk = false
      continue
    }
    if (line.startsWith('--- ')) {
      // Only a delete has no new path; keep the old one so the file is still named.
      const old = pathOf(line.slice(4))
      if (current.file === '' && old !== undefined) current.file = old
      inHunk = false
      continue
    }
    if (line.startsWith('@@')) {
      inHunk = true
      continue
    }
    if (!inHunk) continue
    if (line.startsWith('\\')) continue // "\ No newline at end of file"

    if (line.startsWith('+')) current.added.push(line.slice(1))
    else if (line.startsWith('-')) current.removed.push(line.slice(1))
  }

  return files.filter((file) => file.file !== '')
}

/** `b/src/a.ts` -> `src/a.ts`; `/dev/null` -> undefined; a C-quoted path is unquoted. */
function pathOf(raw: string): string | undefined {
  const quoted = raw.startsWith('"')
  const text = quoted ? unquote(raw) : raw
  const path = text.startsWith('a/') || text.startsWith('b/') ? text.slice(2) : text
  if (path === '/dev/null' || path === 'dev/null' || path === '') return undefined
  return path
}

function unquote(raw: string): string {
  // git C-quotes a path that carries a non-ASCII byte or a quote. The escapes a path in this repo can meet are \\ and
  // \"; \a, \t and octal escapes need a filename no checkout of this repo has.
  return raw.slice(1, -1).replace(/\\(["\\])/g, '$1')
}

/** Every commit `base` gained after `mergeBase`, with the lines each added. One `git log -p`, not one call per commit. */
function additionsSince(cwd: string, mergeBase: string, base: string): MainAddition[] {
  const log = git(cwd, [
    'log',
    '--no-merges',
    '--no-color',
    '--no-ext-diff',
    // %x00/%x01, not a literal NUL: an argv element cannot carry one.
    '--format=%x00%H%x01%s',
    '--patch',
    '--unified=0',
    `${mergeBase}..${base}`,
  ])

  const additions: MainAddition[] = []
  let commit = ''
  let subject = ''
  let chunk: string[] = []

  const flush = (): void => {
    if (commit === '' || chunk.length === 0) return
    for (const file of parseDiffs(chunk.join('\n'))) {
      for (const text of file.added) additions.push({ file: file.file, text, commit, subject })
    }
  }

  for (const line of log.split('\n')) {
    if (line.startsWith('\u0000')) {
      flush()
      const [hash = '', rest = ''] = line.slice(1).split('\u0001')
      commit = hash.trim()
      subject = rest.trim()
      chunk = []
      continue
    }
    chunk.push(line)
  }
  flush()
  return additions
}

/** The lines `head` lacks that `base` has, across the files `head` touched. */
function deletions(cwd: string, base: string, head: string, touched: readonly string[]): DeletedLine[] {
  if (touched.length === 0) return []
  const diff = git(cwd, ['diff', '--no-color', '--no-ext-diff', '--unified=0', base, head, '--', ...touched])
  const deleted: DeletedLine[] = []
  for (const file of parseDiffs(diff)) {
    for (const text of file.removed) deleted.push({ file: file.file, text })
  }
  return deleted
}

// ---------------------------------------------------------------- the check

export interface CheckResult {
  /** 0 clean or declared, 1 stale, 2 could not run. */
  readonly code: 0 | 1 | 2
  readonly findings: readonly Finding[]
  readonly declared: readonly string[]
  readonly summary: string
}

/**
 * The whole check, as one value: what a PR would revert, whether its body declares it, and the verdict. `cwd` is the
 * checkout to read; nothing here depends on HEAD being the branch under review.
 */
export function check(input: {
  readonly cwd: string
  readonly base: string
  readonly head: string
  readonly body: string
  readonly log?: (line: string) => void
}): CheckResult {
  const { base, head } = input
  const fail = (summary: string): CheckResult => ({ code: 2, findings: [], declared: [], summary })

  const baseSha = revParse(input.cwd, base)
  if (baseSha === undefined) return fail(`cannot resolve the base ref ${base}; fetch it before running the guard`)
  const headSha = revParse(input.cwd, head)
  if (headSha === undefined) return fail(`cannot resolve the head ref ${head}`)

  const mergeBase = tryGit(input.cwd, ['merge-base', baseSha, headSha])?.trim()
  if (mergeBase === undefined || mergeBase === '') {
    return fail(`no merge-base between ${base} and ${head}: nothing to compare`)
  }

  // Fast path, and the common one: a PR branched at main's tip has no commits to have missed.
  const since = tryGit(input.cwd, ['rev-list', '--no-merges', `${mergeBase}..${baseSha}`])
  if (since === undefined) return fail('cannot list the commits main gained since the merge-base')
  if (since.trim() === '') {
    return { code: 0, findings: [], declared: [], summary: `${head} branched at ${base}'s tip; nothing has landed since` }
  }

  const touched = (tryGit(input.cwd, ['diff', '--name-only', mergeBase, headSha]) ?? '')
    .split('\n')
    .map((path) => path.trim())
    .filter((path) => path !== '')
  if (touched.length === 0) {
    return { code: 0, findings: [], declared: [], summary: `${head} changes no files` }
  }

  const added = additionsSince(input.cwd, mergeBase, baseSha)
  const deleted = deletions(input.cwd, baseSha, headSha, touched)
  const findings = judge(added, deleted)
  const declared = parseDeclaredReverts(input.body)

  if (findings.length === 0) {
    return { code: 0, findings, declared, summary: `${head} keeps every line ${base} gained since ${mergeBase.slice(0, 7)}` }
  }
  if (declared.length > 0) {
    return {
      code: 0,
      findings,
      declared,
      summary: `${head} drops ${findings.length} line(s) ${base} gained, declared as a revert of ${declared.join(' ')}`,
    }
  }
  return {
    code: 1,
    findings,
    declared,
    summary: `${head} would revert ${findings.length} line(s) that landed on ${base} after it branched`,
  }
}

function bodyFrom(args: readonly string[]): string {
  const index = args.indexOf('--body-file')
  if (index >= 0) {
    const path = args[index + 1]
    if (path === undefined) throw new Error('--body-file needs a path')
    return readFileSync(path, 'utf8')
  }
  const eventPath = process.env['GITHUB_EVENT_PATH']
  if (eventPath === undefined || eventPath === '') return ''
  try {
    const event = JSON.parse(readFileSync(eventPath, 'utf8')) as { pull_request?: { body?: string | null } }
    return event.pull_request?.body ?? ''
  } catch {
    return ''
  }
}

function flag(args: readonly string[], name: string, fallback: string): string {
  const index = args.indexOf(name)
  if (index < 0) return fallback
  const value = args[index + 1]
  return value === undefined || value.startsWith('--') ? fallback : value
}

function main(argv: readonly string[]): number {
  const body = bodyFrom(argv)
  const result = check({
    cwd: process.cwd(),
    base: flag(argv, '--base', 'origin/main'),
    head: flag(argv, '--head', 'HEAD'),
    body,
  })

  if (result.code === 2) {
    console.log(`::error::stale-squash-guard could not run: ${result.summary}`)
    return 2
  }

  if (result.code === 1) {
    // One annotation per (file, commit), not per line: a stale squash drops a whole file's worth at once, and fifty
    // identical annotations bury the two facts that matter — which files, and which commits added what is going.
    const groups = groupByOrigin(result.findings)
    for (const group of groups.slice(0, LISTED)) {
      const shown = group.texts.slice(0, SAMPLES).map((text) => `\`${text.trim()}\``)
      const rest = group.texts.length - shown.length
      const detail =
        `${group.texts.length} line(s) added by ${group.commit.slice(0, 7)} (${group.subject}) would be deleted` +
        (shown.length > 0 ? `, e.g. ${shown.join(', ')}` : '') +
        (rest > 0 ? ` and ${rest} more` : '')
      console.log(`::error file=${group.file}::${detail}`)
    }
    if (groups.length > LISTED) {
      console.log(`::error::…and ${groups.length - LISTED} more file(s) in the same state`)
    }
    console.log('')
    console.log(`${result.summary}.`)
    console.log('')
    console.log('This branch predates work that is already on main; a squash merge would delete it, and the tests that')
    console.log('covered it would go with it — which is how a red main shipped green (#179, restored by #187).')
    console.log('')
    console.log('Rebase the branch onto main and re-run, so the PR diff says what it actually changes. If the revert is')
    console.log('deliberate, say so in the PR body on a line of its own — `Revert: #<pr>` — and the check will pass and')
    console.log('record the declaration.')
    return 1
  }

  console.log(result.summary)
  if (result.declared.length > 0) {
    // The declaration passes the PR, not the log: what it drops is still written down, per file and commit.
    for (const group of groupByOrigin(result.findings)) {
      console.log(`  declared revert: ${group.file}, ${group.texts.length} line(s) from ${group.commit.slice(0, 7)} (${group.subject})`)
    }
  }
  return 0
}

/** Resolved both ways through realpath: a temp dir reached as /tmp and as /private/tmp must compare equal. */
function invokedDirectly(): boolean {
  const self = process.argv[1]
  if (self === undefined) return false
  try {
    return realpathSync(self) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (invokedDirectly()) process.exitCode = main(process.argv.slice(2))
