# Spike: does the Claude Agent SDK carry the `Provider` interface?

**Question (fleet v2 §16, first risk):** can the Claude Agent SDK (TypeScript) supply what §4's `Provider` needs —
usage, a typed waiting-input signal, events, resume, interrupt, permission modes and a trustworthy model/endpoint —
for **both** `claude` and `deepinfra` (the same SDK pointed at DeepInfra's Anthropic-compatible endpoint)?

**Verdict:** yes for both, with four gaps that are about *trusting* the SDK's numbers, not about missing calls. Both
providers end up with the same `capabilities`; the differences are in what the adapter must fill in itself
(context limit, cost, endpoint), and those are listed below as proposed contract changes for the architect — not
decided here.

Environment and how to reproduce are in [`spikes/agent-sdk/README.md`](../../../spikes/agent-sdk/README.md).
Every claim below cites the captured run in `spikes/agent-sdk/results/`.

| | |
| :- | :- |
| Agent SDK | `@anthropic-ai/claude-agent-sdk` **0.3.322** |
| Claude Code CLI (spawned by the SDK) | **2.1.285** |
| Node | v26.11.0, macOS (arm64) |
| `claude` | default model `claude-sonnet-5-5`, 1M window, keychain OAuth (`apiKeySource: 'none'`) |
| `deepinfra` | `ANTHROPIC_BASE_URL=https://api.deepinfra.com/anthropic`, `ANTHROPIC_AUTH_TOKEN` from `~/.config/deepinfra/key`, `ANTHROPIC_MODEL=deepseek-ai/DeepSeek-V4.1-Flash-1017` in **that process's** env |
| Spend | Claude ≈ $0.04 (list-priced), DeepInfra < $0.01 real (the SDK's `costUSD` for it is a Claude-priced guess, see §1c) |

The SDK spawns one CLI subprocess per session and speaks a typed control protocol to it. Everything below is the
public `query()` API; no `--output-format stream-json` parsing anywhere.

---

## 1. `usage()` — context tokens and the context limit

**Yes, but the limit is only trustworthy for Anthropic-hosted models.**

Two independent sources, both readable at every turn boundary:

### a) `getContextUsage({ detail: 'full' })` — the one to use

`Query.getContextUsage()` returns `{ totalTokens, maxTokens, rawMaxTokens, percentage, categories[] }` where each
category carries `kind: 'used' | 'free' | 'buffer' | 'deferred'`. `totalTokens` is the current context in use (not a
cumulative counter), so it is exactly `usage().contextTokens`.

| turn | claude `totalTokens` / `maxTokens` | deepinfra `totalTokens` / `maxTokens` |
| :- | :- | :- |
| 1 | 15 486 / 1 000 000 (2 %) | 7 710 / 200 000 (4 %) |
| 2 | 20 708 / 1 000 000 (2 %) | 7 994 / 200 000 (4 %) |

`results/claude-usage.log`, `results/deepinfra-usage.log`; per-turn growth is also visible in
`results/*-events.log` (`context_usage_turn1` / `turn2`).

Baseline overhead worth knowing for §8's threshold: at session start, before any real work, `used` is already
**15 486** on Claude (system prompt 141 + system tools 9 490 + MCP instructions 2 008 + skills 2 310 + messages) and
**7 710–11 769** on DeepInfra (system tools 9 618 + skills 2 151 in the larger sample), with a **33 000-token
autocompact buffer** reserved on top. A purge threshold has to clear that floor, or it will purge every session on its
first turn. (The `categories[]` rows are useful for display but do not always sum cleanly against `totalTokens` —
treat `totalTokens` as the number and the categories as an explanation.)

### `detail: 'summary'` is not reliable for a trigger

Summary is cheap (no token-count calls) but on DeepInfra it disagreed with `full` by ~30 % and did not move between
turns in one run (`10270 → 10532` where full said `7710 → 7994`; and `11769 → 11769` in `deepinfra-events.log`).
On Claude the two agreed. **Use `detail: 'full'`**; treat `summary` as display-only.

### b) `modelUsage` on the result message — cumulative, per model

Every `result` carries `modelUsage: Record<modelId, { inputTokens, outputTokens, cacheReadInputTokens,
cacheCreationInputTokens, contextWindow, maxOutputTokens, canonicalModel?, provider?, costUSD, costBasis? }>` and
`total_cost_usd` (cumulative for the query). Useful for the build ledger (§11); **not** a context gauge, because its
token counts are cumulative across turns.

**Gap 1 — the context limit lies on DeepInfra.** For `deepseek-ai/DeepSeek-V4.1-Flash-1017` the CLI reports
`contextWindow`/`rawMaxTokens` = **200 000**, but DeepInfra's own model metadata says **1 048 576**
(`context_length: 1048576`, `results/deepinfra-context-window.txt`). The CLI is guessing the window of a model it does
not know. Trusting it would purge five times too early and throw away 80 % of a legitimate window. The `deepinfra`
adapter must take the limit from config, not from the SDK.

**Gap 2 — `costUSD` lies on DeepInfra.** `costBasis: 'unknown'` and the number is priced at Claude list rates
(its own docstring: "a guess at the default model's rate"). DeepInfra charges $0.20 / $0.60 per 1 M input / output —
so the SDK's cost number is wrong by an order of magnitude in the wrong direction. `costUsd` must be `undefined` for
`deepinfra`, or computed by the adapter from the tokens it can read.

---

## 2. `waiting_input` — is there a typed event when the model asks a question?

**Yes, but it arrives as a callback, not as a message in the event stream.**

When the model calls `AskUserQuestion`, the session blocks and the SDK calls the host's `canUseTool(toolName, input,
opts)`. The turn does not end: no `result` is emitted until the host answers.

```
claude    canUseTool({ toolName: 'AskUserQuestion', input: { questions: [ { question: 'Which deployment channel do
          you prefer?', header: 'Channel', options: [Blue, Green], multiSelect: false } ] } })   at 1 988 ms
deepinfra identical callback with the same input shape                                                   at 2 916 ms
```

`results/claude-question.log`, `results/deepinfra-question.log`. The host answers by returning
`{ behavior: 'allow', updatedInput: { ...input, answers: { [questionText]: chosenLabel } } }`; the model then
continues the same turn and cites the answer (`"You chose Blue"`).

Plain permission prompts take the same path for any tool (`toolName: 'Bash'`, input carries the command), so
"the peer is waiting on a human" is one signal, not two. `results/*-permission.log`.

**Gap 3 — `session_state_changed` exists in the type union but never fires here.** The SDK declares
`SDKSessionStateChangedMessage { state: 'idle' | 'running' | 'requires_action' }`, which would be the perfect
`status()` feed. It was emitted **zero times** in every probe on both providers. So "waiting" must be derived: a
pending `canUseTool` promise *is* `waiting_input`, a `result` message *is* turn end.

---

## 3. Events — turn start/end, tool use, errors, compaction

All of it, in one `AsyncIterable<SDKMessage>`. Observed types and subtypes:

| need | typed signal | seen |
| :- | :- | :- |
| session start / identity | `system/init` — `model`, `permissionMode`, `session_id`, `tools`, `capabilities[]`, `apiKeySource` | both |
| turn start | `assistant` message (`message.model`, content blocks), `SDKUserMessage` echo | both |
| tool use | `assistant` content block `tool_use` with name + input; result comes back as `user`/`tool_result` | both |
| turn end | `result` — `subtype: 'success' | 'error_during_execution'`, `num_turns`, `stop_reason`, `terminal_reason`, `permission_denials[]`, `usage`, `modelUsage`, `total_cost_usd` | both |
| model error | `result` with `is_error: true`, `subtype`, `api_error_status`; `assistant.error` union (`authentication_failed`, `rate_limit`, `model_not_found`, …) | both |
| compaction | `system/compact_boundary` — `{ trigger: 'manual'|'auto', pre_tokens, post_tokens, cumulative_dropped_tokens, duration_ms }`, preceded by `system/status { status: 'compacting' }` | both |
| background/tool progress | `system/task_started`, `system/task_notification`, `system/thinking_tokens` | both |
| commands/skills changed | `system/commands_changed` | claude only |

`results/*-events.log`, `results/*-compaction.log`.

Notes that matter for the adapter:

- **`system/init` is re-emitted at the start of every turn**, carrying the current model and permission mode. `model()`
  and the permission check should read the *latest* init, not the first.
- Compaction was forced with the local command `/compact` (a plain user message on the stream). Auto-compaction cannot
  be forced cheaply — the auto-compact window clamps to a **minimum of 100 000** tokens even when
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW=12000` is set in the child env (`results/*-compaction.log` records
  `maxTokens: 100000`). The event is the same; only `compact_metadata.trigger` differs.
- Claude runs carry `rate_limit_event` and a **second model in `modelUsage`** (`claude-haiku-5-5`, the small/fast
  sidecar for internal calls). `model()` must therefore read `init.model` or the assistant message's model — never the
  first key of `modelUsage`. DeepInfra sessions have exactly one model.

---

## 4. `resume()` — by id, after the process exits, context intact

**Yes, on the same machine.** Process A runs a turn, exits; process B calls `query({ resume: <session_id> })`.

| | claude | deepinfra |
| :- | :- | :- |
| session id round-trips | yes, `init.session_id` identical | yes |
| secret planted in turn 1, asked in process B | `PURPLE-OTTER-4417` ✓ | `PURPLE-OTTER-4417` ✓ |
| transcript/replay | `SDKUserMessageReplay` for prior turns | same |

`results/*-resume-write.log`, `results/*-resume-read.log`.

Caveat for §16's restart risk: the transcript lives under `~/.claude/projects/<cwd-slug>/` (the SDK's `SessionStore`
is in-memory for the SDK process, not a portable export). A session is resumable **on the host that wrote it**;
moving a fleet to another machine means new sessions, not resumed ones. `forkSession: true` exists if the fleet ever
wants to branch rather than continue.

---

## 5. Interrupt mid-turn, and permission mode per session

### Interrupt

`Query.interrupt()` works mid-turn and returns a receipt (`{ still_queued: [] }` with this CLI).

```
5 009 ms  interrupt()          → { still_queued: [] }
5 019 ms  user                 (interrupted tool result)
5 021 ms  result               subtype: 'error_during_execution', is_error: true,
                               terminal_reason: 'aborted_tools', stop_reason: 'tool_use'
```

`results/*-interrupt.log`. Two things the adapter must handle:

- The aborted turn ends with **`is_error: true`**. `terminal_reason: 'aborted_tools'` is what distinguishes a
  user interrupt from a real failure — do not map `is_error` straight to `peer.failed` (§6.1 notifications).
- **The `AsyncIterable` does not finish on interrupt.** It waits for the next user message, which is correct for a
  provider (`send()` must still work afterwards) but means the adapter's `interrupt()` must not await iterator
  completion. The probe had to close the input stream and abort to end the iteration.

### Permission mode

- Mode is set at start with `permissionMode` in `options`.
- **`init.permissionMode` does not reliably echo what was asked for.** A session launched with
  `permissionMode: 'default'` reported `init.permissionMode = 'acceptEdits'` on both providers — the same value the
  probe saw on the re-emitted inits of sessions that had genuinely switched. So the field is a report of the CLI's
  internal state, not a confirmation of the request: §4's "confirm the session came up in the mode we asked for" has to
  be checked behaviourally (does a write reach `canUseTool`?), not by comparing strings.
- `bypassPermissions` requires `allowDangerouslySkipPermissions: true` **at launch**. Setting it later fails:
  `setPermissionMode('bypassPermissions')` → `Error: Cannot set permission mode to bypassPermissions because the
  session was not launched with --dangerously-skip-permissions`. Switching to `acceptEdits` mid-session succeeded, and
  the re-emitted init reported the new mode.
- In `default` mode a write goes through `canUseTool` and a `deny` reaches the model as a normal `tool_result` (and is
  listed in `result.permission_denials`). In a bypass session `canUseTool` is never called and the tool just runs.

`results/*-permission.log`. Consequence for §4: **a session that must be able to switch into bypass has to be launched
with the bypass flag**, so `SessionSpec.permissionMode` is mostly a start-time decision. The supervisor's
"wrong mode → stop and restart" rule (§4) is therefore the normal path, not an edge case.

---

## 6. `model()` — the actual model and endpoint, not a UI string

**Model: yes. Endpoint: no — it must come from the adapter's own `SessionSpec.env`.**

From the latest `system/init` and from `modelUsage`:

```
claude     init.model = claude-sonnet-5-5        modelUsage: claude-sonnet-5-5 {canonicalModel, provider: 'firstParty', contextWindow: 1000000, costBasis: 'list'}
                                                + claude-haiku-5-5 (internal sidecar)
deepinfra  init.model = deepseek-ai/DeepSeek-V4.1-Flash-1017
                                                modelUsage: same id {canonicalModel: deepseek-ai/deepseek-v4.1-flash-1017,
                                                provider: 'firstParty' ← WRONG, costWindow: 200000 ← WRONG, costBasis: 'unknown'}
```

`results/*-model.log`.

- `init.model` echoes what was requested, and it changed correctly when `setModel()` was called (see below).
- **`provider` is a lie for DeepInfra** (`'firstParty'`) and `contextWindow` is the model table's guess. So
  `model().endpoint` cannot be read from the SDK at all: it is whatever the adapter put in `SessionSpec.env`
  (`ANTHROPIC_BASE_URL`). That is still a real read — from the spawned process's config — not a UI string, which is
  what §4 asks for — but the adapter owns it.

`capabilities.modelSwitch` is real: `setModel('claude-haiku-4-5-20251001')` mid-session switched the next turn on
Claude (confirmed by the assistant message and by `modelUsage` gaining a third entry), and on DeepInfra
`setModel('deepseek-ai/DeepSeek-V3.2')` switched the endpoint's model. On DeepInfra the id must be one the endpoint
accepts — the CLI passed `anthropic/claude-sonnet-5-5` straight through, so the adapter should validate ids itself.
`results/*-switch.log`.

---

## 7. Fallback: what does the CLI's `--output-format stream-json` give that the SDK does not?

**Nothing that the fleet needs.** The SDK *is* the CLI — it spawns it with `--output-format stream-json` and adds a
control channel on top. The raw CLI run (`results/cli-stream-json.log`) produces the same `system/init`, `assistant`,
`user` and `result` frames with the same `usage` / `modelUsage` / `session_id` fields.

What the SDK adds, and the CLI surface cannot do:

| capability | SDK | bare CLI `-p --output-format stream-json` |
| :- | :- | :- |
| ask the host for permission | `canUseTool` control request | `--permission-prompt-tool` (an MCP tool you must host) or auto-deny |
| context usage on demand | `getContextUsage()` | `/context` shows it in the TUI only; not in stream-json |
| interrupt with a receipt | `interrupt()` → `{ still_queued }` | SIGINT to the process |
| change model/mode mid-session | `setModel()`, `setPermissionMode()` | new process |
| structured output | `outputFormat: { type: 'json_schema', schema }` → `result.structured_output` | same flag, but you parse stdout |
| suppress user settings/hooks | `settingSources: []` | loads user settings (the raw run fired 13 hook frames from my own settings) |
| multi-turn on one process | streaming input queue | one process per `-p` run, or `--input-format stream-json` (which is the same protocol, unwrapped) |

So the fallback is not a capability upgrade; it is only a smaller dependency surface. If the SDK had a blocking bug,
the fleet could fall back to raw stream-json at the cost of hosting the permission channel itself — but the event
model, usage numbers and resume would be identical.

---

## Capability matrix

| `Provider` need | `claude` | `deepinfra` | evidence |
| :- | :-: | :-: | :- |
| `usage().contextTokens` | ✅ `getContextUsage({detail:'full'}).totalTokens` | ✅ same | `*-usage.log` |
| `usage().contextLimit` | ✅ `rawMaxTokens` (1 000 000) | ⚠️ reports 200 000; real 1 048 576 → **take from config** | `deepinfra-context-window.txt` |
| `usage().costUsd` | ✅ (`costBasis: 'list'`, a real estimate) | ❌ Claude-priced guess → **omit** | `*-usage.log` |
| `capabilities.usageTokens` | true | true (tokens yes; limit/cost from config) | |
| `waiting_input` | ✅ `canUseTool('AskUserQuestion')` blocks the turn | ✅ identical | `*-question.log` |
| permission prompts as events | ✅ `canUseTool` any tool | ✅ identical | `*-permission.log` |
| turn started / ended | ✅ `init` + re-emitted init / `result` | ✅ identical | `*-events.log` |
| tool use events | ✅ `tool_use` / `tool_result` blocks | ✅ identical | `*-events.log` |
| error events | ✅ `result.is_error` + `terminal_reason` + `assistant.error` | ✅ identical | `*-interrupt.log` |
| compaction events | ✅ `system/compact_boundary` w/ pre/post tokens | ✅ identical | `*-compaction.log` |
| `status()` | ⚠️ no query; derive from pending `canUseTool` / `result` / iterator state | ⚠️ identical | `session_state_changed` never fired |
| `resume()` by id, process exited | ✅ | ✅ | `*-resume-*.log` |
| `interrupt()` mid-turn | ✅ with receipt; iterator stays open | ✅ identical | `*-interrupt.log` |
| `capabilities.permissionModes` | `default`, `acceptEdits`, `plan`, `bypassPermissions`\* | same\* | `*-permission.log` |
| `capabilities.modelSwitch` | ✅ `setModel()` mid-session | ✅ (endpoint-valid ids only) | `*-switch.log` |
| `capabilities.structuredOutput` | ✅ `outputFormat.json_schema` → `result.structured_output` | ✅ identical | `*-structured.log` |
| `model()` | ✅ `init.model`, canonical id from `modelUsage` | ✅ model id; **endpoint only from `SessionSpec.env`** | `*-model.log` |

\* `bypassPermissions` only for a process launched with `allowDangerouslySkipPermissions`; others switchable at runtime.

### Proposed `capabilities` for both

```ts
const capabilities = {
  resume: true,
  modelSwitch: true,
  usageTokens: true,
  structuredOutput: true,
  permissionModes: ['default', 'acceptEdits', 'plan', 'bypassPermissions'],
} as const
```

Identical for `claude` and `deepinfra`, because they are the same implementation with a different `env`.

---

## Gaps, and what the contracts would need

These are **proposals for the architect** [§4 owner] — not changed here. `engineer-1` writes them if approved.

1. **`usage()` conflates three things that fail independently.** Context tokens are faithful on both providers;
   the limit and the cost are only faithful for Anthropic-hosted models. Suggest either
   `usage(): { contextTokens: number; contextLimit: number; costUsd?: number }` with the adapter *required* to fill
   `contextLimit` from config when `capabilities.usageTokens` is true, or an explicit
   `capabilities.usageCost: boolean` / `contextLimitSource: 'sdk' | 'config'`. Without this, `deepinfra` self-purges
   at 200 k against a 1 M window and the ledger records fictional dollars.
2. **`waiting_input` is a callback, not an event.** §4 says "a provider event". In the SDK it is a promise the host
   must resolve; the adapter should surface it as a `question.asked` event *and* keep the promise pending until the
   decision inbox answers it. The shape `ProviderEvent` needs a variant carrying `{ questions[], resolve(answer) }` —
   the adapter owns the promise, the inbox owns the answer.
3. **`interrupt()` needs a reason on the resulting turn end.** The SDK's aborted turn is `is_error: true` with
   `terminal_reason: 'aborted_tools'`. The `TurnEnded` event should carry `reason: 'completed' | 'interrupted' |
   'failed'` so the PM does not open a `peer.failed` notification for a deliberate interrupt (§6.1).
4. **`model()` needs the endpoint from config.** For `deepinfra` the SDK cannot report it (it says `firstParty`).
   `model(): { id, endpoint? }` is fine, but the adapter must be the source of `endpoint`, and the supervisor must
   compare it against `SessionSpec.env` to catch a session that came up on the wrong endpoint — the same rule §4
   already applies to permission mode.

Everything else in §4 maps onto the SDK directly.

## Operational notes (not contract changes)

- **`options.env` replaces the child environment; it does not merge.** This is the sharpest footgun found. A script
  that forwarded `{...process.env}` while asking for `claude` silently ran DeepSeek: the parent session's
  `ANTHROPIC_BASE_URL` leaked in and the turn *succeeded*, with `init.model` and `modelUsage` both naming
  `deepseek-ai/DeepSeek-V4.1-Flash-1017` — nothing in the message stream marks the session as the wrong provider
  (`results/claude-env-inheritance.log`). The adapter must build the child env from scratch and strip every inherited
  `ANTHROPIC_*` / `CLAUDE_CODE_*` variable — which is also what makes §4's "no shared tmux server seeds env, so there is
  no drift" true. This is a strong argument for §4's post-start check: compare `model()` against the `SessionSpec`
  after `start()`, because a mis-seeded provider looks completely healthy.
- **Sessions must be created with streaming input** (`prompt: AsyncIterable<SDKUserMessage>`), not `prompt: string`.
  With a string the `Query` closes as soon as the turn ends, and `getContextUsage()`, `setModel()` and
  `setPermissionMode()` then fail with `Query closed before response received`. Streaming input is also what makes a
  session long-lived and `send()` a queue.
- **One CLI subprocess per session.** That is the fleet's unit of cost and of failure; a crashed `fleetd` leaves
  orphans to reap.
- **`settingSources: []` is worth keeping** for peer sessions: it stops user/project hooks and plugins from shaping a
  peer's behaviour. The raw CLI run fired 13 hook frames from unrelated settings.
- The SDK emits a lot of optional messages (`rate_limit_event`, `thinking_tokens`, `commands_changed`,
  `background_tasks_changed`, `task_started`, …). The adapter should whitelist the ones it maps and ignore the rest.

---

## Evidence index

| file | what it holds |
| :- | :- |
| `results/{claude,deepinfra}-evidence.jsonl` | one JSON line per probe, the authoritative captured data |
| `results/{claude,deepinfra}-events.log` | full message sequence, turn boundaries, context usage per turn |
| `results/{claude,deepinfra}-usage.log` | `getContextUsage` full vs summary, `modelUsage`, cost |
| `results/{claude,deepinfra}-question.log` | `canUseTool('AskUserQuestion')` with the questions input |
| `results/{claude,deepinfra}-permission.log` | default-mode deny, `setPermissionMode` results, bypass session |
| `results/{claude,deepinfra}-interrupt.log` | interrupt receipt, aborted turn end, iterator behaviour |
| `results/{claude,deepinfra}-compaction.log` | `compact_boundary` with pre/post tokens, `status: compacting` |
| `results/{claude,deepinfra}-switch.log`, `deepinfra-switch-v32.log` | `setModel` mid-session |
| `results/{claude,deepinfra}-structured.log` | `outputFormat: json_schema` → `result.structured_output` |
| `results/{claude,deepinfra}-resume-{write,read}.log` | resume by id across two processes, context intact |
| `results/claude-env-inheritance.log` | the env-leak reproduction |
| `results/cli-stream-json.log` | condensed raw CLI run (fallback comparison) |
| `results/deepinfra-context-window.txt` | DeepInfra's own model metadata: 1 048 576-token window, $0.20/$0.60 per 1M |
