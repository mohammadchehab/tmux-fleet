/**
 * The tool policy a peer starts with (TASK-119), and the one place its defaults live.
 *
 * The defaults are decision-6 option 1: reads and in-worktree git inspection run
 * without asking; writes and shell ask; network and anything outside the worktree
 * are denied. Option 3 of that decision (allow inside the worktree, ask for network
 * and outside paths) is a change to `routineToolPolicy`, nowhere else: the profile
 * block chooses a preset, and the preset's rules are not repeated anywhere.
 *
 * A guard rail, not a sandbox: a shell command can still reach what the rules do
 * not name. The adapter's `compilePolicy` and `evaluatePolicy` decide each call.
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
 * A path that leaves the worktree, for the tools the adapter matches against the
 * resolved file path (`Read`, `Write`, `Edit`). The path is already absolute and
 * normalised by then, so outside means not under `cwd`, with the boundary checked
 * so a sibling sharing its prefix (`/work/widgets-evil`) is outside too.
 */
const outsideWorktreeResolved = (cwd: string): string => `^(?!${escapeRegExp(cwd)}(?:/|$))`

/** Shell commands that reach the network. Searched anywhere in the command, so a chained one is caught too. */
const NETWORK_COMMAND = '(?:^|[\\s;&|(\\x60])(?:curl|wget|ssh|scp|sftp|rsync|nc|ncat|telnet|ftp)(?:\\s|$)'

/**
 * `git status` and `git diff`, with the flags that only read. A flag that writes
 * a file (`--output`) or runs a program (`--ext-diff`) is not in the list, so the
 * command asks instead. An allow covers the whole command, so a chained one never
 * matches (the adapter checks that before the pattern).
 */
const GIT_READ =
  'git (?:status|diff)(?: --(?:stat|name-only|name-status|cached|staged|no-color|short|porcelain))*(?: (?:--|[\\w./~^@][\\w./~^@-]*))*'

/**
 * The routine default set: decision-6 option 1. The one place its rules are written.
 * Rules are in order and the first match wins, so the denies come before the allows.
 */
export const routineToolPolicy = (cwd: string): ToolPolicy => {
  const resolvedPathTools = ['Read', 'Write', 'Edit']
  const jsonPathTools = ['MultiEdit', 'Grep', 'Glob']
  return {
    defaultAction: 'ask',
    rules: [
      { tool: 'WebFetch', action: 'deny' },
      { tool: 'WebSearch', action: 'deny' },
      { tool: 'Bash', pattern: NETWORK_COMMAND, action: 'deny' },
      ...resolvedPathTools.map((tool) => ({ tool, pattern: outsideWorktreeResolved(cwd), action: 'deny' as const })),
      ...jsonPathTools.map((tool) => ({ tool, pattern: outsideWorktreeInJson(cwd), action: 'deny' as const })),
      { tool: 'Read', action: 'allow' },
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
