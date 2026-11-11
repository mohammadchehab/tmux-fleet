# Fleet, in the editor

The fleet's peers in the activity bar: who needs you, what each one is doing, and
a takeover in one click. One window per editor, no daemon of its own — it reads
`ls` from the `fleetd` that is already running and runs the `fleet` CLI for
anything that changes a peer.

- **Needs you** — open decisions and peers waiting for input. Clicking a
  decision asks for the answer (the same `fleet decide` the CLI sends).
- **Peers** — one row per peer, with what it is doing now and how many turns it
  has run. A peer that has compacted is marked; its tooltip has tokens and cost.
- **Peers you can act on** — the right-click menu offers what the peer's
  standing allows: takeover (when the turn ends, or now), send a message, stop,
  start.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `fleet.command` | `fleet` | How to run the CLI. A checkout can point at `node …/apps/clients/cli/src/main.ts`. |
| `fleet.profile` | *(empty)* | The profile this window shows. Empty means: `FLEET_PROFILE`, then the single running profile on this machine. |
| `fleet.socket` | *(empty)* | An explicit daemon socket, `~/` included. Wins over everything else. |

Which fleet a window looks at, in order: `fleet.socket`, `fleet.profile`,
`FLEET_SOCKET`, `FLEET_PROFILE`, then the profiles with a running daemon — one is
used, several are a question, none is a "Start" row.

## Over Remote-SSH

The extension declares `extensionKind: workspace`, so it runs wherever the code
is: on the remote host, next to that host's daemon. It is installed *per host* —
`fleet editor install` installs into the local editors and into the editor
servers found under `~/.vscode-server` and `~/.cursor-server` on this machine.
For a host you have never connected to, run it there after the first connection.

## Workspace trust

The extension runs a CLI and connects to a Unix socket, which is what workspace
trust exists to gate, so it declares itself unsupported in untrusted workspaces:
in a folder you have not trusted, it does not activate at all.

## What it does not do yet

Live output and attachments (`peer.watch`) and a shared view model are later
batches; until then the tree polls `ls` every three seconds, and clicking a peer
opens its actions rather than its output.
