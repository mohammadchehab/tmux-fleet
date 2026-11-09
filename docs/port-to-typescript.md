# Porting tmux-fleet from bash/python to Node.js + TypeScript

**Status:** plan for review. No porting starts until this is approved.

**Goal:** move every script the fleet runs from bash (and two from Python) to Node.js + TypeScript,
with no change in behaviour that a peer, a skill, a hook or the user can observe.

**Baseline, measured on `origin/main` (`643bbda`) in `.claude/worktrees/port-typescript`:**

| gate | baseline |
| :- | :- |
| `task test` | **211 passed, 0 failed** |
| `dev-tasks/scripts/test/cmd.sh` | 49 |
| `dev-tasks/scripts/test/pane.sh` | 15 |
| `dev-tasks/scripts/test/profile-init.sh` | 16 |
| `dev-tasks/scripts/test/profile.sh` | 26 |
| `dev-tasks/scripts/test/resume.sh` | 58 |
| `dev-tasks/scripts/test/tmux-isolation.sh` | 150 |
| `dev-tasks/scripts/test/worktrees.sh` | 37 |
| `dev-tasks/scripts/test/wt.sh` | 71 |
| `task lint` | 44 scripts shellcheck-clean, 16 skill frontmatters ok, 2 profiles checked |

Every slice below must leave those numbers at or above their baseline, with 0 failures.

---

## 1. What is in scope

53 scripts, 5,000 lines. Three kinds, and the distinction drives the whole plan:

- **46 entry points** — `#!/usr/bin/env bash`, run as commands. Portable behind a shim.
- **7 sourced libraries** — `skills/fleet/scripts/lib/*.sh` plus `dev-tasks/scripts/lib/env.sh`.
  Never executed; `source`d into a caller and defining functions and variables there.
- **2 Python** — `skills/fleet/scripts/fleet-reply-log`, `skills/fleet-clear/scripts/peer-tokens`.

The libraries are the hard part: their callers include **the test suite itself**, in-process. See §3.

### Inventory

Columns: **reads** = env and files it consumes; **writes** = state it changes; **slice** = the PR that ports it (§6).

#### Command dispatch and shared libraries

| path | LOC | reads | writes | slice |
| :- | --: | :- | :- | :- |
| `bin/fleet` | 88 | `FLEET_CHECKOUT`, `FLEET_PROFILE`, argv; symlink chain to find the checkout; `_list` runs `lib/tmux.sh` | nothing (execs) | 4 |
| `lib/tmux.sh` | 82 | `FLEET_TMUX`, `TMUX`, `TMUX_PANE`, `FLEET_PROFILE`, `FLEET_STATE`, `HOME` | nothing | 1 |
| `lib/profile.sh` | 45 | `FLEET_PROFILE`, `FLEET_USER_PROFILES_DIR`, `XDG_CONFIG_HOME`, `FLEET_PROFILES_DIR`, `FLEET_REPO`, profile `.env`; sets `REPO` **in the caller's scope** | nothing | 1 |
| `lib/lock.sh` | 55 | `FLEET_LOCK_WAIT`, `FLEET_LOCKS`; lock folder contents (`pid`, `cmd`, `since`) | `<dir>/locks/<name>.lock/`, exports `FLEET_LOCKS` | **stays bash** (§3) |
| `lib/pane.sh` | 60 | `@fleet-cli` tmux option; pane text on stdin; `#{pane_current_command}` | nothing (pure text filter) | 2 |
| `lib/roster.sh` | 62 | `$FLEET_STATE/roster.d/<peer>` (`key=value` lines) | `roster.d/<peer>`, atomic rewrite via `mktemp`+`mv` | 2 |
| `lib/backlog.sh` | 63 | `FLEET_BACKLOG_BIN`, `FLEET_BOARD_PORT`, `FLEET_SESSION_PROFILE`; `backlog --version`; `jq` | `$FLEET_STATE/backlog/`, `$FLEET_STATE/backlog-mcp.json`; starts a tmux session | 2 |
| `lib/worktree.sh` | 270 | `FLEET_HOME`, `FLEET_REPO`, `FLEET_PROFILE`, `FLEET_PROFILES_DIR`, `FLEET_WT_CACHE`, `FLEET_WT_IDLE_DAYS`, `FLEET_OPENCODE_WT_ROOT`, `FLEET_ROLES_DIR`; `git worktree list`, `gh pr list`, `lsof`, `du -sk`, `stat -f/-c`, `awk`, `jq` | `.git/info/exclude` (one line), `<git-dir>/fleet-owner`, `$FLEET_WT_CACHE/*.tsv/json` | 3 |
| `dev-tasks/scripts/lib/env.sh` | 13 | `FLEET_PROFILE`, `FLEET_STATE`, `CLAUDE_SKILLS`, `CURSOR_SKILLS`, `FLEET_INSTALL_LOCK_DIR` | nothing | 1 |

#### `skills/fleet/scripts` — lifecycle

| path | LOC | reads | writes | slice |
| :- | --: | :- | :- | :- |
| `fleet-up` | 292 | 25+ `FLEET_*` vars; `squads/`, `roles/*.md`, `models`, `hooks/peer-settings.json`; `roster.d/`; `git`, `tmux`, `agent`, `opencode`, `ori`, `awk`; `~/.config/deepinfra/key` | `roster.d/<peer>`; tmux sessions `fleet-<profile>[-<peer>]` with `@fleet-role`, `@fleet-cli`, `@fleet-profile`; `$FLEET_STATE/`, `backlog/`; worktrees in `<repo>/.claude/worktrees/<peer>`; `.git/info/exclude` | 7 |
| `fleet-down` | 23 | tmux sessions of this profile; target repo | kills sessions; prints worktree summary | 7 |
| `fleet-view` | 28 | running peers; tmux | rebuilds `fleet-<profile>` session (tiled nested attaches) | 7 |
| `fleet-attach` | 23 | tmux; `fleet-view` | view session (only when it must rebuild it) | 7 |
| `fleet-scale` | 96 | running peers; worktree state; `fleet-up`/`fleet-down`; `FLEET_*` | starts/stops one peer; prunes roster | 7 |
| `fleet-handoff` | 50 | `$FLEET_STATE/{handoff,<peer>-state}.md`; tmux pane | spawns detached waiter; `$FLEET_STATE/handoff-<peer>.log` | 7 |
| `fleet-board` | 42 | `FLEET_BOARD_*`, `TMUX`, `TERM_PROGRAM`; backlog CLI | starts board session; opens browser / tmux split | 9 |

#### `skills/fleet/scripts` — read-only and messaging

| path | LOC | reads | writes | slice |
| :- | --: | :- | :- | :- |
| `fleet-ls` | 46 | tmux sessions+options; `backlog`; worktree cache | **nothing** (read-only, no lock) | 5 |
| `fleet-peek` | 19 | tmux `capture-pane`; `@fleet-cli` | nothing (types nothing) | 5 |
| `fleet-send` | 24 | tmux panes; `-f`, `-i`; pane state | types into panes | 6 |
| `fleet-session-record` | 27 | hook JSON on **stdin** (`session_id`) | `roster.d/<peer>` (session_id line only) | 6 |
| `fleet-reply-log` | 74 | hook JSON on stdin | appends to `$FLEET_STATE/replies.log` | 6 |
| `fleet-clear-heavy` | 26 | pane text; `-n`, threshold | types into panes | 6 |
| `fleet-worktree` | 266 | see `lib/worktree.sh`; `gh pr list --json`; `git` | worktrees; `.git/info/exclude`; owner file; `--yes` removes | 8 |
| `fleet-handoff` (shim) | 3 | — | execs `skills/fleet-handoff/scripts/fleet-handoff` | 7 |

#### Other skills

| path | LOC | reads | writes | slice |
| :- | --: | :- | :- | :- |
| `fleet-clear/scripts/fleet-clear` | 66 | `peer-tokens`; pane state; `FLEET_CLEAR_*` | types into panes; lock `clear` | 6 |
| `fleet-clear/scripts/peer-tokens` | 28 | `~/.claude/projects/*/**.jsonl` (newest per cwd); `FLEET_CLAUDE_PROJECTS` | nothing (read-only) | 6 |
| `fleet-capacity/scripts/fleet-capacity` | 75 | tmux panes; worktree cache; `backlog task list --json`; `fleet-context.md` | nothing | 5 |
| `fleet-pr-queue/scripts/fleet-pr-queue` | 34 | `gh pr list --json` incl. `statusCheckRollup` | nothing | 5 |
| `fleet-cc-send/scripts/cc-send` | 66 | `/tmp/cc-socks/*.sock`; iTerm2 TTY | types into iTerm2 sessions | 6 |
| `fleet-board/scripts/board-jira` | 61 | JSON array on **stdin**; `backlog` CLI | `$FLEET_STATE/backlog/` tasks+milestones; lock `board` | 9 |
| `fleet-board/scripts/board-docs` | 49 | target repo's tracked `.md`; `FLEET_BOARD_DOCS`, `FLEET_REPO` | `$FLEET_STATE/backlog/docs/repo/<path>`; lock `board` | 9 |
| `fleet-board/scripts/board-decision` | 46 | `backlog` CLI | `$FLEET_STATE/backlog/decisions/decision-<n>.md`; lock `board` | 9 |
| `codegraph/scripts/codegraph-ensure` | 28 | `codegraph`, npm; `.codegraph/` | global npm install; `<main>/.codegraph/`; `.git/info/exclude` | 10 |

#### dev-tasks

| path | LOC | reads | writes | slice |
| :- | --: | :- | :- | :- |
| `install/link.sh` | 32 | `skills/*/`; target dir listing | symlinks in `~/.claude/skills`, `~/.cursor/skills`; install lock | 10 |
| `install/bin.sh` | 16 | `FLEET_BIN`, `PATH` | `<dir>/fleet` symlink; install lock | 10 |
| `install/uninstall.sh` | 17 | the two skill dirs, bin dir | removes only our symlinks; install lock | 10 |
| `install/update.sh` | 27 | git state of this checkout | fast-forward `main`; then link + backlog | 10 |
| `install/backlog.sh` | 15 | `FLEET_BACKLOG_VERSION` from `lib/backlog.sh` | global npm install; install lock | 10 |
| `install/completion.sh` | 43 | `fleet _list …` at completion time | nothing (prints bash/zsh completion) | 10 |
| `lint/shell.sh` | 16 | every shebang'd script | nothing | 10 |
| `lint/skills.sh` | 31 | `SKILL.md` frontmatter; Jira-key regexes across `skills/`, `README.md`, `profiles/`, `dev-tasks/` | nothing | 10 |
| `lint/profile.sh` | 49 | `profiles/*.env`; target repo's `AGENTS.md` | nothing | 10 |
| `profile/init.sh` | 35 | `profiles/example.env`; `git`; squads | `~/.config/fleet/profiles/<name>.env` (never overwrites) | 10 |
| `clean/clean.sh` | 47 | worktrees; `$FLEET_STATE`; tmux; `--force`, `--sessions` | removes worktrees (**only with `--force`**), kills sessions (**only with `--sessions`**); never deletes state files | 10 |

**Not ported:** `skills/*/SKILL.md`, `skills/fleet/roles/*.md`, `squads/*`, `models`, `profiles/*.env`,
`hooks/peer-settings.json`, `README.md`, `Taskfile.yaml` are data and documentation.

**Deliberately last (in flight on other branches):** `fleet-dispatch` + `fleet-judge` (PR #12) and the
`fleet-context-guard` Stop hook (PR #13). Porting a file that is being rewritten in another PR guarantees a
conflict. These get one final slice once both merge.

---

## 2. Target layout

```
package.json                 # "type": "module", engines.node ">=22.18", no runtime dependencies
tsconfig.json                # strict; noEmit; noUncheckedIndexedAccess; exactOptionalPropertyTypes
src/
  cli/                       # one file per entry point — the same names as the scripts
    fleet.ts                 # the dispatcher that was bin/fleet
    fleet-up.ts  fleet-down.ts  fleet-ls.ts  fleet-attach.ts  fleet-board.ts
    fleet-view.ts  fleet-send.ts  fleet-peek.ts  fleet-worktree.ts  fleet-scale.ts
    fleet-clear.ts  fleet-clear-heavy.ts  fleet-capacity.ts  fleet-handoff.ts
    fleet-pr-queue.ts  fleet-session-record.ts  fleet-reply-log.ts  peer-tokens.ts
    cc-send.ts  codegraph-ensure.ts
    board-jira.ts  board-docs.ts  board-decision.ts
    link.ts  bin-link.ts  uninstall.ts  update.ts  backlog-install.ts  completion.ts
    lint-shell.ts  lint-skills.ts  lint-profile.ts  profile-init.ts  clean.ts
  lib/
    exec.ts                  # spawn argv-array children, capture out/err/rc, inherit stdio
    shell-quote.ts           # bash printf %q, byte-identical (§7.2)
    state.ts                 # FLEET_STATE / fleet_state_dir resolution, mkdir helpers
    profile.ts               # profile .env parser, FLEET_ROOT, resolveRepo
    tmux.ts                  # socket flags, session naming, targets, tagging, peers, capture
    pane.ts                  # pane text cleaning and state classification
    roster.ts                # roster.d read/write/prune
    backlog.ts               # board CLI, port, URL, init, start, mcp config
    worktree.ts              # main checkout, root, owner, branch state, scan, cache
    output.ts                # stdout/stderr writers, usage(), die()
  devtasks/                  # helpers only the dev-tasks commands use
    git.ts  symlink.ts  frontmatter.ts
tests/
  unit/                      # node:test, one file per src/lib module
skills/fleet/scripts/lib/*.sh # bash adaptors (lock.sh unchanged) — see §3
```

**Runtime choice: run the TypeScript directly.** Node ≥22.18 strips types natively, so `node src/cli/fleet-up.ts`
just runs. This machine has Node 26.11 and both `node t.ts` and `node --experimental-strip-types t.ts` work.
Consequences, all of them good:

- **No build step, no `dist/`.** Nothing to keep in sync with the symlinks; `git` and the hook paths stay honest.
- **Type stripping forbids** `enum`, `namespace`, parameter properties, and `import =`. Enumerations become
  `const` object + union type. This is a constraint on every file, so it is a Global Constraint, not a style note.
- `tsc` is a **typechecker only** (`--noEmit`), run by `task lint`, never by the commands.
- **Zero runtime dependencies.** Only `devDependencies`: `typescript`, `@types/node`. No `tsx`, no bundler,
  no `ts-node`. Everything else is `node:` builtins — `node:child_process`, `node:fs/promises`, `node:path`,
  `node:os`, `node:test`.

`jq` disappears (`JSON.parse`), `awk` disappears (string ops), `sed` disappears (regex), `stat -f/-c` disappears
(`fs.stat`), `cksum` stays only where its output is a hash input (`fleet_board_port`, cache keys) — reproduced
with the same `cksum` algorithm so ports and cache filenames do not move.

---

## 3. The compatibility layer, and the one thing that cannot go to TypeScript

The brief asks that the existing tests run unchanged. **Six of the nine test files do not execute the scripts —
they `source` the libraries and call functions in-process**, and assert on effects that belong to the shell
process, not to a program:

| test | line | what it needs |
| :- | :- | :- |
| `cmd.sh` | `source "$L"; fleet_lock "$D" x 20 …` × 7 | a lock **held for the caller's lifetime**, released by its EXIT trap, `FLEET_LOCKS` **exported** to children it spawns |
| `pane.sh` | `source "$ROOT/skills/fleet/scripts/lib/pane.sh"`, then `fleet_pane_state`, `fleet_pane_reply` in a pipe | functions callable with stdin/stdout |
| `profile.sh` | `source '$LIB'; fleet_resolve_repo && echo "$REPO"` | sets `REPO` **in the caller's shell** |
| `worktrees.sh` | `source '$LIB'; fleet_main_checkout …; fleet_worktree_root …` | functions callable in-process |
| `wt.sh` | `source …/worktree.sh; fleet_worktree_owner_set …`, `fleet_worktree_exclude`, `fleet_lock` | same |
| `tmux-isolation.sh` | `source …/lib/lock.sh; fleet_lock …` | same lock contract |

A separate `node` process cannot hold a lock for the lifetime of a *different* shell, cannot export a variable into
its parent, and cannot assign to its caller's `REPO`. So:

> **A full port of the libraries to TypeScript and byte-identical tests are mutually exclusive.**

### The resolution: every lib keeps its name and stays sourceable; the logic moves out except the lock

`skills/fleet/scripts/lib/*.sh` survive as **thin bash adaptors** over `src/lib/*.ts`, and keep their documented
function names. Tests stay byte-identical, and the implementation is TypeScript.

```bash
# lib/pane.sh, after the port
_fleet_lib_ts() { node "$_FLEET_ROOT/src/lib/pane.ts" "$@"; }
fleet_pane_state()   { _fleet_lib_ts state  "$@"; }
fleet_pane_reply()   { _fleet_lib_ts reply  "$@"; }   # stdin -> stdout, unchanged
fleet_pane_clean()   { _fleet_lib_ts clean  "$@"; }
```

```bash
# lib/profile.sh, after the port — the caller-scope assignment is why this evals
fleet_resolve_repo() { local out; out=$(_fleet_lib_ts resolve-repo) || return 1; eval "$out"; }  # REPO='…'
fleet_load_profile() { _fleet_lib_ts load-profile "$@"; }   # subscribes the env vars via `eval` too
```

**`lib/lock.sh` stays bash, permanently, and is not ported.** It is 55 lines, it is correct, and its contract —
`mkdir` atomicity, a holder that outlives its caller, an EXIT trap, `FLEET_LOCKS` re-entrancy across `bash -c`
children — is process-lifetime semantics. Emulating it from Node would mean writing the same code twice and
letting the two drift; the tests would then be testing the copy nobody runs.

**The consequence for the ported commands:** they must take their locks through the same bash, so the **shim
takes the lock**, before handing over to Node:

```bash
#!/usr/bin/env bash
# shim — the implementation is src/cli/fleet-up.ts
set -euo pipefail
_FLEET_ROOT=$(<resolve this file's real path, /../../../..>)
source "$_FLEET_ROOT/skills/fleet/scripts/lib/lock.sh"
source "$_FLEET_ROOT/skills/fleet/scripts/lib/tmux.sh"
fleet_lock "$(fleet_state_dir)" fleet "${FLEET_LOCK_WAIT:-60}" "$@" || exit 1
node "$_FLEET_ROOT/src/cli/fleet-up.ts" "$@"   # not exec: the EXIT trap must still release the lock
exit $?
```

The holder pid is the shim's, `basename "$0"` is still `fleet-up`, so both the lock file's `cmd` field and the
`busy: … is held by pid N (fleet-up, 3 s)` message are byte-identical. `node` is a child, not an `exec`, purely
so the trap survives.

**Locks per command** (from `lib/lock.sh`'s header, which stays authoritative):

| lock | commands |
| :- | :- |
| `fleet` | fleet-up, fleet-down, fleet-scale, fleet-view |
| `clear` | fleet-clear |
| `handoff-<peer>` | fleet-handoff |
| `board` | board-jira, board-docs, board-decision |
| `board-page` | starting the board's page (fleet-up, fleet-board) |
| `install` (in `~/.fleet-state/locks`) | install, update, link, backlog |

Commands that take no lock keep a shim with no lock line.

### If Mohammad prefers a clean break instead

The alternative is to port `lock.sh` to TypeScript as well and let the **six test files change shape**: each
`source … && fleet_lock …` assertion moves into `tests/unit/lock.test.ts`, and the shell test keeps only
entry-point-level assertions. That is a defensible end state — one language, no adaptors — but it breaks the
"tests run unchanged" acceptance criterion, so it is a decision, not an implementation detail.

**Recommendation: the adaptors.** They meet the brief as written, they leave `lock.sh` as the single source of
truth for locking, and they keep the parity proof the tests already give us.

---

## 4. What must not change

The hook entry points in `skills/fleet/hooks/peer-settings.json` are absolute paths through the symlinked skill:

```
~/.claude/skills/fleet/scripts/fleet-session-record      SessionStart + Stop
~/.claude/skills/fleet/scripts/fleet-reply-log           Stop
```

and `~/.claude/skills/fleet` is a symlink to a checkout's `skills/fleet`. **Every shim must resolve its own real
path** before deriving the checkout, or a command run through the `~/.claude/skills` link would look for `src/`
in the wrong place. The resolution is the same readlink loop `bin/fleet` uses today, and it is a shared helper.

Frozen, by contract:

- **Paths.** All 53 script paths stay executable at the same location. `task install` keeps linking *folders*,
  so nothing about the link layout changes.
- **Env.** Every `FLEET_*` variable in the inventory keeps its name, default and precedence:
  **environment > profile > the script's own default.**
- **State.** `$FLEET_STATE` layout (`roster.d/<peer>`, `replies.log`, `fleet-context.md`, `handoff.md`,
  `<peer>-state.md`, `backlog/`, `backlog-mcp.json`, `cache/*.tsv`) and every file format, unchanged.
  An interrupted port must leave a state directory the old code can still read — it does, because the formats
  do not move.
- **tmux.** Socket selection (`FLEET_TMUX` → `-L`; else `$TMUX` → `-S`; else default), session names
  `fleet[-<profile>][-<peer>]`, the `@fleet-role` / `@fleet-cli` / `@fleet-profile` tags, and every `-t =<session>:`
  exact target. A prefix-matching target is a bug the current code deliberately avoids; a port must not
  reintroduce it.
- **Output.** stdout/stderr text, ordering, and which stream. Tests `grep` these verbatim.
- **Exit codes.** `2` for usage errors, `1` for refusals and failures, `130` on SIGINT after releasing locks,
  `0` silently from the two hooks (including on every failure — `fleet-session-record` must never block a peer).

---

## 5. Testing

**Parity comes from the existing suite, unchanged.** `task test` runs `smoke.sh`, which runs the other eight.
The black-box tests already use a fake `tmux` on `PATH`, a fake `backlog`, a fake `gh`, a throwaway `HOME`, a
private `FLEET_TMUX` socket and temp `FLEET_STATE` — so they exercise the ported code with no changes at all.
Node is found through the same `PATH`, so the stubs keep working.

**Plus TypeScript unit tests** — `node --test tests/unit/`, one file per `src/lib` module, wired into `task test`
so it runs on every slice:

| module | what the unit tests pin |
| :- | :- |
| `shell-quote.ts` | `%q` parity against real bash: empty, spaces, `'`, `"`, `$`, backticks, newline, `=`, `~`, non-ASCII |
| `profile.ts` | `KEY=VALUE` parsing: comments, trailing blanks, quotes, `~`/`$HOME` expansion, empty-means-unset, env-wins, a non-`FLEET_` key ignored |
| `state.ts` | `FLEET_STATE` > `~/.fleet-state/<profile>` > `~/.fleet-state` |
| `tmux.ts` | session naming with/without profile, `=<session>:` targeting, tag filtering (the `fleet-isnadi-` prefix trap) |
| `pane.ts` | the box-drawing/alternation table; `busy`/`asking`/`held`/`unknown`/`idle` classification on captured panes |
| `worktree.ts` | `branch_state` matrix: detached, open (never pushed / tracking main), merged (ancestor, and squash), gone, open |
| `roster.ts` | read/write/prune, `session_id`-only update, corrupt entries |

`task lint` gains `tsc --noEmit` and a check that no `any` appears in `src/`.

**Per-slice gate**, no exceptions: `task test` ≥ baseline with 0 failures, `task lint` clean.

---

## 6. Port order

Twelve PRs. Each is independently shippable and leaves the fleet working. Each command's slice is:
**write the TS → point the shim at it → run the unchanged tests → only then drop the bash body** (it stays in git
history; a reviewer can `git diff HEAD~1 -- skills/fleet/scripts/<cmd>`).

| # | Title | Contents | Gate |
| --: | :- | :- | :- |
| 0 | `Document the port to TypeScript` | this file | review |
| 1 | `port: node/ts foundation + profile and tmux libs` | `package.json`, `tsconfig.json`, `src/lib/{exec,shell-quote,state,profile,tmux,output}.ts`, their unit tests, bash adaptors for `profile.sh`/`tmux.sh`/`env.sh`. No command ported yet. | 211 / lint |
| 2 | `port: pane, roster and backlog libs` | `src/lib/{pane,roster,backlog}.ts` + adaptors. First slice where unchanged tests exercise TypeScript through the adaptors. | 211 / lint |
| 3 | `port: worktree lib` | `src/lib/worktree.ts` (the scan, the cache, `du`/`lsof`/`gh`/`jq` replacements) + adaptor | 211 / lint |
| 4 | `port: bin/fleet dispatcher` | `src/cli/fleet.ts` incl. `_list`; shim for `bin/fleet` | 211 / lint |
| 5 | `port: read-only commands` | `fleet-ls`, `fleet-peek`, `fleet-capacity`, `fleet-pr-queue` | 211 / lint |
| 6 | `port: messaging and hooks` | `fleet-send`, `fleet-session-record`, `fleet-reply-log` (Python → TS), `fleet-clear`, `fleet-clear-heavy`, `peer-tokens` (Python → TS), `cc-send` | 211 / lint |
| 7 | `port: lifecycle commands` | `fleet-up`, `fleet-down`, `fleet-view`, `fleet-attach`, `fleet-scale`, `fleet-handoff`, `fleet-board` | 211 / lint |
| 8 | `port: fleet-worktree` | `fleet-worktree` (266 lines, the largest command) | 211 / lint |
| 9 | `port: board commands` | `board-jira`, `board-docs`, `board-decision` | 211 / lint |
| 10 | `port: dev-tasks` | install/link/bin/uninstall/update/backlog/completion, lint/{shell,skills,profile}, profile/init, clean; `task lint` gains `tsc --noEmit` | 211 / lint |
| 11 | `port: the in-flight scripts` | `fleet-dispatch`, `fleet-judge`, the `fleet-context-guard` hook — **only after #12 and #13 merge** | 211 / lint |
| 12 | `port: drop the dead bash` | remove what no longer has a caller; `shellcheck` now covers the shims and the tests only | 211 / lint |

Slices 1–3 change no observable behaviour at all — they add `src/` and swap library internals under
byte-identical bash entry points. That is deliberate: the parity proof lands before anything user-visible moves.

---

## 7. Risks

**7.1 Node becomes a hard runtime dependency.** Today the fleet needs bash, tmux and git. After the port it also
needs Node ≥22.18, on every machine that runs a fleet, and for the hooks that fire on every turn. Mitigation:
`task install` (and every shim) checks the version and fails with a clear message; `README` states the floor;
Node ≥22.18 is required because that is where type stripping became the default (before it, every invocation
needs `--experimental-strip-types`, and Node 22.18+ / 23.6+ is the honest floor to state).

**7.2 `printf '%q'` fidelity.** `fleet-up` builds a command string and hands it to `tmux new-session`, which parses
it in a shell. A quoting difference is a peer that starts with the wrong arguments or not at all. This is the
single sharpest edge in the port, which is why `shell-quote.ts` gets a unit test that compares against real
`bash printf '%q'` across the awkward inputs.

**7.3 Interleaved process output.** Bash writes to fd 1 unbuffered. Node's `process.stdout` can be asynchronous
for pipes, which can reorder a command's output against a child's inherited output. Mitigation: use
`fs.writeSync(1, …)` for the ordering-sensitive paths (`fleet-peek`, `fleet-ls`, `fleet-capacity`), and never
buffer a whole report before printing.

**7.4 Startup cost on the hooks.** `fleet-session-record` and `fleet-reply-log` run on every turn with a 10 s
timeout. Node starts in ~50 ms against bash's ~5 ms; harmless against the budget, but the hooks, not the
interactive commands, are where an accidental `import` of the whole tree would hurt. Keep both hooks'
import graph tiny.

**7.5 A half-ported fleet in production.** `~/.claude/skills/fleet` points at the `fleet-resume-spike` worktree,
so live commands run that checkout's code, not `main`. The port lands on `main` and reaches the live fleet only
when that worktree is updated or the link is repointed — which means **no slice can break the running fleet**,
and also that the port is not truly exercised live until then. Worth deciding when the live link moves.

**7.6 Carried-over bugs.** Porting faithfully means carrying `fleet_wt_scan`'s single-`|`-in-path assumption and
`roster_get`'s `sed` field match as-is. They are out of scope here; they get their own issue, not a quiet fix
inside a parity PR.

---

## 8. Open questions for Mohammad

1. **The adaptor layer** (§3): keep six `lib/*.sh` as bash adaptors with `lock.sh` untouched — or port the libs
   fully and rewrite the six test files' in-process assertions? Recommended: adaptors.
2. **Node ≥22.18 as a hard requirement** — acceptable, given every machine running a fleet must have it?
3. **Slice size**: twelve PRs as tabled, or fold 1–3 into one "foundation" PR and 5–6 into one "read-only +
   messaging" PR to get to six or seven?
4. **When the live `~/.claude/skills/fleet` link moves** to a checkout running the ported code (§7.5).
