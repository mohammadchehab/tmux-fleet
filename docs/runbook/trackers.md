# Trackers (the board)

§3 of [the design](../design/fleet-v2-architecture.md) is the spec; this is how to point the fleet at a board, what it
reads, what it writes, and what it deliberately leaves alone.

A tracker is a **source and a sink**, never the fleet's state. The store stays the source of truth; a card becomes a
`Work` that carries `Work.external`, and the Work's own transitions are echoed back to the card. That is why nothing
in the profile can be "the state of a ticket" — there is no such field.

Two packages: `packages/integrations/trackers/backlog` (the adapter over the `backlog` CLI, one argv per call, an
injectable runner and no network in its tests) and `packages/orchestration/routines/src/routines/tracker-sync.ts` (the
routine body: pull, dedupe, propose, move). The daemon is the only place the two halves meet (§1.1), and it is what
turns the profile's block into a `Tracker` (`apps/daemon/src/wiring/compose.ts`).

## Turning it on

The profile names the board:

```yaml
# ~/.config/fleet/profiles/<profile>.yaml
trackers:
  system: backlog                       # the one adapter this build ships
  query: To Do,In Progress              # handed to `backlog task list -s`, unchanged
  path: ./board                         # the Backlog.md project directory; the CLI is per-directory
  urlBase: https://github.com/acme/widgets/blob/main   # optional: a card's path becomes a URL under it
  role: engineer                        # optional: the role a proposed Work asks for
  comments: true                        # optional, default OFF: mirror `fleet note` to the card (below)
  statuses:                             # WorkState → the board's own column
    in_progress: In Progress
    in_review: In Review
    merged: Done
```

`statuses` is optional and may name any subset: a state the profile leaves out is **not** written to the board. The
fleet has no opinion about a tracker's vocabulary, and inventing a column would rewrite a board nobody asked it to
touch. A misspelt key (`in_progres`) is refused at load, because it would be a transition the fleet believes it
configured and a board that never sees.

The poll's period is **not** in this block: it is the routine's, under `routines.tracker-sync.everyMinutes`. When a
routine runs is the scheduler's business (§6), and a second spelling of it would be a second answer.

## What a heartbeat does

Every period, `tracker-sync` pulls the query and proposes a `Work` for each key no existing Work names — dedupe is by
`(system, key)` against the Works in the log, not a remembered cursor, so a replay or a rebuilt store takes on its own
cards rather than duplicating them. The Work's id is derived from `(system, key)` for the same reason.

Before proposing, the card is read with `get`, so the Work — and the brief built from it — carries the ticket as it is
now, not as the list row summarised it. **A card edited after it was proposed is not re-read**: no `work.*` event
updates a title or a body, so the ticket in the brief is the one the fleet took on. Re-proposing would be a second
Work for one card.

The brief names the ticket, so a peer can read what a human filed and put the key in its PR:

```
Ticket: backlog TASK-12 — https://github.com/acme/widgets/blob/main/backlog/tasks/task-12.md
```

## What a work event does

| event | the card |
| :- | :- |
| `work.started` | moved to `in_progress`'s status |
| `work.review_requested` | moved to `in_review`'s status, and the PR url appended to the notes as `PR: <url>` |
| `work.merged` | moved to `merged`'s status |
| `work.noted` | **only with `comments: true`**: the note appended as a comment, phase in the words |

The note is appended, never set, and only when the card does not already name that URL — a re-run must not gather one
`PR:` line per wake. Notes a human wrote are left where they are.

## `comments`: mirroring a peer's note, and why it is off

A `work.noted` reaching a board is a comment, not a column: a note is progress a peer reported, and no board status
means "the peer said something". Because that text is the peer's — and because the board a profile maps is not
necessarily the fleet's own — the mirroring is **opt-in**:

```yaml
trackers:
  comments: true        # absent means no
```

With the setting absent, `tracker-sync` appends nothing for a note and records `commented: 0`; the run still happens,
it just mirrors nothing. With it on, the body passes through `redactSecrets` before it leaves the machine, so a token
a peer pasted into a note does not end up on a customer's ticket. Either way the `blocked` phase raises its `Decision`
in the fleet's own inbox — that path never leaves the machine, so it needs no setting.

Turn it on for a board the fleet owns. Leave it off for a board a customer reads.

## Reading the record

Each run appends one `tracker.synced`: `{system, query, pulled, proposed, transitioned, linked, commented, failed,
error?}`. A run that found nothing still says so.

- **A pull that failed throws** and the scheduler records `routine.failed`. A board that was not read must not read as
  a board with nothing on it.
- **One card the board refuses** (a locked column, a status the CLI rejects) is counted in `failed`, named in `error`,
  carried in `actionsFailed` — and the other cards still move. One card the board will not move does not make the rest
  lies.
- A card listed and already gone between the list and the `get` is one failed action, not a proposal.

## The adapter itself

`backlog` 1.55.3, four calls:

| port | CLI |
| :- | :- |
| `pull(query)` | `backlog task list --json -s <query>` (no `-s` for the whole board), then one `task view` per row |
| `get(key)` | `backlog task view <key> --json`; "not found" is `undefined` |
| `transition(key, to)` | `backlog task edit <key> -s <status> --plain` |
| `link(key, url)` | `task view`, then `backlog task edit <key> --append-notes "PR: <url>" --plain` |

`pull` is two calls, not one, because `task list --json` is a summary: it prints no `path` and no `description`, so a
row on its own has no URL a human can open and no body a brief can quote. Each row is therefore read with the same
`task view` `get` makes, up to eight at a time, and the row's place is taken by the card itself — one extra call per
card on a poll that already paid for the list. A card that leaves the board between the list and its read is dropped;
a view that fails for any other reason fails the pull, so a broken read never looks like a shorter board.

A non-zero exit that says "not found" is an answer; any other failure throws `external_failed`, so a broken project
never reads as a deleted card. A `schemaVersion` other than `1` is refused rather than guessed at.

Everything is injectable: the adapter takes a `run` function and the tests supply one, so the suite asserts the argv
and initialises no project. Nothing here is on a network — a board is a working copy of markdown.
