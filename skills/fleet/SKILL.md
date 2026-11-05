---
name: fleet
description: Needs tmux; peers run Claude Code, or Cursor's CLI with FLEET_CLI=agent. Bring up a fleet of Claude peers in tmux (/fleet squad, /fleet default, /fleet up engineer-3 designer), stop it (/fleet down), interrupt or clear peers (/fleet interrupt, /fleet clear [peer]), or load a peer's role and operating rules (/fleet engineer, /fleet architect, /fleet designer …).
---

# The fleet

**The user** in this skill and its roles is the person the fleet works for: `$FLEET_USER` (from the profile, which
`fleet-up` passes to every peer), else `git config user.name`. Address them by that name.

`$ARGUMENTS` decides what this does. **Anything not listed below** (a peer name such as `ios`, a typo, a team name)
is an error: say "no such role or squad: <name>", list `roles/` and `squads/`, and stop. Never guess the nearest
match, and never run `fleet-up`, `fleet-down` or `fleet-scale` to resolve it.
Only the user, from their own shell, starts or stops the fleet: inside a peer session (`fleet-<profile>-<peer>`) `fleet-up` and
`fleet-down` refuse to run. A peer that loads this skill with a squad name says so and stops.

- **A squad name** (a file in `squads/` — `squad`, `default`, …) or **`up <peer> …`**: bring the fleet up. Run
  `scripts/fleet-up <squad>` (or `scripts/fleet-up <peer> …`) from this skill's folder with Bash, then tell the user
  `tmux attach -t fleet-<profile>` to see every peer. Each peer gets its own tmux session `fleet-<profile>-<peer>`, its own worktree, is
  renamed to `<peer>` and loads `/fleet <role>` (role = peer name minus a `-N` suffix). The project-manager is a
  peer too (`fleet-<profile>-project-manager`) so it can hand off its own context; this session only brings the fleet up and
  relays what the user says to it. `<profile>` is `FLEET_PROFILE`, passed to every peer; with none the names are `fleet` and
  `fleet-<peer>`. Two profiles' fleets run side by side on one tmux server.
  `squads/squad` = project-manager, architect, pr-architect, security-architect, engineer-1, engineer-2, designer.
  `squads/spec` = project-manager, ba, spec-reviewer, architect, pr-architect, engineer: writing
  and refining requirements; the engineer only runs spikes that answer the squad's open questions, no feature code. `squads/solo` = one `engineer`, the cheapest fleet. `squads/teams` = peers named after the team they work for (android, ios, web, be, identity,
  platform, da, qa-web, qa-mobile), each with its role and CLI on its line (`<peer> [role] [cli]`), plus a `jira` peer
  that keeps the tracker in step; each peer's own clone comes from `FLEET_PEER_DIRS` in the profile. Each peer's model and effort
  come from `models` (role → model, effort): sonnet by default, opus only for the project-manager, architect and
  spec-reviewer.
- **`peek [peer …]`**: run `scripts/fleet-peek [-n lines] [peer …]` (each peer's last reply without its CLI's chrome,
  with its state: busy, asking, held, unknown or idle; read-only).
- **`handoff`**: load the `fleet-handoff` skill (any peer: write your state file, then clear yourself) — see
  `roles/project-manager.md`, "Your own context".
- **`wt` / `worktree`**: run `scripts/fleet-worktree ls|prune|new|summary` (`fleet wt …`): the worktree inventory across
  every repo the fleet touches, safe cleanup (a dry run unless `--yes`), and a new topic worktree (`new <peer> . <branch>`).
- **`ls`**: run `scripts/fleet-ls` (every fleet on this machine: view, board URL and status, each peer's role, CLI and
  state; read-only). **`attach [peer]`** is for the user's terminal: tell them `fleet attach [peer]`.
- **`board`**: run `scripts/fleet-board` and give the user the URL it prints (the fleet's board, Backlog.md, at
  `http://127.0.0.1:<FLEET_BOARD_PORT>`; it starts the page in `fleet-<profile>-board` when it is not running, even with the
  fleet down, and opens it in the browser). Load the `fleet-board` skill for anything on the board itself: Jira sync, specs
  and architecture, decisions, moving cards.
- **`view`**: run `scripts/fleet-view` (rebuilds the tiled `fleet-<profile>` session over every running peer when it is gone
  or out of date; peers are not touched).
- **`down`**: run `scripts/fleet-down` (stops `fleet-<profile>` and every `fleet-<profile>-*` session, the board's page included,
  never another profile's; worktrees and the board's files stay).
- **`interrupt [peer …]`**: run `scripts/fleet-send -i [peer …]` (Escape to every peer, or the named ones; their
  current turn stops, in-flight work is lost).
- **`clear [peer …]`**: run `scripts/fleet-send -f /clear [peer …]` (busy peers are interrupted first, then cleared),
  then `scripts/fleet-send "/fleet <role>" <peer>` for each cleared peer so it reloads its role.
- **`send "<text>" [peer …]`**: run `scripts/fleet-send [-f] "<text>" [peer …]` (type a line into peers' prompts;
  `-f` interrupts busy ones first, otherwise the line queues until their turn ends).
- **A role** (`project-manager`, `engineer`, `architect`, `pr-architect`, `security-architect`, `designer`,
  `dev-support`, `ba`, `spec-reviewer`):
  you are that peer. Read `roles/<role>.md` in this skill's folder now and follow it.

**The `fleet` command** (`bin/fleet`, on PATH after `task install`) runs these scripts from any directory:
`fleet [--profile <name>] up|down|ls|attach|board|send|peek|capacity|scale|clear|handoff|…`; `fleet help` lists them. Give the
user `fleet …` lines rather than script paths. Scripts that change shared state lock (`scripts/lib/lock.sh`): a second
caller waits, then reports `busy: <lock> is held by pid <n> (<command>)`; wait and retry, never delete a lock by hand.

**Cursor CLI.** `scripts/fleet-up` launches `claude` unless `FLEET_CLI=agent`, which launches Cursor's CLI with
`--force` instead of `--dangerously-skip-permissions`. Cursor has no equivalent of `--effort`, and `models` holds
Claude aliases, so for `agent` both `--model` and `--effort` are skipped (put a Cursor model in `FLEET_FLAGS`);
`/rename` is skipped too, and each peer is told in plain text to read `SKILL.md` and `roles/<role>.md`. The script
header lists the limits.
Never set `FLEET_CLI` (or any `CLAUDE_*` workaround) on the command line yourself: the environment beats the
profile, so a `FLEET_CLI=claude` you add overrides a profile's `FLEET_CLI=agent`. Run `FLEET_PROFILE=<name> scripts/fleet-up …`
and let the profile or the user choose; `fleet-up` prints `peers run <cli> (<where from>)`. If it fails, report the error.

New squad: add a file to `squads/` with one peer name per line (`engineer-3`, `designer`, …); every role needs a
`roles/<role>.md`.

**In a Cursor chat** (Cursor IDE, no tmux: one Agent chat is one role, the human carries messages between chats).
Start a chat with "Load the fleet skill and act as <role>", then read `roles/<role>.md`. The roles and the rules below are
written for peers in tmux; read their terms so:
- **peer, session**: an Agent chat holding one role.
- **`fleet-send`, `cc-send`, SendMessage, "tell / report to / ask the project-manager or a peer"**: write the message as
  the brief below and ask the human to paste it into that role's chat.
- **`/fleet <role>`, "load this skill again with the new role"**: read `roles/<role>.md` for the new role.
- **`fleet-up`, `fleet-down`, `/rename`, tmux, `notify_when_idle`**: none; the human opens and closes chats.
- **`scripts/…`**: this skill's scripts (`~/.cursor/skills/fleet/scripts/` after `task install:cursor`); run them only
  where your role would.

```
ROLE: <role> · Jira: <KEY>-<n> · PR: #<n> or none · Branch/worktree: <name>
Done looks like: <acceptance> · Do not touch: the local stack (dev-support only), other worktrees
```

These rules apply to everyone:

1. **One worktree per peer.** Never work in the shared checkout of a repo and never switch its branch. Every repo's
   worktrees live in that repo's own `.claude/worktrees/<topic>`, named after the topic only (no peer name, no folder per
   repo), always under that repo's **main checkout**, never inside your own launch worktree: make every topic worktree with
   `scripts/fleet-worktree <peer> . <branch>` (the target repo; run from anywhere, your launch worktree included), which
   prints `<main checkout>/.claude/worktrees/<topic>` (the topic is the branch name). Never run a bare `git worktree add
   .claude/worktrees/<topic>` from your launch worktree: it nests the topic inside `.claude/worktrees/<peer>/`. A repo nested
   inside the target repo (a submodule or a nested clone) is its own git repo: work in one only through
   `scripts/fleet-worktree <peer> <child-repo-path> <branch>` (its `<child-repo>/.claude/worktrees/<topic>`), never in its
   shared checkout. The fleet repo's own work: `git -C <its main checkout> worktree add .claude/worktrees/<topic>`. Use the same
   branch name in every repo of a feature. Folders the target repo's `AGENTS.md` marks as never edited get no worktree.
   When the PR of a worktree is merged or closed, remove the worktree and its local branch the same day, then report
   "worktree gone" (`fleet wt prune --yes` removes yours once it is clean and pushed). `fleet wt ls` lists every worktree of
   every repo the fleet touches with its owner, PR, age, dirty and unpushed work, size, the peer in it and its class (active,
   idle, merged, gone, orphaned, nested); `fleet wt prune` (and `task clean`) removes merged, gone and orphaned ones, never
   one that is dirty, unpushed or in use.
2. **No agent touches production.** No agent touches production or any shared cluster; there is no ops role. Agents work only
   on local environments (the local stack, local builds).
3. **Local environments are dev-support's.** Local stack runs go through `dev-support`; engineers
   hand over a branch (or a merged main SHA) and the command to run.
4. **The project-manager orchestrates and runs nothing.** Route requests through it; it relays, assigns, tracks.
5. **Nobody idles.** When your item is done, report to the project-manager in one message (PR number, state,
   checks, what is left) and ask for the next item in the same message.
6. **Roles move.** The project-manager may rename your session and change your role at any time; load this skill
   again with the new role.
7. **One pr-architect reviews and merges every PR**; its approval is the only merge gate. PRs merge constantly:
   The user reviews main, not PRs, so nothing waits for them and nothing waits for security. Keep PRs small and merge
   each green slice. The architect designs and never merges. **One security-architect reviews
   security-relevant changes** (identity config, gateway routes, network policy, tokens, secrets, exposure gates) in parallel or
   after the merge, never blocking it; findings become follow-up PRs (MED and up get a ticket, HIGH goes to an
   engineer at once). It merges nothing.
8. **Skills first.** Before the first file edit, load the skills your item needs (this one, the skills the target repo's `AGENTS.md` names, `fleet-cc-send`,
   `superpowers:*` as they apply) and say which you loaded in your first report.
9. **Work is tracked in the Jira project named in the target repo's AGENTS.md** (project key, board and site host are
   there, never in this repo). **Unless the profile overrides it:** `$FLEET_TRACKER_PROJECT` and `$FLEET_TRACKER_SITE`
   (a personal or temporary board the target repo must not name) win over AGENTS.md; `$FLEET_TRACKER_PROJECT=none`
   means no tracker: no ticket keys in titles, commits or briefs, and no Jira calls; conventional titles (`fix(web): …`)
   and MR numbers carry the report instead. Every item is an issue there; code changes are PRs or MRs on the target repo or its child repos, each names its Jira key in the title or description (`<KEY>-<n>: …`) and is linked from the
   issue. Use the Atlassian MCP tools (cloudId = the site host from AGENTS.md): `searchJiraIssuesUsingJql`
   (`project = <KEY> AND statusCategory != Done`), `getJiraIssue`, `addCommentToJiraIssue`, `transitionJiraIssue`.
   Report with keys and PR or MR numbers (`<KEY>-<n> / !301`), never with descriptions alone.
10. **Reporting format** (one message, first line = state): `#<PR> <state: open|checks green|needs review|merged|
    blocked> — <one line>`; blockers name who unblocks.

11. **AI attribution.** Every commit an agent makes ends with a `Co-Authored-By:` trailer naming the model that
    wrote it (`Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; a Cursor peer names its own model), and
    every PR or MR an agent opens carries the repo's AI label if it has one (`ai-generated`, set with `gh pr create --label`
    or `glab mr create --label`). The pr-architect holds a PR from a fleet peer that lacks either.
12. **The board is the fleet's state.** Work items, who holds them, epics and the user's decisions live on the fleet's board
    (`fleet-board` skill; Backlog.md in `$FLEET_STATE/backlog`, reached with the `backlog` MCP tools or `backlog` CLI from
    any worktree). Move your own card as you work: In Progress when you start, Review with the PR as a reference, Done once
    merged and the worktree is gone; blocked: label `blocked` and a comment naming who unblocks. Read the accepted
    decisions (`board-decision list accepted`) before you act and never ask again what one answers; a question only the
    user can answer goes to the project-manager, who records it as a decision.

Project rules in the target repo's AGENTS.md, CLAUDE.md and memory still apply (no direct pushes to main; PRs squash-merge;
the repo's checks before every push and in every review; a child repo's docs and tests live in that repo).
