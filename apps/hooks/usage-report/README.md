# `fleet-usage-report` — the Stop hook that reports a turn's usage

Claude Code runs this hook after every turn with the Stop payload on stdin. It measures the turn from the
transcript, compares the total against `FLEET_CONTEXT_LIMIT`, and posts the result to the daemon's `usage`
method, which appends `turn.usage_recorded` (§6.2, §8).

## It is not installed under fleetd

**Under fleetd nothing needs to be installed.** The supervisor already sits at every turn boundary — it is the
consumer of the provider's event stream — so it records `turn.usage_recorded` itself, from `provider.turnSpend()` and
`provider.usage()`, with the tool calls it counted off the same stream. That path is the design of record: one
measurer, and nothing in a peer's settings to keep in step with the daemon.

The hook therefore exists for the sessions fleetd does not supervise: the v1/tmux sessions and any peer started by
hand. It is the same report by a different route — a transcript read after the fact — because in those sessions
there is no supervisor to ask.

Two consequences worth knowing when reading the two paths side by side:

- **Subagents.** The hook's route can miss a `Task` subagent's tokens when the transcript writes them to a
  sidechain file rather than the main transcript. The supervisor's route does not: the provider's `result` message
  reports `modelUsage` cumulatively, covering the main loop, subagents, sidechains and internal calls.
- **Ordering.** The hook reports after the fact over the socket; the supervisor records synchronously at the
  boundary, so a session that has already exited still yields its last turn's row.

## What it costs to run

Nothing a peer can notice. It never fails the Stop: no socket, no limit, an unreadable transcript — each is a line
on stderr and exit 0, because a hook that blocked a turn to report a number would cost more than the number is
worth.

## Environment

Read from the session's env, which the supervisor provisions for fleetd sessions either way (the Stop hook is also
handed `FLEET_SOCKET` and `FLEET_CONTEXT_LIMIT` so that a hand-started session in the same fleet still reports):

| Variable | Meaning |
| --- | --- |
| `FLEET_PEER` | The peer the turn belongs to. No peer, no report. |
| `FLEET_SOCKET` | The daemon's socket. No socket, no report. |
| `FLEET_CONTEXT_LIMIT` | The window the turn is measured against; no limit, no purge trigger. |
| `FLEET_WORK_ID` | Optional: the Work item the turn was doing. |
