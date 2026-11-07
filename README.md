# tmux-fleet

Skills for running a team of AI sessions that build software together, in Claude Code or Cursor.

## What the fleet is

Several AI sessions work at once, one per role (engineer, architect, reviewer, ...), each in its own git worktree.
A project-manager session hands out work and tracks it; it runs nothing itself. Every change goes through a pull
request, and one session, the pr-architect, is the only merge gate. You talk to the project-manager; it briefs the
others.

## Roles and squads

Roles (`skills/fleet/roles/<role>.md`):

- **project-manager**: assigns work, tracks the board, relays; never runs builds or edits code.
- **architect**: design, specs, root cause and classification of bugs.
- **pr-architect**: reviews and squash-merges every PR; the only merge gate.
- **security-architect**: reviews security-relevant changes; never blocks a merge.
- **performance-engineer**: reviews scaling; never blocks a merge.
- **engineer**: takes an item to "checks green, ready for review"; never merges.
- **designer**: Figma only, no code.
- **dev-support**: the local environment and local runs.
- **e2e-engineer**: drives the apps like a user in a real browser and reports what breaks.
- **ba**: writes requirements, one journey at a time.
- **spec-reviewer**: challenges requirements and returns ranked findings.

Squads (`skills/fleet/squads/<name>`, one peer per line; `-N` suffixes give several of a role):

- `squad`: project-manager, architect, pr-architect, security-architect, engineer-1, engineer-2, designer.
- `spec`: project-manager, ba, spec-reviewer, architect, pr-architect, engineer. Writes and refines requirements, runs spikes for open questions (the engineer, no feature code), and reviews existing stories on the board for gaps, contradictions and design bugs.
- `solo`: one engineer, the cheapest fleet.
- `default`: the squad `fleet-up` starts when you name none.
- `teams`: peers named after the team they work for (android, ios, web, be, identity, platform, da, qa-web,
  qa-mobile), a `jira` peer for the tracker, and the project-manager and architect. Mixed CLIs; each line is
  `<peer> [role] [cli]`. Keep the project-manager and coordinating roles on claude; non-claude peers do leaf work.

## Claude Code users, Cursor CLI users, Cursor IDE users

Everyone uses the same skills and the same role files (`skills/fleet/roles/<role>.md`); only how the peers run and talk
differs. Install once with `task install` (below); it links the skills for both Claude Code and Cursor.

| | Claude Code | Cursor CLI (in tmux) | OpenCode (via Ori) | Cursor IDE (Agent chats) |
| :- | :- | :- | :- | :- |
| Peers run as | `claude` in tmux, one session per peer | Cursor's `agent` in tmux | `ori opencode` in tmux, one session per peer | one Agent chat per role |
| Start | `/fleet <squad>` or `fleet-up <squad>` | `fleet-up` with `FLEET_CLI=agent` | `fleet-up` with `FLEET_CLI=opencode` | "Load the fleet skill and act as <role>" |
| Messages | `SendMessage` between claude peers, `fleet send` to a non-claude peer | the project-manager relays with `fleet send`; a cursor peer reports with `fleet send` | no `SendMessage`: peers report with `fleet send` | you paste briefs between chats |
| Status | supported, the default | experimental | supported | supported |

### Claude Code users

The full fleet: `fleet-up` starts every peer in its own tmux session and worktree, renames it and loads its role
(`/fleet <role>`); peers message each other, the project-manager hands out work. Start it as in
[Start a fleet](#start-a-fleet), watch it with `tmux attach -t fleet-<profile>` (`fleet` with no profile), and use the [everyday commands](#everyday-commands).
Each peer's model and effort come from `skills/fleet/models`.

### Cursor CLI users

The same tmux fleet with Cursor's CLI as the peers: set `FLEET_CLI=agent` in your profile (see [Profiles](#profiles))
or the environment, then `FLEET_PROFILE=<name> fleet-up <squad>`; it prints `peers run agent (profile <name>)`.
`fleet-up` never infers the CLI from the session that runs it, so leave `FLEET_CLI` to the profile.
Limits (see the `fleet-up` header):

- no `/rename` (the tmux session `fleet-<profile>-<peer>` names the peer), no effort setting; the model comes from `FLEET_FLAGS`
  (`FLEET_FLAGS="--force --model X"`), since `skills/fleet/models` holds Claude aliases;
- a line sent into a Cursor peer can land as a new line instead of being submitted, so a peer may sit on an unsent
  prompt; `/model` opens Cursor's model picker instead of switching;
- peers do not message each other: the project-manager relays. A cursor peer's own reports go out with
  `fleet send "<text>" project-manager` from its shell — it has no `SendMessage` tool (the `fleet` skill's
  cross-CLI rule, 13).
- Cost: a sample run (one fleet, a couple of peers, a few minutes, 2026-10-25) used about $4 of a $70 monthly Cursor
  seat. Measure before running a squad for hours; for long runs prefer Claude Code peers.

### OpenCode (via Ori) users

OpenCode peers run through Ori's launcher, which spends an OpenRouter credential (not a Claude or Cursor
subscription): `ori` on PATH and signed in (`ori doctor` checks). Set `FLEET_CLI=opencode` in your profile (or the
environment), or name it per peer on a squad line (`oc-eng engineer opencode`); a mixed fleet runs any combination.

Each peer starts `ori opencode --auto` with its role load in `--prompt` (OpenCode auto-submits it, so `fleet-up` types
nothing into opencode peers afterwards). Where the Claude Code and Cursor sections diverge:

- no `/rename` (the tmux session `fleet-<profile>-<peer>` names the peer, as for Cursor);
- the board has no `--mcp-config` for these peers — they use the `backlog` CLI through `BACKLOG_CWD`, as for Cursor;
- `replies.log` (the reply-log hook) is a Claude Code thing; opencode peers do not write it — read their replies
  with `fleet peek <peer>`;
- messaging: opencode peers have no `SendMessage` tool, so they report to the project-manager (or any peer) with
  `fleet send "<text>" <peer>` from their shell; and because `fleet send`'s busy check does not recognise
  opencode's screen yet, senders run `fleet peek <peer>` first (the `fleet` skill's cross-CLI rule, 13);
- the peer's model comes from the role's `models` cols 5–6 (an OpenRouter model ID and a reasoning effort, e.g.
  `anthropic/claude-sonnet-4.6` `high`) when present, else OpenCode's own selection; reasoning effort is one of
  `max xhigh high medium low minimal none`;
- cost: OpenRouter pricing for the model you pin — measure before running a squad for hours.

### Cursor IDE users

No terminal and no tmux: one Agent chat per role, and you carry messages between chats.

1. `task install:cursor` (or `task install`) links the `fleet` skill into `~/.cursor/skills`; reload the Cursor window.
2. Open the target repo, start a new Agent chat per role and say: "Load the fleet skill and act as <role>" (plus any skill the
   target repo's AGENTS.md names). The chat reads the same `roles/<role>.md` as a Claude Code peer.
3. Where a role says "tell the project-manager" or `fleet-send`, the chat writes a short brief (ROLE, Jira, PR, branch,
   done looks like) for you to paste into that role's chat; `SKILL.md`'s "In a Cursor chat" section maps every tmux
   term to chats.
4. Name the chats in the sidebar (`PM`, `Architect`, `Eng-1`, …) and keep one worktree per chat, as every role says.

For one chat that switches roles: "Work as a small fleet in one thread; start as project-manager; say 'switching to
<role>' before you take another role."

## Install

**1. Prerequisites** (macOS, Homebrew):

```bash
brew install git go-task tmux node gh
```

`node` is for the board (Backlog.md is an npm package); `gh` is for the PR queue. You also need Claude Code (or Cursor's CLI).

**2. Clone and install everything:**

```bash
git clone https://github.com/mohammadchehab/tmux-fleet ~/Dev/tmux-fleet
cd ~/Dev/tmux-fleet
task install
```

`task install` does three things:
- puts the `fleet` command on PATH: a link `~/.local/bin/fleet`. It warns if `~/.local/bin` isn't on your PATH. See [The fleet command](#the-fleet-command).
- links every `skills/<name>` folder into `~/.claude/skills` (Claude Code) and `~/.cursor/skills` (Cursor). The links point into this checkout, so there is one copy, and a real folder or a foreign link with the same name is left alone and reported.
- installs the board's CLI, [Backlog.md](https://github.com/MrLesk/Backlog.md), as a global npm package at the version the fleet pins (`FLEET_BACKLOG_VERSION` in `skills/fleet/scripts/lib/backlog.sh`).

One part only: `task install:bin` (the `fleet` command), `task install:claude`, `task install:cursor`, `task install:backlog`.

**3. Tab completion:**

```bash
echo 'eval "$(fleet completion zsh)"' >> ~/.zshrc && exec zsh
```

**4. Check:**

```bash
fleet help
backlog --version
```

**5. A profile per project:** which repo the fleet works on. Do it once per project, before the first `fleet up`; see [Profiles](#profiles).

```bash
fleet profile init <name> ~/Dev/<repo>      # writes ~/.config/fleet/profiles/<name>.env
```

Restart running Claude Code sessions to see new skills. `fleet update` keeps it all current: a git pull of this checkout, which also updates the `fleet` command, then relinks new skills and reinstalls Backlog.md when the pin moves.

## The fleet command

`fleet` runs every fleet script and task from any directory, in the checkout it was installed from (`task install:bin`
links `bin/fleet` into `~/.local/bin`, or `FLEET_BIN`; `fleet update` updates it with the checkout). It is a thin
dispatcher: `fleet up` is `fleet-up`, `fleet install` is `task install`, and so on; `fleet help` lists them all.

```bash
fleet --profile <name> up squad      # start that profile's fleet; --profile works anywhere before "--"
fleet ls                             # every fleet on this machine: view, board URL and status, each peer's role, CLI and state
fleet attach [peer]                  # open the view (rebuilt if gone) or one peer; inside tmux it switches, no nested tmux
fleet board                          # open the board; --iterm shows it as a Kanban in a terminal split
fleet capacity · fleet send "text" engineer-1 · fleet peek · fleet scale add engineer · fleet down
fleet install · fleet update · fleet lint · fleet test
```

`--profile <name>` sets `FLEET_PROFILE` for that one call; an exported `FLEET_PROFILE` works too (peers have it). Shell
completion (commands, profiles, squads, roles, running peers): add `eval "$(fleet completion zsh)"` to `~/.zshrc`
(`fleet completion bash` for bash).

Several `fleet` calls can run at once (two terminals, peers, the user). The scripts that change shared state take a lock
(`skills/fleet/scripts/lib/lock.sh`) under `$FLEET_STATE/locks/`: one fleet-up, fleet-down, fleet-scale or fleet-view per
profile at a time, one fleet-clear, one handoff per peer, one board script, and one install or update per user. A second
caller waits (fleet-up, fleet-down and fleet-scale up to 60 s), then says which pid and command holds the lock. A lock
whose holder died is taken over. Reading commands (`ls`, `capacity`, `peek`, `send`, `attach`) take none. A peer writing
through the board's MCP server is outside these locks; `backlog doctor` repairs the rare duplicate card id.

## Worktrees

Every peer works in worktrees, and they pile up. `fleet wt` (or `fleet worktree`) keeps track of them across every repo the
fleet touches: each profile's target repo and its child repos, and the fleet repo itself (`--profile <name>` narrows it).

```bash
fleet wt ls              # fetches, then every worktree: owner, branch, PR, age, dirty, unpushed, size, the peer in it, class; totals
fleet wt ls --stale      # only the ones that are not active          (--json for scripts)
fleet wt prune           # dry run: what would go, and the space it would free
fleet wt prune --yes     # remove merged, gone and orphaned worktrees and their branches   (--idle, --nested: those too)
fleet wt new <peer> . <branch>   # a topic worktree in <main checkout>/.claude/worktrees/<topic>, never nested
```

Classes: **active**; **idle** (no commit or file change for `FLEET_WT_IDLE_DAYS`, default 7); **merged** and **gone** (the
branch is in main, or deleted on the remote); **orphaned** (the folder is missing, a peer's launch worktree whose peer is
not running, or a topic whose owner is not running while its fleet runs); **nested** (inside another worktree). Prune never
removes a worktree that is dirty, has unpushed commits, has a running peer's pane in it or is your current directory, and
runs under the fleet lock. `fleet ls` and the standup show one line per profile ("worktrees (p): 12, 3 stale, 4.1 GB"),
keep-busy reminds the owner of a merged worktree once, and capacity flags a peer sitting in a stale one. PR state comes from
`gh` (cached 10 minutes); sizes from `du` (cached).

## The board

Each profile has one board: Backlog.md files in `$FLEET_STATE/backlog/` (no git, nothing hosted), with the sprint board's
columns Backlog, Next, In Progress, Review, Done, plus milestones (epics), docs and decisions. `fleet-up` creates it when it
is missing, starts its page in the tmux session `fleet-<profile>-board`, prints its URL, and gives every peer the board
(`BACKLOG_CWD`, and the `backlog` MCP server for Claude Code peers through `--mcp-config`; the target repo is not touched).
`fleet-down` stops the page; the files stay. Open it with `fleet-board` (or `/fleet board`), even with the fleet down.
The URL is fixed per profile, so bookmark it: `http://127.0.0.1:<FLEET_BOARD_PORT>`, 6420 with no profile, else a port
derived from the profile name. The `fleet-board` skill syncs your Jira tickets onto it, copies the target repo's specs and
architecture into its Docs, and records the decisions you make.

## Start a fleet

In a Claude Code session started inside the repo you want worked on, pick the squad for the job:

- `/fleet spec`: writing and refining requirements, spikes that answer open questions (the engineer writes no feature
  code), and a review of existing stories for gaps, contradictions and design bugs.
- `/fleet squad`: building.
- `/fleet solo`: one engineer.

From a shell, inside the repo you want worked on:

```
cd ~/Dev/<repo> && ~/.claude/skills/fleet/scripts/fleet-up <squad>
```

Add `FLEET_CLI=agent` for Cursor's CLI, or set it once in the profile ([Cursor CLI users](#cursor-cli-users)).

### Profiles

This repo names no project, so the fleet scripts don't know which repo to work on. Run them inside that repo (above),
or give them a profile. A profile is a small per-user file with that project's fleet settings:

```
# ~/.config/fleet/profiles/<name>.env
FLEET_REPO=~/Dev/<repo>   # the repo the peers work in
FLEET_SQUAD=squad         # the squad when you name none
FLEET_CLI=agent  # lint: allow names a fleet CLI, not a project fact
```

`FLEET_CLI=agent` is optional: peers run Cursor's CLI instead of Claude Code. The `# lint: allow` keeps the profile
lint from flagging `agent` when the target repo's AGENTS.md uses the word.

Then start from anywhere with `FLEET_PROFILE=<name> ~/.claude/skills/fleet/scripts/fleet-up <squad>`.

- Make one with `task profile:init NAME=<name> REPO=~/Dev/<repo>` (add `SQUAD=spec` for another default squad). It
  fills the template `profiles/example.env`, uses the repo's main checkout even if you point at a worktree, never
  overwrites an existing profile, and runs the profile lint on the result.
- Lookup order: the per-user folder first, then this repo's `profiles/`. Real profiles stay out of the repo.
- The file is only read, never run: only `FLEET_*=value` lines count. A variable set in your shell wins over the
  profile, and the profile wins over the script default.
- Project facts (Jira project, paths, rules) never go in a profile; they live in the target repo's AGENTS.md, and
  `task lint` fails if a profile repeats one.

Then `tmux attach -t fleet-<profile>` to see every peer (one tmux session `fleet-<profile>-<peer>` each; `tmux attach -t
fleet-<profile>-<role>` for one). With no `FLEET_PROFILE` the names are `fleet` and `fleet-<peer>`. Each profile's fleet has
its own sessions, so two run side by side on one tmux server and `fleet-down` stops only its own. Settings, all optional:

- `FLEET_REPO`: the repo the peers work on (default: the profile's, else the main checkout of the repo you are in).
- `FLEET_BASE`: base ref for new worktrees (default `origin/main`).
- `FLEET_FLAGS`: flags for each peer's CLI (default `--dangerously-skip-permissions`; `--force` for `agent`;
  `--auto` for `opencode`). A peer
  whose squad line names the other CLI gets that CLI's default.
- `FLEET_CLI`: `claude` (default), `agent` (Cursor's CLI) or `opencode` (OpenCode through Ori's launcher). Never inferred
  from the session that runs `fleet-up`; set it in the environment or the profile. A squad line `<peer> [role] [cli]`
  overrides it for that peer.
- `FLEET_PEER_DIRS`: `peer=folder …`, for peers that work in their own clone instead of a worktree of `FLEET_REPO`
  (the `teams` squad). Keep it in your profile: the paths are yours.
- `FLEET_STATE`: where the project-manager keeps its handoff and the board lives (default `~/.fleet-state/<profile>/`, `~/.fleet-state/` with no profile).
- `FLEET_BOARD_PORT`: the board's port (default 6420 with no profile, else one derived from the profile name).
- `FLEET_BOARD_DOCS`: the target repo's spec and architecture paths the `fleet-board` skill copies onto the board
  (space-separated; default: found in the repo).
- `FLEET_TMUX=<name>`: use a private tmux socket (`tmux -L <name>`) instead of the live server; every fleet script and `clean.sh` honours it. Inside a tmux pane the scripts stay on that pane's server. Use it for every test.
- `FLEET_USER`: who the peers work for, "the user" in every role (default: `git config user.name` in the target repo); `task profile:init` fills it in.

## Everyday commands

Every line below is also a `fleet` subcommand (`fleet send …`, `fleet peek`, `fleet view`, `fleet board`, `fleet down`).
Scripts are in `skills/fleet/scripts/` (after install, also under `~/.claude/skills/fleet/scripts/`):

```bash
fleet-send "text" [peer ...]      # type a line into peers' prompts; -f interrupts busy ones first
fleet-send -i [peer ...]          # interrupt (Escape), send nothing
fleet-send -f /clear <peer>       # clear a peer, then fleet-send "/fleet <role>" <peer> to reload its role
fleet-clear-heavy [-n] [k]        # clear idle peers over k thousand tokens of context (-n dry run)
fleet-handoff [peer]              # hand over to a fresh copy after writing the state file (fleet-handoff skill)
fleet-peek [-n 15] [peer ...]     # each peer's last reply and state (busy, asking, held, unknown, idle); read-only
fleet-view                        # rebuild the tiled fleet view over the running peers; peers untouched
fleet-board [--no-open]           # open the board (starts its page if needed, even with the fleet down); prints the URL
fleet-ls                          # every fleet: view, board, peers with role, CLI and state (fleet ls)
fleet-attach [peer]               # open the view or one peer's session (fleet attach)
fleet-down                        # stop the tmux sessions and the board's page; worktrees and the board's files stay
```

In Claude Code, `/fleet interrupt`, `/fleet clear`, `/fleet send`, `/fleet peek`, `/fleet view`, `/fleet board`, `/fleet down` and `/fleet handoff` do the same.

## Skills in this repo

- `fleet`: bring the fleet up and down, and load a role (`/fleet <squad|role>`). Needs tmux; peers run Claude Code,
  Cursor's CLI with `FLEET_CLI=agent`, or OpenCode through Ori's launcher with `FLEET_CLI=opencode`.
- `fleet-pm`: the project-manager's orchestration workflow. Needs tmux peers started by `fleet-up`.
- `fleet-board`: the fleet's board (Backlog.md): open it, sync your Jira tickets onto it (`board-jira`), copy the repo's
  specs and architecture into its Docs (`board-docs`), record and answer decisions (`board-decision`), and who moves which
  card. Needs the `backlog` CLI.
- `fleet-capacity`: who is busy, idle, asking, held or unknown, Claude Code and Cursor peers alike (pane states from `fleet/scripts/lib/pane.sh`). Needs tmux.
- `fleet-handoff`: a peer writes its state file and clears its own session; a fresh copy reloads its role and carries on. Claude Code only; needs tmux.
- `fleet-scale`: add or remove one peer. Needs tmux; its busy check is the shared one in `lib/pane.sh`.
- `fleet-spinup`: start one more peer, the same way `fleet-up` starts every peer (it runs `fleet-scale add`): own session, worktree, tags and the board.
- `fleet-standup`: status report from capacity, PR queue and blockers. Needs tmux and gh.
- `fleet-pr-queue`: sort open PRs by who acts next. Needs gh; no tmux.
- `fleet-next`: after a merge, check the worktree is gone and give the peer its next item. Needs gh and `fleet-context.md`.
- `fleet-cc-send`: type a command or text into other running Claude Code sessions. Claude Code only (finds sessions by Claude's socket).
- `fleet-triage`, `fleet-rca`: route a bug to the architect for root cause; the project-manager never diagnoses. Works in Claude Code and Cursor.
- `codegraph`: ask the project's CodeGraph index (`.codegraph/`, from `codegraph init`) where code lives, a symbol's source, who calls it and what a change breaks, instead of grepping and reading files. Any indexed repo. Needs the `codegraph` CLI (`npm i -g @colbymchenry/codegraph`).
- Project-specific skills belong in their own repo; the target repo's `AGENTS.md` names the ones a project needs.

## Rules that bite

- **No agent touches production; local environments only.**
- **Never run `fleet-up`, `fleet-down` or `task clean -- --force --sessions` against the live tmux
  server.** They kill the running fleet. Test on a private socket with `FLEET_TMUX`.
- **Worktrees live in `<repo>/.claude/worktrees/<topic>`.** Never work in the shared checkout or switch its branch.
- **Never push to main.** Branch, PR, pr-architect squash-merges.
- **Attribution.** Every agent commit ends with `Co-Authored-By: <model>`; every PR carries the `ai-generated` label.
- `task clean` lists by default. `--force` removes only clean stale worktrees (it runs `fleet wt prune --yes`); killing sessions needs
  `--force --sessions`. It never deletes `fleet-context.md` or handoff files.

## Update and uninstall

```bash
task update      # on a clean main: git pull --ff-only, then link any new skills
task uninstall   # remove the symlinks that point into this checkout
```

## Developing the fleet

```bash
task lint   # shellcheck every script; each skill's frontmatter name equals its folder name
task test   # smoke tests with a fake tmux: no real tmux, claude or network
task clean  # list stale worktrees and sessions (dry run)
```

Work in a worktree off `origin/main`, open a PR, let pr-architect merge.
