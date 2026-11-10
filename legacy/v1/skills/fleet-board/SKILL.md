---
name: fleet-board
description: Needs the backlog CLI (task install:backlog); the board itself needs no tmux. The fleet's board (Backlog.md, one per profile in $FLEET_STATE/backlog) — tasks, epics, docs, decisions. Use when the user asks for "the board" or "the dashboard", to sync my Jira tickets onto it, to show the repo's specs/architecture on it, to record or answer a decision, or when a peer starts, moves or finishes a card.
---

# The fleet's board

One board per profile: Backlog.md files in `$FLEET_STATE/backlog/` (`~/.fleet-state/<profile>/backlog`), no git, nothing
hosted. Its page is `http://127.0.0.1:<port>` (`FLEET_BOARD_PORT`, else 6420 with no profile, else a port fixed by the profile
name), served from the tmux session `fleet-<profile>-board`, which `fleet-up` starts and `fleet-down` stops. Views: Kanban
board, Milestones (= epics, with progress), Docs, Decisions, Statistics.

Columns, as on the sprint board: **Backlog** (not ready) → **Next** (ready, the queue peers take from) → **In Progress** →
**Review** (a PR is open) → **Done**.

Every peer has `BACKLOG_CWD=$FLEET_STATE`, so the `backlog` CLI reaches this board from any worktree. Claude Code peers also
have the `backlog` MCP server (tasks, milestones, documents; `fleet-up` passes `--mcp-config $FLEET_STATE/backlog-mcp.json`).
Cursor peers use the CLI. Prefer the MCP tools or the CLI over editing the files by hand, except where this skill says
otherwise. The scripts below live in `~/.claude/skills/fleet-board/scripts/`.

## Open it ("the board", "the dashboard")

```bash
~/.claude/skills/fleet/scripts/fleet-board            # starts the page if needed, prints the URL, opens it
~/.claude/skills/fleet/scripts/fleet-board --no-open  # the URL only
```

It works with the fleet down too. Give the user the URL.

## Cards: who moves what

- A card is assigned to the peer that works on it: assignee `@<peer>` (`task_edit` with `assignee`, or
  `backlog task edit <id> -a @<peer>`). One peer, one In Progress card at a time.
- **The peer moves its own card** as it works: In Progress when it starts, Review when its PR is open (add the PR as a
  reference, `--ref <PR URL>`), Done when it is merged and the worktree is gone. Blocked: the card stays where it is and gets the
  label `blocked` plus a comment naming who unblocks (`--add-label blocked --comment "<who/what>"`).
- **The project-manager** fills **Next** in priority order (`--ordinal`), assigns a card when it hands it out, and is the only
  one who creates cards for new work the user asked for. Nobody invents work.
- **keep-busy and fleet-next** take an idle peer's next item from Next: first a card already assigned to it, then the
  top unassigned card that fits its role.

## Sync my Jira tickets

Skip this when `$FLEET_TRACKER_PROJECT=none`. Site and project come from the target repo's AGENTS.md, or the profile's
override (fleet skill, rule 9).

1. Read the logged-in user's open issues with the Atlassian MCP: `searchJiraIssuesUsingJql`, cloudId = the site host,
   JQL `assignee = currentUser() AND project = <KEY> AND (statusCategory != Done OR updated >= -14d) ORDER BY rank`,
   fields `summary, status, parent, issuetype`. Page until done.
2. Build one JSON array, one object per issue (an epic itself is not a card; its children carry it):
   ```json
   [{"key": "<KEY>-<n>", "summary": "...", "status": "<status name>", "statusCategory": "new|indeterminate|done",
     "epic": "<epic key> <epic summary>" or null, "url": "https://<site>/browse/<KEY>-<n>"}]
   ```
   `statusCategory` is the status's category key. `epic` is the parent when the parent is an Epic.
3. Write it to `$FLEET_STATE/jira-issues.json` and pipe it in: `~/.claude/skills/fleet-board/scripts/board-jira < "$FLEET_STATE/jira-issues.json"`.

The script never makes a duplicate: a card is tied to its issue by the title prefix `[<KEY>-<n>] `, so run it as often as you
like. Epics become milestones. Jira moves a card only while it sits in Backlog or Next, or when Jira says done; a card a peer
has moved stays where the peer put it. Report its last line to the user.

## Specs and architecture on the board

```bash
~/.claude/skills/fleet-board/scripts/board-docs                  # FLEET_BOARD_DOCS from the profile, else found in the repo
~/.claude/skills/fleet-board/scripts/board-docs docs/architecture specs/journey.md   # these paths in the target repo
```

It copies the target repo's spec and architecture `.md` files to `backlog/docs/repo/` (the Docs view). Paths: the
arguments, else `FLEET_BOARD_DOCS` in the profile, else the paths AGENTS.md names for specs and architecture (pass them as
arguments), else every tracked `ARCHITECTURE*`/`SPEC*` file and every `.md` under a folder named architecture, arch, spec(s),
adr(s), decisions or design. The repo is the source: each run brings `docs/repo/` in line with it, file by file in place,
so the open board page shows the change without a restart; never edit those copies. Run it after a spec or architecture PR
merges.

## Decisions

The user's decisions live on the board, not in chat or fleet-context.md. Backlog's MCP server has no decision tools, so
use the script:

```bash
D=~/.claude/skills/fleet-board/scripts/board-decision
$D list accepted                 # read these before acting; never ask again what one already answers
$D ask "<question>" "<what is asked; options, each with its impact; your recommendation>"   # prints decision-<n>
$D answer decision-<n> "<the user's answer, verbatim> (<user>, <date>)"                     # status → accepted
$D list proposed                 # what waits on the user
$D show decision-<n>
```

The flow: a peer that needs the user's call asks the project-manager; the project-manager runs `ask` (one decision per
question) and puts the question to the user with its options; when the user answers in chat, it runs `answer` with their
words. A hold ("don't merge X until …") is a decision too.

## Rules

- The board is shared by the whole fleet: change only cards you own or are told to change.
- No board (the backlog folder is missing, or no `backlog` CLI): say so once, run `task install:backlog` if the CLI is
  missing, and fall back to `$FLEET_STATE/fleet-context.md` as before.
- Backlog.md is pinned (`FLEET_BACKLOG_VERSION` in `skills/fleet/scripts/lib/backlog.sh`); `task install:backlog` installs
  that version. Never `npm update` it by hand.
