# Editor extension: the fleet inside VS Code and Cursor

**Status**: design, spiked (§10).
**Builds on**: [`watch-and-attach.md`](watch-and-attach.md) — `peer.watch`, hold and release, stop and start, the
needs-you list. This document adds a client and nothing to the daemon.

## 1. Intent

The team works in VS Code and Cursor. They should see the fleet, answer what is waiting on them and take a peer over
without leaving the editor, and what they see must be the same facts `fleet watch` shows in a terminal.

Success looks like this:

- Opening a repo that has a running fleet shows the peers in the editor's side bar, live.
- The same needs-you list sits above them and a decision is answered from there.
- Taking a peer over opens the provider's own CLI in the editor's terminal.
- A person who uses the terminal and a person who uses the editor never see different states for the same fleet.

### Constraints

- **One extension for both editors.** Cursor runs VS Code extensions; one package, one build.
- **A client, like the others.** It talks to fleetd over the socket and holds no state of its own (architecture §1.1).
- **It ships with the fleet.** The fleet installs it; nobody looks for it in a marketplace.
- **It never types into a peer.** Same rule as the watch.
- **No second implementation of the view's logic.** What the rows say is computed once and shared.

### Non-goals

- A chat panel that imitates a provider. Talking to a peer is the takeover, in a terminal.
- Publishing to the VS Code Marketplace or Open VSX.
- Starting, configuring or editing a fleet profile from the editor.

## 2. Design overview

```
 ┌──────────────── VS Code / Cursor window ─────────────────────────────────────┐
 │ FLEET          │  editor                                                     │
 │ ▾ NEEDS YOU (2)│                                                             │
 │   ? Approve…   │                                                             │
 │   ? architect  │─────────────────────────────────────────────────────────────│
 │ ▾ PEERS        │ TERMINAL   fleet: engineer-1 ▾                              │
 │   ● engineer-1 │  claude --resume …      ← takeover, the native CLI          │
 │     17% Edit … │                                                             │
 │   ○ engineer-2 │─────────────────────────────────────────────────────────────│
 │   ■ reviewer   │ OUTPUT     Fleet: engineer-1 ▾                              │
 │   ◆ pm         │  ● Read  src/mailbox.ts  ← live, read-only                  │
 └────────────────┴─────────────────────────────────────────────────────────────┘
        │ tree view            │ integrated terminal         │ output channel
        └──────────── extension host (Node) ── socket ──► fleetd
```

Three editor surfaces, each the editor's own widget:

1. **Side bar tree** — needs-you and peers, the same rows as the watch's list.
2. **Output channel per peer** — the live display feed, read-only.
3. **Integrated terminal** — the takeover, running `fleet attach <peer>`.

## 3. Shared view model

`fleet watch` and the extension must not each decide what a row says. A new package, `@fleet/client-view-model`, owns
it:

- a `peer.watch` client: connect, replay the buffer, follow, reconnect;
- a pure reducer from stream frames to a view state: the needs-you rows, the peer rows (state mark, context used, the
  "doing now" line), and each peer's display lines;
- the action list for a row, by peer state (watch-and-attach §7).

`fleet watch` renders that state as ANSI. The extension renders it as tree items. The reducer's tests are the tests of
both.

This is a refactor of what the watch-and-attach batch builds, and is done there if the two are built together, or as
the first step here if not.

## 4. Side bar

A view container named Fleet in the activity bar, with one tree:

- **Needs you (n)** — one item per open decision and per peer waiting for input. The count is also the container's
  badge, so it is visible with the side bar closed.
- **Peers** — one item per peer: state icon, name, and a description of context used and what it is doing now. A peer
  at or past the self-purge threshold gets a warning colour. Until the daemon reports context used (watch-and-attach §6),
  the description shows what the peer is doing and its turn count, and the warning marks a peer that has compacted.

Clicking a peer opens its output channel. Its context menu and inline buttons are the watch's actions:

| Peer state | Actions |
| --- | --- |
| running | Take over when the turn ends, Take over now, Interrupt, Send a message, Stop |
| held | Reopen the native session, Release |
| stopped | Start |

Clicking a decision opens a quick pick of its options; choosing one calls `decide`. Send a message opens an input box
and sends through the Mailbox as the person, as kind `nudge`: from this window a message is always a person prodding a
running peer.

A status bar item shows `Fleet: 4 peers · 2 need you` and opens the side bar.

The tree provider keeps one stable element object per row and refreshes a changed row with
`onDidChangeTreeData.fire(element)`. The editor matches that element by identity against what `getChildren` returned,
so a provider that hands back fresh copies on each update refreshes nothing, silently. The view model can stay
immutable; the extension maps it onto stable elements keyed by peer id and decision id.

## 5. Live output

One output channel per peer, created when first opened, fed from the shared view model. It is the editor's read-only
log surface: it scrolls, searches and copies without any code of ours. Lines are prefixed as the watch prefixes them
(mail in and out, tool, text).

An output channel is plain text, so there is no colour beyond what a log syntax gives. That is accepted for the first
version. A webview would look better and costs a second UI to maintain; it is not built now.

## 6. Takeover

Every takeover action runs `fleet attach <peer>` (with `--now` where asked) in a new integrated terminal named
`fleet: <peer>`. The attach client does the hold, the clean environment, the native CLI and the release
(watch-and-attach §5). The extension adds nothing to that path, so a takeover from the editor and from a terminal are
the same thing.

When the terminal closes, the attach client has already released. If the editor is killed with a takeover open, the
peer stays held and the tree shows it as held with Reopen and Release, as the watch does.

## 7. Finding the fleet

The extension uses the rule the other clients use (`socketPathOf`): an explicit setting, then the environment, then the
profile layout.

- A socket path setting is absolute; editor settings do not expand `~`, so the extension expands a leading `~` itself
  against the extension host's home.
- Setting `fleet.profile` (workspace scope) names the profile. With it unset, the extension lists the profiles with a
  running daemon; one is used, several ask once and the choice is saved to the workspace. Matching a profile to the
  workspace's repo waits until `ls` reports the profile's repos; a client does not parse profile files.
- Setting `fleet.command` (default `fleet`) is the CLI the extension runs in terminals, so a development checkout can
  point it at its own entry point.
- No running fleet: the tree shows "No fleet is running for this folder" and a Start button that runs `fleet up` in an
  integrated terminal. The extension polls the socket path every few seconds until it appears; it never starts a daemon
  itself.
- The daemon goes away: the tree keeps the last rows greyed out with "disconnected" and reconnects on its own.

**Remote windows.** The extension is declared a workspace extension, so in Remote-SSH, a dev container or WSL it runs
where the repo and fleetd are and reaches the socket there. This is what makes it work when the fleet runs on another
machine.

## 8. Shipping it with the fleet

- Source: `apps/clients/editor`, a client app like `cli`, `view` and `board`. It imports foundation and the shared
  view model only.
- Build: the extension host needs bundled JavaScript. One bundle step produces `fleet-editor-<version>.vsix`; this is
  the first app in the repo with a build artefact, and the artefact is built in CI and attached to the release, not
  committed.
- Install is per host, because the extension runs where fleetd runs. `fleet editor install` runs on the machine that
  hosts the fleet and installs into every editor host it finds there:
  - locally, `code` and `cursor` on the path, with `--install-extension <vsix>`;
  - on a machine reached over Remote-SSH, the editor servers under `~/.vscode-server` and `~/.cursor-server`, through
    each server's own CLI (`code-server` / `cursor-server --install-extension <vsix>`). A local `code --install-extension`
    never carries a file-installed package to a remote host, so running the command on the fleet's host is the only way
    that works.
  The package installed is `--vsix <path>`, or by default the newest one built into `apps/clients/editor/dist`, until
  releases carry it. Whether a host already has the extension is read from its extensions directory, not by running the
  editor CLI, because `fleet up` asks on every start.
  A server appears the first time an editor connects to that host, so `fleet up` prints one line when it finds an
  editor or editor server without the extension, naming the command to run. `fleet editor uninstall` reverses it.
- Packaging is `vsce package` on the bundled output. The manifest carries a repository field and a licence file, so
  packaging needs no flags that skip checks.
- Version: `DaemonStatus` gains `protocolVersion`, added with `peer.watch`, and the extension reads it on connect. On a mismatch it shows "update the extension:
  run `fleet editor install`" and does nothing else, so an old extension cannot misread a new stream.

## 9. Failure and limits

- A stalled extension host is dropped by the daemon like any slow watch client (watch-and-attach §6); the extension
  reconnects and replays the buffer.
- Several windows on the same repo each hold their own watch connection. That is one connection per window, which the
  daemon's per-watch design allows. Several hosts each need their own install (§8).
- An untrusted workspace: the extension stays inactive. It runs a CLI in the workspace, which is what workspace trust
  exists to gate.

## 10. Proven, and still to prove

A spike (2026-11-11, VS Code 1.145 and Cursor 3.29, a fake daemon socket) proved:

- A workspace extension reaches the fleet socket under the extension host's home, locally and over Remote-SSH, in
  both editors.
- `code` and `cursor --install-extension <vsix>` install a local package and it activates. Over Remote-SSH it reaches
  the remote host only through that host's editor-server CLI (§8).
- Eight peers updating five times a second cost about 2% of one core in the extension host with no dropped updates,
  either way of refreshing. Single-row refresh is still the rule (§4), because it scales and it is no harder.

Still to prove:

- The same in a dev container.
- `fleet editor install` finding a remote host's editor servers by itself.

Tests that launch an editor do so with a throwaway `--user-data-dir` and `--extensions-dir`, off the person's screen
where the platform allows, and never against their own editor profile.

## 11. Delivery

After the watch-and-attach batch, in this order:

1. `@fleet/client-view-model`, with `fleet watch` moved onto it.
2. The extension: connect, tree, status bar, output channels.
3. Actions: takeover in a terminal, stop and start, decisions, send a message.
4. Bundle, `fleet editor install`, the release artefact, the version check.

## 12. Testing

- The view model's reducer and action list are pure and tested without an editor; they are the shared proof that both
  clients show the same thing.
- The extension's logic takes a narrow port over the editor API (tree view, quick pick, terminal, output channel) and is
  tested with `node --test` against a fake of that port and a fake daemon socket: rows appear, one row refreshes, a
  decision is answered with one `decide` call, a takeover opens a terminal with the expected command line. The
  editor's own test runner is not used: on macOS it opens a real window on the person's screen.
- One manual pass per release in VS Code and in Cursor, local and over Remote-SSH: see a peer work, answer a decision,
  take over, release.
