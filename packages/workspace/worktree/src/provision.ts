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
 * **Which commit.** A new branch starts at the remote's default branch, not at
 * whatever the shared checkout has checked out: the checkout is the thing other
 * sessions switch under you, so it is the wrong answer to "where do I start".
 */

import type { WorktreeProvisioner } from '@fleet/foundation-contracts'
import { execFileGit, type GitResult, type GitRunner } from './git.ts'

const TOPIC = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const refused = (what: string, result: GitResult): Error =>
  new Error(`${what} (git exited ${String(result.code)}): ${result.stderr.trim() || 'no message'}`)

const trimSlash = (path: string): string => path.replace(/\/+$/, '')

export const createWorktreeProvisioner = (runner: GitRunner = execFileGit): WorktreeProvisioner => {
  const defaultBase = async (repo: string): Promise<string> => {
    const head = await runner(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repo)
    if (head.code === 0 && head.stdout.trim() !== '') return head.stdout.trim()
    const main = await runner(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'], repo)
    return main.code === 0 ? 'origin/main' : 'HEAD'
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
      if (known.includes(path)) return { path, created: false }

      const exists = await runner(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repo)
      const added =
        exists.code === 0
          ? await runner(['worktree', 'add', path, branch], repo)
          : await runner(['worktree', 'add', '-b', branch, path, base ?? (await defaultBase(repo))], repo)
      if (added.code !== 0) throw refused(`git refused to make the worktree at ${path}`, added)
      return { path, created: true }
    },
  }
}
