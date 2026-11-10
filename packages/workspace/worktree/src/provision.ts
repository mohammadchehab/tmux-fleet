/**
 * §9's `WorktreeProvisioner` over git: a checkout for a topic, under the repo's
 * own `.claude/worktrees/`, and nothing else.
 *
 * **Where.** `<repo>/.claude/worktrees/<topic>`, the layout §9 names. The repo is
 * what git says owns `root` (`--git-common-dir`), not `root` itself, so a caller
 * that hands in a checkout that is already a worktree still gets a sibling and
 * never a nested one. `topic` is one path segment: a `/` or `..` in it would
 * make the checkout land anywhere, so it is refused rather than normalised.
 *
 * **Idempotent.** A path git already lists is returned as it is. A daemon that
 * restarts asks again for every peer, and a second `worktree add` would fail on
 * a path it made itself.
 *
 * **Never untracked.** The checkouts live inside the repo they belong to, so a repo
 * that does not ignore `.claude/worktrees/` would show every peer's tree as
 * untracked in the shared checkout, one `git add -A` from being committed. Asked
 * of git (`check-ignore`, which honours `.gitignore`, the global ignore and
 * `info/exclude` alike); when it is not ignored the path goes into the repo's own
 * `info/exclude` — local, never committed, and not an edit to anyone's tracked
 * files. A repo that already ignores it is left exactly as it was.
 *
 * **Which commit.** A new branch starts at the remote's default branch, not at
 * whatever the shared checkout has checked out: the checkout is the thing other
 * sessions switch under you, so it is the wrong answer to "where do I start".
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { WorktreeProvisioner } from '@fleet/foundation-contracts'
import { execFileGit, type GitResult, type GitRunner } from './git.ts'

const TOPIC = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const refused = (what: string, result: GitResult): Error =>
  new Error(`${what} (git exited ${String(result.code)}): ${result.stderr.trim() || 'no message'}`)

const EXCLUDE_LINE = '/.claude/worktrees/'

const trimSlash = (path: string): string => path.replace(/\/+$/, '')

export const createWorktreeProvisioner = (runner: GitRunner = execFileGit): WorktreeProvisioner => {
  const defaultBase = async (repo: string): Promise<string> => {
    const head = await runner(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repo)
    if (head.code === 0 && head.stdout.trim() !== '') return head.stdout.trim()
    const main = await runner(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'], repo)
    return main.code === 0 ? 'origin/main' : 'HEAD'
  }

  /** Keep `<repo>/.claude/worktrees/` out of the shared checkout's `git status`. */
  const keepIgnored = async (repo: string, path: string): Promise<void> => {
    const ignored = await runner(['check-ignore', '-q', path], repo)
    if (ignored.code === 0) return
    // 1 is "not ignored"; anything else is git failing, which is not licence to guess.
    if (ignored.code !== 1) throw refused(`could not ask git whether ${path} is ignored`, ignored)

    const where = await runner(['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'], repo)
    if (where.code !== 0) throw refused(`could not ask git where ${repo} keeps its exclude file`, where)
    const file = where.stdout.trim()
    const current = await readFile(file, 'utf8').catch(() => '')
    if (current.split('\n').some((line) => line.trim() === EXCLUDE_LINE)) return
    await mkdir(dirname(file), { recursive: true })
    await appendFile(file, `${current === '' || current.endsWith('\n') ? '' : '\n'}${EXCLUDE_LINE}\n`)
  }

  return {
    async ensure({ root, topic, branch, base }) {
      if (!root.startsWith('/')) throw new Error(`${root} is not an absolute path; no worktree was made`)
      if (!TOPIC.test(topic) || topic.includes('..')) {
        throw new Error(`'${topic}' is not a worktree topic: one path segment of letters, digits, '.', '_' and '-'`)
      }

      const common = await runner(['rev-parse', '--path-format=absolute', '--git-common-dir'], root)
      if (common.code !== 0) throw refused(`${root} is not a repository git knows`, common)
      const gitDir = common.stdout.trim()
      const repo = gitDir.endsWith('/.git') ? gitDir.slice(0, -'/.git'.length) : gitDir
      const path = `${repo}/.claude/worktrees/${topic}`

      const listed = await runner(['worktree', 'list', '--porcelain'], repo)
      if (listed.code !== 0) throw refused(`could not ask git which worktrees ${repo} has`, listed)
      const known = listed.stdout
        .split('\n')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => trimSlash(line.slice('worktree '.length).trim()))
      if (known.includes(path)) {
        await keepIgnored(repo, path)
        return { path, created: false }
      }

      const exists = await runner(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repo)
      const added =
        exists.code === 0
          ? await runner(['worktree', 'add', path, branch], repo)
          : await runner(['worktree', 'add', '-b', branch, path, base ?? (await defaultBase(repo))], repo)
      if (added.code !== 0) throw refused(`git refused to make the worktree at ${path}`, added)
      // After the add, not before: `check-ignore` only knows a directory pattern
      // (`.claude/worktrees/`) matches once the directory exists.
      await keepIgnored(repo, path)
      return { path, created: true }
    },
  }
}
