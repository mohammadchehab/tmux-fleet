# tmux-fleet

A fleet of AI sessions that build software together, in Claude Code or Cursor — being rebuilt so that one
deterministic supervisor, not a set of chat sessions, is what actually runs the fleet.

**The design is [`docs/design/fleet-v2-architecture.md`](docs/design/fleet-v2-architecture.md).** Read it before
touching anything here; it is the authority on layout, dependency direction and what each phase adds.

## One checkout

| | where | what it is |
|---|---|---|
| **v2** | `packages/`, `apps/`, `tests/` | one event-sourced store, one supervisor process, peers behind a typed `Provider` |

The bash fleet that lived here as `legacy/v1/` was deleted once the v2 fleet took over (design §1.1, "what happens to
the old bash"). It is not gone from history: `git log -- legacy/v1` has it, and the last commit that carried it can be
checked out whole.

## Working in v2

Node ≥22.18 runs the TypeScript directly — there is no build step, and a package's `exports` map points at its
`src/index.ts`.

```sh
task install          # pnpm install --frozen-lockfile
task typecheck        # tsc --noEmit — the compiler is the lint; there is no eslint (§14)
task test:node        # node --test: tests/ and every package's own test/
task test             # test:node, then typecheck — the whole gate
```

`task test` is the gate, and it is the only one: the shellcheck and skill-frontmatter lint went with v1. Cross-package
tests live in `tests/` — that
is where the §1.1 rules live — and a package's own unit tests sit beside it as `test/*.test.ts`, run in the same sweep,
so a new package needs no task of its own.

## Tool policy

A session's `toolPolicy` is a guard rail, not a sandbox; no-production is enforced by environment. An `allow` rule
covers one whole command and never one carrying `;`, `&`, `|`, a backtick, `$(`, `<`, `>` or a newline — those go to a
person, as does any subject over 64 KB. Nothing is truncated: `deny` and `ask` rules are searches over the whole
input, so a command hidden in a chain is still caught. File paths are resolved against the session's cwd before a rule
sees them.

## Layout (§1.1)

```
packages/foundation/     core, contracts, store     — what everything may import
packages/runtime/        providers/, supervisor, mailbox
packages/orchestration/  pm, routines, briefs, gate, ledger
packages/workspace/      worktree, codegraph
packages/security/       findings, scanners
packages/notify/         core, channels/macos
packages/integrations/   github, trackers
apps/                    daemon (fleetd), clients/, hooks/
tests/architecture/      the import-direction rules, enforced as a test
```

The dependency rules are not a convention, they are a test: `tests/architecture/` walks the real workspace, resolves
every import and fails on a violation, naming `file:line`. In short — foundation is importable by everything; groups
never import another group sideways (they declare a port in `foundation/contracts` and `apps/daemon` injects it); a
provider never imports the store; apps never import apps, and only `apps/daemon` wires anything.
