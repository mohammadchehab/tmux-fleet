---
name: fleet-triage
description: "Works in Claude Code (SendMessage to the architect) and Cursor (paste the brief into the architect chat). Use when the user reports a bug, broken screen, error, or \"why does X behave like Y\" in the fleet — routes it to the architect for root cause and classification (design bug vs implementation bug vs data/config vs environment). The PM never diagnoses or classifies. Alias: rca."
---

# Triage / RCA

The project-manager **does not diagnose, classify, or propose fixes**. The architect owns root cause and classification. The PM relays, assigns, and tracks.

## 1. Send to the architect (immediately, no PM analysis)

SendMessage to `architect`, with `notify_when_idle: true`. Include only facts from the user:

```
TRIAGE <short title> — from the user.
Report (verbatim): "<user's words>"
Where: <app/screen/URL as the user gave it; "unknown" if not given>
Env: <local / dev / a shared environment; "unknown" if not given>
Evidence: <screenshot path, error text, time>
Return to the project-manager:
1. Root cause (file:line), and whether it's confirmed (repro or live check) or only from code
2. CLASS: DESIGN BUG | IMPLEMENTATION BUG | DATA/CONFIG | ENVIRONMENT | NOT A BUG
3. Scope: which repos/apps are affected
4. Fix: the PR split and size, the owner role (engineer / designer), and whether security-architect must review
```

If the architect needs a live check, the architect asks dev-support for a local run. Don't add your own hypotheses, suspects, or design ideas to the message.

## 2. Tell the user (one line)

`Sent to the architect for triage: <title>.` Nothing more. No guesses about the cause.

## 3. When the architect's verdict arrives

Relay to the user in plain words: the class, the cause, and who fixes it. Then route by class:

| Class | Route |
|---|---|
| DESIGN BUG | Architect updates the spec/ADR first (PR to pr-architect), then an engineer builds against it |
| IMPLEMENTATION BUG | Assign to a free engineer with the architect's fix plan verbatim; PR to pr-architect |
| DATA/CONFIG | dev-support applies it locally (the local stack); the change itself is a PR so it can't regress |
| ENVIRONMENT | dev-support for a local environment; a shared one is the user's (no agent touches it) |
| NOT A BUG | Relay the architect's explanation to the user; ask if they want a change (→ treat as new scope) |

Security-relevant fixes (auth, tokens, guards, exposure, realm): security-architect reviews the approach before an engineer starts.

## 4. Track

Add a row to `$FLEET_STATE/fleet-context.md` under **Triage**: `| <title> | <class> | <owner> | <PR#> | <state> |`.

## Never

- Classify, diagnose, or suggest a design yourself, even when it seems obvious.
- Ask the user clarifying questions before sending. Send with "unknown" and let the architect ask.
- Assign a fix before the architect's verdict.
