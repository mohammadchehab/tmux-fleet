# tmux-fleet

**A daemon that runs a team of coding agents.**

tmux-fleet manages a pool of AI agents—Claude, Cursor, or Deepinfra—orchestrating them through a supervisor, a PM (project manager), a judge, and a persistent board. One agent at a time claims a piece of work, solves it, and hands off the result. The fleet is event-sourced: every decision is audited, every state change is recorded, and any agent can replay the log to catch up. There is no server, no auth, no rate limits—just a local daemon and your git repos.

**Why?** Coding agents work best in small, focused tasks. A fleet breaks a large goal into pieces, routes them to agents with the right skills and availability, runs them in parallel where safe, and hands off results deterministically. One agent's work triggers the PM to reassess; the judge answers hard questions that PM rules could not decide; the board tracks what each agent is doing and what is next.

## Quickstart

From the root of this checkout:

```sh
# Install and set up a profile
pnpm install
pnpm fleet init me      # writes ~/.config/fleet/profiles/me.yaml
# Edit the config: add your repo(s) under `repos`
pnpm fleet up me        # starts fleetd

# In another terminal, see what the fleet is doing
pnpm fleet ls           # list peers and their Work
pnpm fleet watch me     # live: who is doing what, what waits on you, take a peer over
pnpm fleet-board me     # web board of Work items at http://127.0.0.1:7777
```

The fleet reads from your repos, opens PRs, and records everything in the event store. Each agent works on one piece of Work at a time: propose → ready → assigned → in progress → merged. The PM assigns ready Work to idle peers; the judge answers questions the PM cannot decide alone.

## Providers

Choose which AI platform powers your agents. Each is a `Provider` that answers one question: "given a git state and a task, what does the agent propose?" Multiple providers in one fleet is supported—each peer can use a different one.

- **Claude** — Anthropic's Claude models via the Anthropic API. Includes code analysis and sophisticated reasoning. Start here if you have Anthropic API access.
- **Cursor** — Cursor's agent. Integrates with your IDE and respects your editor config. Good for development workflows where the agent works alongside you.
- **Deepinfra** — Open-source models (Llama, Qwen, etc.) via Deepinfra's API. Lower cost, community-driven inference.

## Architecture

The fleet is one event-sourced store, one supervisor process, and a pool of peers. Every decision flows through:

1. **Supervisor** — watches peers: registers them, detects when they go idle or fail, and adjusts the fleet state.
2. **PM (project manager)** — runs every tick to decide what Work should be ready and who should work on it. It wakes on Work state changes, peer availability, and judge answers.
3. **Judge** — answers questions PM rules cannot decide: "Is this PR mergeable? Is this task description clear enough?" Uses structured completions from the agent's provider.
4. **Board** — a persistent log of Work items: proposed, ready, assigned, in progress, merged. Synced with your tracker (GitHub, Linear, etc.) if configured.

## Learn more

- **[Fleet v2 architecture](docs/design/fleet-v2-architecture.md)** — the design of record. Start here to understand how the fleet works and why it is built this way.
- **[Running a fleet](docs/runbook/README.md)** — operations guide: setting up profiles, managing peers, debugging, and monitoring.
- **[Decisions](docs/decisions/)** — the reasoning behind major design choices.

## Working on the fleet

Node ≥22.18 runs TypeScript directly—no build step. A package's `exports` map points at its `src/index.ts`.

```sh
task test             # Run all tests (node --test + typecheck)
task typecheck        # tsc --noEmit (compiler is the lint)
```

The architecture is enforced as a test: `tests/architecture/` walks the codebase and fails if imports violate §1.1 (foundation importable by all, groups never sideways, only `apps/daemon` wires things). See [AGENTS.md](AGENTS.md) for the import rules and conventions.

## One checkout, two eras

**v2** (current) is rebuilt in TypeScript with an event store, supervisor, and deterministic PM. It lives in `packages/`, `apps/`, and `tests/`.

**v1** (legacy bash fleet) was deleted once v2 took over. It is not lost—`git log -- legacy/v1` has the full history if you need to reference or restore it.

---

**Status:** v2 is under active development. The core architecture is stable; new features land as PRs to main. Join the discussion or file issues for features, providers, or operational improvements.
