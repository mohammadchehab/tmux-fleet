# Agent SDK spike — throwaway harness

Proves whether the Claude Agent SDK (TypeScript) can carry fleet v2's `Provider` interface for both `claude` and
`deepinfra`. **Findings: [`docs/design/spikes/agent-sdk.md`](../../docs/design/spikes/agent-sdk.md).**

Nothing here is imported by the fleet, ever. This folder is evidence, not code — it can be deleted once the findings
are accepted, and the captured `results/` are what the doc cites.

## What it does

One script, `probe.mjs`, runs a single named probe against a single provider by spawning the SDK and speaking to it
through streaming input. Each probe prints `PROBE_RESULT <json>` on stdout; `run.sh` fans that across probes and
providers and writes one log per pair plus a combined `results/<provider>-evidence.jsonl`.

Probes:

| probe | question it answers |
| :- | :- |
| `events` | which message types/subtypes arrive; turn boundaries |
| `usage` | `getContextUsage` full vs summary, `modelUsage`, cost fields |
| `question` | does `AskUserQuestion` arrive as a typed waiting-input signal |
| `permission` | `canUseTool` in default mode, `setPermissionMode`, bypass |
| `interrupt` | `interrupt()` receipt, how the aborted turn ends |
| `model` | model identity from the SDK, not a UI string |
| `switch` | `setModel()` mid-session |
| `structured` | `outputFormat: json_schema` → `result.structured_output` |
| `compaction` | `/compact` → `compact_boundary`, status frames |
| `resume-write` / `resume-read` | resume by id in a **second process**, context intact |

Two follow-up scripts answer a narrower question — does `init.permissionMode` echo what was requested, and if not,
do user settings cause it? (`t-mode.mjs`: a matrix of requests × settings isolation, plus a behavioural write in
`default`; `t-mode2.mjs`: every init in order around a mid-session `setPermissionMode`). They exist because the first
draft of the findings misread its own probe; see the correction in §5 of the doc.

## Running it

```sh
cd spikes/agent-sdk
./run.sh claude        # or: ./run.sh deepinfra  |  ./run.sh all <probe>
```

Prerequisites: `node` ≥ 20, a logged-in `claude` CLI, and — for `deepinfra` — a key at `~/.config/deepinfra/key`
(or `DEEPINFRA_API_KEY` in the environment). Individual probes: `node probe.mjs <provider> <probe>`.

`PROBE_WATCHDOG_MS` (default 90 000) hard-exits a stuck probe with status 3, so a hung turn cannot hold the suite.

## Two things this harness exists to get right

1. **Environment isolation.** `options.env` *replaces* the child's environment. The harness builds it from scratch and
   strips every inherited `ANTHROPIC_*`, `CLAUDE_CODE_*`, `CLAUDECODE` and `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`. Without
   this, a session that asks for `claude` silently runs whatever endpoint the parent shell exports — the prototype for
   that failure is preserved in `results/claude-env-inheritance.log`, and it is the reason the adapter must never
   forward `process.env` wholesale.
2. **Streaming input.** Sessions are created with `prompt: AsyncIterable<SDKUserMessage>`, not a string. With a string
   the query closes when the turn ends and `getContextUsage()`, `setModel()` and `setPermissionMode()` fail with
   `Query closed before response received`.

## Spend

Small and bounded: ~12 short turns on each provider, one `/compact`, no large prompts. Recorded per-run cost is in
`results/*-usage.log` (`total_cost_usd`). DeepInfra's figure in that field is a Claude-priced guess and is not real
money — see gap 2 in the findings.

## Files

| path | what |
| :- | :- |
| `probe.mjs` | the harness (provider-agnostic; one probe per invocation) |
| `t-mode.mjs`, `t-mode2.mjs` | the permission-mode echo follow-ups |
| `run.sh` | runs every probe against one provider, writes `results/` |
| `results/` | captured output — the evidence the findings cite |
| `results/versions.txt` | SDK / CLI / node / model ids for this run |
| `results/_summary.txt` | exit status of every probe run |
