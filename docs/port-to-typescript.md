# Porting tmux-fleet from bash/python to Node.js + TypeScript

**Status:** approved. **Mohammad's call (2026-11-09): option B, the clean break** — the whole project is
TypeScript, `lib/lock.sh` included; the six tests that call library functions in-process move those assertions into
`tests/unit`. See §3 for the decision and what it costs.

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

The counts above are the shell suite alone. Under the clean break (§3) some of them **move** into `tests/unit`
rather than staying in their file, so the gate is not "211 in the shell suite forever": it is **no assertion lost** —
`task test` reports 0 failures, and every slice's PR body states how many assertions it moved out of a shell file
and into a unit test, and the total after the move. From slice 1 on, `task test` runs the shell suite and the
TypeScript unit tests together.

---

## 1. What is in scope

53 scripts, 5,000 lines. Three kinds, and the distinction drives the whole plan:

- **46 entry points** — `#!/usr/bin/env bash`, run as commands. Portable behind a shim.
- **7 sourced libraries** — `skills/fleet/scripts/lib/*.sh` plus `dev-tasks/scripts/lib/env.sh`.
  Never executed; `source`d into a caller and defining functions and variables there.
- **2 Python** — `skills/fleet/scripts/fleet-reply-log`, `skills/fleet-clear/scripts/peer-tokens`.

The libraries are the hard part: their callers include **the test suite itself**, in-process. That is what the
clean break in §3 pays for, and why six test files change shape in slice 1.

### Inventory

Columns: **reads** = env and files it consumes; **writes** = state it changes; **slice** = the PR that ports it (§6).

#### Command dispatch and shared libraries

| path | LOC | reads | writes | slice |
| :- | --: | :- | :- | :- |
| `bin/fleet` | 88 | `FLEET_CHECKOUT`, `FLEET_PROFILE`, argv; symlink chain to find the checkout; `_list` runs `lib/tmux.sh` | nothing (execs) | 4 |
| `lib/tmux.sh` | 82 | `FLEET_TMUX`, `TMUX`, `TMUX_PANE`, `FLEET_PROFILE`, `FLEET_STATE`, `HOME` | nothing | 1 |
| `lib/profile.sh` | 45 | `FLEET_PROFILE`, `FLEET_USER_PROFILES_DIR`, `XDG_CONFIG_HOME`, `FLEET_PROFILES_DIR`, `FLEET_REPO`, profile `.env`; sets `REPO` **in the caller's scope** | nothing | 1 |
| `lib/lock.sh` | 55 | `FLEET_LOCK_WAIT`, `FLEET_LOCKS`; lock folder contents (`pid`, `cmd`, `since`) | `<dir>/locks/<name>.lock/`, exports `FLEET_LOCKS` | 1 (§3) |
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
    lock.ts                  # the lock folders, process lifetime, stale takeover, FLEET_LOCKS re-entrancy (§3)
    output.ts                # stdout/stderr writers, usage(), die()
  devtasks/                  # helpers only the dev-tasks commands use
    git.ts  symlink.ts  frontmatter.ts
tests/
  unit/                      # node:test, one file per src/lib module
dev-tasks/scripts/lib/shim.sh  # sourced by every entry-point shim: real-path resolution, then exec the TS (§3)
```

The seven `skills/fleet/scripts/lib/*.sh` files are **deleted** as their last bash caller is ported, and gone by
slice 12. Until then they are the implementation for every command that is still bash — so during the port two
implementations of a library coexist, each pinned by the tests that still use it. That is the cost of the clean
break, and it is bounded: it ends at slice 12.

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

## 3. The clean break: every library goes to TypeScript, the lock included

**Decision (Mohammad, 2026-11-09): option B.** There is one implementation of every library and no adaptor layer
between bash and TypeScript. This section records what that forces, because it is the one place where the port
cannot be invisible.

The constraint is a property of the existing tests, not a matter of preference. **Six of the nine test files do not
execute the scripts — they `source` the libraries and call functions in-process**, and assert on effects that
belong to the shell process, not to a program:

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

Under option B the **tests** give way, not the design: each in-process assertion is rewritten against the
TypeScript module. The shell file keeps only what goes through a command — a real process boundary, which is what
the ported code is.

### What moves where

| what a shell test asserts in-process | today | after |
| :- | :- | :- |
| a lock held for the caller's lifetime, released on exit, `FLEET_LOCKS` exported to children (`cmd.sh`, `wt.sh`, `tmux-isolation.sh`) | `source lib/lock.sh`, then `fleet_lock` | `tests/unit/lock.test.ts` — each assertion holds the lock in a **real child process** and checks the folder, the `busy:` line, the exit code and the takeover |
| `fleet_pane_state` / `fleet_pane_reply` reading a pipe (`pane.sh`) | `source lib/pane.sh` | `tests/unit/pane.test.ts` |
| `fleet_resolve_repo` assigning `REPO` in the caller's shell (`profile.sh`, `profile-init.sh`) | `source lib/profile.sh` | `tests/unit/profile.test.ts`, on `resolveRepo()`'s return value; the shell files keep the `profile init` and lookup checks |
| `fleet_main_checkout` / `fleet_worktree_root` / `fleet_worktree_owner_set` (`worktrees.sh`, `wt.sh`) | `source lib/worktree.sh` | `tests/unit/worktree.test.ts`; `wt.sh` keeps the `fleet wt` command checks |

**The rule: no assertion is dropped.** Every slice's PR body states how many assertions it moved and the total
after the move, so the parity claim stays checkable — 211 in the shell suite today, then shell + unit together.

### The entry points keep a bash shim

53 paths stay executable and every entry point stays a bash file, because `task install` links *folders* and the
hook paths are absolute (§4). The shim is three lines:

```bash
#!/usr/bin/env bash
# shim — the implementation is src/cli/fleet-up.ts
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib/shim.sh"
fleet_exec src/cli/fleet-up.ts "$@"
```

`shim.sh` does the one thing every shim must do: resolve its own real path through the readlink chain, exactly as
`bin/fleet` does today, set `FLEET_CHECKOUT` from it, then `exec node "$FLEET_CHECKOUT/src/cli/<cmd>.ts" "$@"`.
`exec`, not a child — with the lock in TypeScript there is no bash trap left to protect, and a child would only
cost a fork per command.

`$0` inside the Node process is `node`, so each `src/cli` file carries the name its shim was invoked by. That is
what keeps the lock file's `cmd` field and the `busy:` line byte-identical.

### The lock, in TypeScript

`src/lib/lock.ts` reproduces `lib/lock.sh` exactly where anyone can observe it:

- **Layout.** `<dir>/locks/<name>.lock/` holding `pid`, `cmd`, `since`; `mkdir` is still the atomic claim. Nothing
  about the folder moves, so a lock the old code took is a lock the new code sees, and the reverse.
- **Message.** `<script>: busy: <name> is held by pid <pid> (<cmd>, <s> s); try again shortly`, on stderr, with
  `<script>` the command's own name and `<cmd>` that name plus the caller's pass-through arguments.
- **Exit.** The lock call returns 1, and the command exits 1.
- **Wait.** 3rd argument, else `FLEET_LOCK_WAIT`, else 30 s; `0` fails at once; one `sleep 1` per attempt.
- **Stale.** A holder that is not alive is taken over; a folder with no `pid` is taken over after 2 s.
- **Re-entrancy.** `FLEET_LOCKS` (exported, space-delimited) names locks an ancestor holds; an entry counts only
  while its `pid` is alive, so a stale `FLEET_LOCKS` inherited by a tmux server never blocks a fleet.
- **Lifetime.** The Node process holds the lock for its own lifetime and releases it on `exit`, `SIGINT` (`130`)
  and `SIGTERM` — the EXIT trap, moved to `process.on`.
- **Handover.** `passLock(dir, name, pid)` hands a held lock to the background waiter and stops releasing it here;
  `adoptLock(dir, name)` takes the release duty over. Same contract as `fleet_lock_pass` / `fleet_lock_adopt`.

**Locks per command:**

| lock | commands |
| :- | :- |
| `fleet` | fleet-up, fleet-down, fleet-scale, fleet-view |
| `clear` | fleet-clear |
| `handoff-<peer>` | fleet-handoff |
| `board` | board-jira, board-docs, board-decision |
| `board-page` | starting the board's page (fleet-up, fleet-board) |
| `install` (in `~/.fleet-state/locks`) | install, update, link, backlog |

Commands that take no lock simply do not call it — the shim is identical either way.

### What option A would have cost

The rejected alternative kept `lib/lock.sh` in bash permanently and made the other six libs thin bash adaptors over
`src/lib/*.ts`, so the six test files could stay byte-identical. It is a real design — one source of truth for
locking, and the parity proof lands without touching a test. But it leaves a permanent bash layer whose only job is
to re-expose TypeScript functions to bash, and it means the port never finishes: every library implemented once and
exposed twice. Option B finishes and leaves the project in one language. The price is paid once, in slice 1: six
test files change shape and their in-process assertions are rewritten under `tests/unit`.

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

**Parity still comes from the existing suite**, minus the assertions that cannot survive a process boundary.
`task test` runs `smoke.sh`, which runs the other eight, and every black-box assertion in them is untouched: they
already use a fake `tmux` on `PATH`, a fake `backlog`, a fake `gh`, a throwaway `HOME`, a private `FLEET_TMUX`
socket and temp `FLEET_STATE`, so they exercise the ported code without knowing it is ported. Node is found through
the same `PATH`, so the stubs keep working.

What does not survive is the in-process `source lib/*.sh` call (§3). Those assertions move out of the shell file
into a unit test, one for one — so the shell count drops by exactly what `tests/unit` gains, and every slice's PR
states both numbers.

**Plus TypeScript unit tests** — `node --test tests/unit/`, one file per `src/lib` module, wired into `task test`
so it runs on every slice:

| module | what the unit tests pin |
| :- | :- |
| `shell-quote.ts` | `%q` parity against real bash: empty, spaces, `'`, `"`, `$`, backticks, newline, `=`, `~`, non-ASCII |
| `profile.ts` | `KEY=VALUE` parsing: comments, trailing blanks, quotes, `~`/`$HOME` expansion, empty-means-unset, env-wins, a non-`FLEET_` key ignored |
| `state.ts` | `FLEET_STATE` > `~/.fleet-state/<profile>` > `~/.fleet-state` |
| `lock.ts` | the folder claim, the `busy:` line, wait/`0`, stale takeover, a dead holder in `FLEET_LOCKS`, release on exit and on a signal, `pass`/`adopt` — every one of them with the lock held in a real child process |
| `tmux.ts` | session naming with/without profile, `=<session>:` targeting, tag filtering (the `fleet-isnadi-` prefix trap) |
| `pane.ts` | the box-drawing/alternation table; `busy`/`asking`/`held`/`unknown`/`idle` classification on captured panes |
| `worktree.ts` | `branch_state` matrix: detached, open (never pushed / tracking main), merged (ancestor, and squash), gone, open |
| `roster.ts` | read/write/prune, `session_id`-only update, corrupt entries |

`task lint` gains `tsc --noEmit` and a check that no `any` appears in `src/` — from slice 1, when `src/` first
exists.

**Per-slice gate**, no exceptions: `task test` reports 0 failures with **no assertion dropped** (the PR states the
moved count), `task lint` clean including `tsc --noEmit`.

---

## 6. Port order and who owns each slice

Twelve PRs, one per slice, each independently shippable and each leaving the fleet working. Each command's slice is
**write the TS → point the shim at it → run the suite → only then drop the bash body** (it stays in git history; a
reviewer can `git diff HEAD~1 -- skills/fleet/scripts/<cmd>`).

Three streams, so the port runs in parallel instead of in one queue:

- **Foundation** — slices 0–4, then 11–12. It comes first because every other slice imports `src/lib`.
- **Read-only, messaging and the board** — slices 5, 6, 9.
- **Lifecycle, `fleet worktree` and dev-tasks** — slices 7, 8, 10.

Slices 5–10 branch off slice 1, so slice 1 is **pushed early as a draft** with its exported signatures in place,
before every body is written. When a stacked base is about to merge, its dependents retarget to `main` first. Nobody
merges their own slice: Mohammad decides.

| # | Title | Owner | Contents | Gate |
| --: | :- | :- | :- | :- |
| 0 | `Document the port to TypeScript` | foundation | this file | review |
| 1 | `port: node/ts foundation, the lock, and the profile and tmux libs` | foundation | `package.json`, `tsconfig.json`, `src/lib/{exec,shell-quote,output,state,profile,tmux,lock}.ts` + `tests/unit`, `dev-tasks/scripts/lib/shim.sh`, `tsc --noEmit` and the no-`any` check in `task lint`. The in-process lock and `REPO` assertions leave the shell tests. No command ported yet. | 0 failed, count stated / lint |
| 2 | `port: pane, roster and backlog libs` | foundation | `src/lib/{pane,roster,backlog}.ts` + unit tests; `pane.sh`'s in-process assertions move out | 0 failed, count stated / lint |
| 3 | `port: worktree lib` | foundation | `src/lib/worktree.ts` (the scan, the cache, the `du`/`lsof`/`gh`/`jq` replacements) + unit tests; `worktrees.sh` and `wt.sh` keep only the command checks | 0 failed, count stated / lint |
| 4 | `port: bin/fleet dispatcher` | foundation | `src/cli/fleet.ts` incl. `_list`; the `bin/fleet` shim | 0 failed / lint |
| 5 | `port: read-only commands` | read-only | `fleet-ls`, `fleet-peek`, `fleet-capacity`, `fleet-pr-queue` | 0 failed / lint |
| 6 | `port: messaging and hooks` | read-only | `fleet-send`, `fleet-session-record`, `fleet-reply-log` (Python → TS), `fleet-clear`, `fleet-clear-heavy`, `peer-tokens` (Python → TS), `cc-send` | 0 failed / lint |
| 7 | `port: lifecycle commands` | lifecycle | `fleet-up`, `fleet-down`, `fleet-view`, `fleet-attach`, `fleet-scale`, `fleet-handoff`, `fleet-board` | 0 failed / lint |
| 8 | `port: fleet-worktree` | lifecycle | `fleet-worktree` (266 lines, the largest command) | 0 failed / lint |
| 9 | `port: board commands` | read-only | `board-jira`, `board-docs`, `board-decision` | 0 failed / lint |
| 10 | `port: dev-tasks` | lifecycle | install/link/bin/uninstall/update/backlog/completion, lint/{shell,skills,profile}, profile/init, clean | 0 failed / lint |
| 11 | `port: the in-flight scripts` | foundation | `fleet-dispatch`, `fleet-judge`, the `fleet-context-guard` hook — **only after #12 and #13 merge** | 0 failed / lint |
| 12 | `port: drop the dead bash` | foundation | remove `skills/fleet/scripts/lib/*.sh` and the lock source in `env.sh`, and every bash body that no longer has a caller; `shellcheck` then covers the shims and the tests only | 0 failed / lint |

Slices 1–3 change no observable behaviour at all: the entry points stay, and the libraries gain a TypeScript
implementation and a unit test. The only thing that moves is where the assertions live. That is deliberate — the
parity proof lands before anything user-visible does.

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

1. ~~**The adaptor layer** (§3)~~ — **answered, 2026-11-09: option B, the clean break.** `lock.sh` is ported, the
   in-process assertions move to `tests/unit`, the shims stay bash and take no lock.
2. **Node ≥22.18 as a hard requirement** — acceptable, given every machine running a fleet must have it?
3. **Slice size**: twelve PRs as tabled, or fold 1–3 into one "foundation" PR and 5–6 into one "read-only +
   messaging" PR to get to six or seven?
4. **When the live `~/.claude/skills/fleet` link moves** to a checkout running the ported code (§7.5).
