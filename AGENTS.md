# AGENTS.md

Guidance for an agent working in this repository.

## Read first

[`docs/design/fleet-v2-architecture.md`](docs/design/fleet-v2-architecture.md) — the design of record. §1.1 is the
layout and the dependency direction; every rule below is a consequence of it.

## The one rule that is enforced by a test

Imports flow **down into `foundation/` and never sideways**:

- anything may import `foundation/{core,contracts,store}`;
- a group (`runtime`, `orchestration`, `workspace`, `security`, `notify`, `integrations`) never imports another group —
  declare a port in `@fleet/foundation-contracts` and let `apps/daemon` inject the implementation;
- inside a group, a package imports only the earlier-listed siblings (`foundation` before `runtime` before …);
- a provider never imports the store; `runtime/supervisor` adapts its events;
- apps never import each other; `apps/daemon` is the only wiring point, and `apps/clients`/`apps/hooks` reach the
  daemon over its socket with foundation types only.

`tests/architecture/` enforces this on the real tree and fails with `file:line`. If you believe a rule is wrong, change
it deliberately in `tests/architecture/rules.ts` — with the design as the argument — not by adding an exception.

## Checks before you call something done

```sh
task typecheck   # tsc --noEmit; the compiler is the lint, there is no eslint
task test        # the v1 smoke suite, then the v2 tests, then typecheck
task lint        # shellcheck and skill frontmatter, for v1
```

No build step: Node runs the TypeScript directly, so `erasableSyntaxOnly` is on and a package's entry point is its
`src/index.ts` via the `exports` map.

## v1 is live; leave it alone

`legacy/v1/` is the bash fleet that is **installed and running right now** — `task install` links it into
`~/.claude/skills`, `~/.cursor/skills` and `~/.local/bin/fleet`. It is frozen until phase 3 removes it. Do not
"clean it up", restructure it, or change its script paths. A change there is only justified when it keeps v1 working
through the rebuild, and it needs the smoke suite to prove it (`task test` runs it).

## Conventions

- Package names are `@fleet/<group>-<name>` — e.g. `@fleet/foundation-store`, `@fleet/runtime-provider-sdk`.
- Cross-package tests live in `tests/`; unit tests sit next to their package as `test/*.test.ts`. One `task test` runs
  both sweeps, so a new package needs no task of its own.
- `spikes/` is outside the workspace on purpose: not installed, not type-checked, not tested. A spike proves something;
  the proof gets promoted into a package.
- Never push to `main`; every change goes through a pull request.
