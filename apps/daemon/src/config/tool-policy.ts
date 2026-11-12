/**
 * The tool policy a peer starts with (TASK-119), and the one place its defaults live.
 *
 * The defaults are decision-6 option 3: work inside the worktree (reads, writes, edits,
 * shell) runs without asking; network and anything outside the worktree are denied;
 * pushing to main and merging a PR still ask, because those are the supervisor's.
 * The rules live in `routineToolPolicy`, nowhere else: the profile block chooses a
 * preset, and the preset's rules are not repeated anywhere.
 *
 * A guard rail, not a sandbox: a shell command can still reach what the rules do
 * not name (`python -c`, `node -e`, a package manager). Keeping a peer off the network or
 * off main for certain takes an egress firewall and server-side branch protection. The adapter's `compilePolicy` and `evaluatePolicy` decide each call.
 */

import type { ToolPolicy } from '@fleet/foundation-contracts'

/** The profile's presets: `routine` is the default, `ask-all` is the behaviour before this block existed. */
export const toolPolicyPresets = ['routine', 'ask-all'] as const
export type ToolPolicyPreset = (typeof toolPolicyPresets)[number]

/** The profile's `toolPolicy` block. Absent, or an empty block, is the routine preset. */
export interface ProfileToolPolicy {
  readonly preset?: ToolPolicyPreset
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * A path that leaves the worktree, for the tools whose subject is the whole JSON
 * input (`Grep`, `Glob`, `MultiEdit`). A deny is a search, so this catches the path
 * wherever it sits. It is outside when it is absolute and not under `cwd`, climbs
 * with `..`, or starts with `~` (the tools do not expand it, but it names the home
 * directory to anyone who reads the path as one).
 */
const outsideWorktreeInJson = (cwd: string): string =>
  `"(?:path|file_path)":"(?:~|(?!${escapeRegExp(cwd)}(?:/|"))/|(?:[^"]*/)?\\.\\.(?:/|"))`

/**
 * A glob that names a path outside the worktree, for the search tools whose glob is
 * a path pattern rather than a `path` key: `Glob`'s `pattern` and `Grep`'s `glob`.
 * A glob is relative to the worktree unless it starts with `/` or `~`, or climbs
 * with `..`. `Grep`'s own `pattern` is a regex and is not checked here.
 */
const outsideGlobInJson = (key: 'pattern' | 'glob'): string =>
  `"${key}":"(?:~|/|(?:[^"]*/)?\\.\\.(?:/|"))`

/**
 * A glob made only of characters that name a plain relative path: letters, digits,
 * `_ . / * ? -`. Anything else (braces, brackets, extglobs, backslashes, `~`, a
 * leading `/`) is not matched, so it is not auto-allowed: the search tools' glob
 * dialects are wider than a regex can check, so the policy fails closed on them.
 */
const SAFE_GLOB_CHARS = '[\\w./*?-]'

/**
 * A path that leaves the worktree, for the tools the adapter matches against the
 * resolved file path (`Read`, `Write`, `Edit`). The path is already absolute and
 * normalised by then, so outside means not under `cwd`, with the boundary checked
 * so a sibling sharing its prefix (`/work/widgets-evil`) is outside too.
 */
const outsideWorktreeResolved = (cwd: string): string => `^(?!${escapeRegExp(cwd)}(?:/|$))`

/** Shell commands that reach the network. Searched anywhere in the command, so a chained one is caught too. */
const NETWORK_COMMAND = '(?:^|[\\s;&|(\\x60/"\'])(?:curl|wget|ssh|scp|sftp|rsync|nc|ncat|telnet|ftp)(?:[\\s"\\x27]|$)'

/**
 * `git status` and `git diff`, with the flags that only read. A flag that writes
 * a file (`--output`) or runs a program (`--ext-diff`) is not in the list, so the
 * command asks instead. An allow covers the whole command, so a chained one never
 * matches (the adapter checks that before the pattern).
 */
const GIT_READ =
  'git (?:status|diff)(?: --(?:stat|name-only|name-status|cached|staged|no-color|short|porcelain))*(?: (?:--|[\\w./~^@][\\w./~^@-]*))*'

/** Where a command word may start: line start, after a separator or a subshell, or after a path (`/usr/bin/git`). */
const WORD_START = '(?:^|[\\s;&|(\\x60/"\'])'

/**
 * The one push a peer makes without asking: `git push [-u] [origin] <branch>`, a plain branch name that is
 * not main or master. Everything else that pushes (`--force` and every abbreviation of it, `--mirror`,
 * `--delete`, `+` and wildcard refspecs, `HEAD:main`, `git -c ...`, a bare `git push`, a split line) asks,
 * because a denylist of bad flags cannot keep up with git's own spellings. An allow covers the whole
 * command, so a chained one never matches it.
 */
const SAFE_PUSH = 'git push(?: (?:-u|--set-upstream))?(?: origin)? (?!(?:main|master)$)\\w[\\w./-]*'

/** Any command that pushes: it asks unless `SAFE_PUSH` already allowed it (rules run in order). */
const ANY_PUSH = `${WORD_START}git\\b[\\s\\S]*\\bpush\\b`

/** A PR merge or a raw `gh api` call is the supervisor's to do, so a peer asks. */
const GH_SUPERVISOR = `${WORD_START}gh\\b[\\s\\S]*\\b(?:merge|api)\\b`

/**
 * The routine default set: decision-6 option 3. The one place its rules are written.
 * Rules are in order and the first match wins, so the denies come before the allows.
 */
export const routineToolPolicy = (cwd: string): ToolPolicy => {
  const resolvedPathTools = ['Read', 'Write', 'Edit']
  const jsonPathTools = ['MultiEdit', 'Grep', 'Glob']
  return {
    defaultAction: 'allow',
    rules: [
      { tool: 'WebFetch', action: 'deny' },
      { tool: 'WebSearch', action: 'deny' },
      { tool: 'Bash', pattern: NETWORK_COMMAND, action: 'deny' },
      { tool: 'Bash', pattern: SAFE_PUSH, action: 'allow' },
      { tool: 'Bash', pattern: ANY_PUSH, action: 'ask' },
      { tool: 'Bash', pattern: GH_SUPERVISOR, action: 'ask' },
      ...resolvedPathTools.map((tool) => ({ tool, pattern: outsideWorktreeResolved(cwd), action: 'deny' as const })),
      ...jsonPathTools.map((tool) => ({ tool, pattern: outsideWorktreeInJson(cwd), action: 'deny' as const })),
      { tool: 'Glob', pattern: outsideGlobInJson('pattern'), action: 'deny' },
      { tool: 'Grep', pattern: outsideGlobInJson('glob'), action: 'deny' },
      { tool: 'Read', action: 'allow' },
      // A glob outside the plain relative set asks; the rest of each tool is allowed.
      // (An allow rule must cover the whole input, so the unsafe case is an ask, not
      // a narrow allow.)
      { tool: 'Grep', pattern: `"glob":"(?!${SAFE_GLOB_CHARS}*")`, action: 'ask' },
      { tool: 'Glob', pattern: `"pattern":"(?!${SAFE_GLOB_CHARS}*")`, action: 'ask' },
      { tool: 'Grep', action: 'allow' },
      { tool: 'Glob', action: 'allow' },
      { tool: 'Bash', pattern: GIT_READ, action: 'allow' },
    ],
  }
}

/**
 * The policy a peer's session starts with, or `undefined` for `ask-all`, which is
 * what a session with no policy gets. `cwd` is the session's own worktree.
 */
export const toolPolicyFor = (block: ProfileToolPolicy | undefined, cwd: string): ToolPolicy | undefined =>
  (block?.preset ?? 'routine') === 'routine' ? routineToolPolicy(cwd) : undefined
