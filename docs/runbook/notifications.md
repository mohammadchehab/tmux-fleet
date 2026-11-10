# Notifications

§6.1 of [the design](../design/fleet-v2-architecture.md) is the spec; this is how to turn it on and what to expect
when it rings.

Two packages: `packages/notify/core` (the rules — when a thing notifies, how often, and the `Notifier` port) and
`packages/notify/channels/macos` (the desktop banner). The rules are a pure function of the notification rows and the
clock, so the same rows always produce the same banners.

## Turning it on

The profile chooses the channel:

```yaml
# ~/.config/fleet/profiles/<profile>.yaml
notify:
  channel: macos
```

`none` keeps the `notifications` ledger — `fleet ls` and `fleet decide` still show everything — and sends nothing. The
ledger is the source of truth either way: a missed banner loses nothing. A profile with no `notify` block at all is the
same as `none`: the daemon installs no `notify` routine, so a heartbeat costs nothing. `macos` on a host that is not a
Mac is logged once at start-up and treated as `none` rather than turned into a `notify.failed` on every tick.

The routine runs on a 5-minute heartbeat and is woken by `decision.requested`, `peer.failed`, `ci.failed_final`,
`provider.errored` and `standup.rendered` (`packages/orchestration/routines/src/config.ts`).

The macOS channel wants `terminal-notifier` (`brew install terminal-notifier`). Without it, banners still arrive
through `osascript display notification`, but they cannot be clicked and cannot be taken down early — see below.

## What notifies

| class | what |
| :- | :- |
| `decision` | something is blocked on you: a scope call, an approval, a judge question that escalated. Clicking the banner opens a terminal running `fleet decide <id>` |
| `failure` | a peer crash, a session that will not resume, CI red after retries, a provider/auth/budget error |
| `standup` | the daily summary, once |

**Never notified:** a PR ready to merge (the gate acts on it), peer idle, routine runs, purges.

## How often

- **One banner per key.** Keys are `decision:<id>`, `failure:<subject>:<kind>`, `standup:<date>`.
- **Failures are rate limited.** A failing key is shown once, then silent until it resolves or 6 hours pass; the repeat
  says how many events have piled up ("still failing, 4 events"). A retry loop never becomes a banner loop.
- **One reminder per open decision**, after 8 hours, and only while it is still open. Then nothing.
- **Resolution takes the banner down.** Answering a decision, or the failure recovering, withdraws it — once. With
  `terminal-notifier` the banner leaves Notification Center; with `osascript` it stays until macOS clears it, because
  `display notification` posts no group to remove.

The windows are `NotifyPolicy` (`packages/notify/core/src/policy.ts`): 6 h and 8 h by default.

## When a banner does not arrive

Delivery failure is an event (`notify.failed`) with the channel and the error, so it is never silent. The decision is
still pending in the ledger and the next `notify` tick tries again: nothing was recorded as sent, so there is nothing
to dedupe against. A run of `notify.failed` for one key means the channel is broken, not that the fleet forgot.

## Where the code is

| file | what |
| :- | :- |
| `packages/notify/core/src/plan.ts` | the four rules, pure: rows + clock → banners and withdraws |
| `packages/notify/core/src/deliver.ts` | the plan → `notify.sent` / `notify.failed` / `notify.withdrawn`, one atomic batch |
| `packages/notify/core/src/notifier.ts` | the `Notifier` port a channel implements |
| `packages/notify/channels/macos/src/macos.ts` | `terminal-notifier` or `osascript`, behind an injected `execFile` |
| `apps/daemon/src/routines/notify.ts` | the `notify` routine body the daemon registers, and the channel a profile picks |
| `apps/daemon/src/wiring/compose.ts` | where the factory is handed to the scheduler, and nowhere else (§1.1) |
