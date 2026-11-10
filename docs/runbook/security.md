# Security scanning

§6.2 of [the design](../design/fleet-v2-architecture.md) is the spec; this is how to turn it on, what each tool
answers, and what the record means when a scan does not happen.

Three packages: `packages/security/findings` (the fingerprint and the planner — a pure function from scan outcomes to
events), `packages/security/scanners` (one adapter per tool, each owning its argv and its parse), and
`apps/daemon/src/security.ts` (the routine body: which checkout, which tools). The daemon is the only place the two
halves meet (§1.1).

## Turning it on

The profile names the scanners:

```yaml
# ~/.config/fleet/profiles/<profile>.yaml
security:
  scanners:
    - semgrep
    - gitleaks
    - osv-scanner
```

The block's presence is what installs the `security-scan` routine. A profile without it scans nothing and installs
nothing — scanning is three subprocesses per PR, and a fleet that did not ask for it must not look like it is doing it.
An empty list is refused at load: it would install the routine and then scan nothing, which reads as coverage the fleet
does not have.

The routine runs on `pr.opened` (§6.2's every-PR rule), against the head SHA, in the worktree the fleet already made for
that repository (§9) — never in the daemon's own working directory, which is a different tree on every host.

**The nightly scan is not wired yet.** §6.2 also asks for a 02:00 scan of main's head, and the fleet has no source for
that SHA (there is no `workspace`/git package to ask, and neither the `Worktree` nor the `PullRequest` projection
carries a base commit). A scheduled tick therefore returns zero actions instead of scanning a guess. The 02:00 trigger
is still configured in `packages/orchestration/routines/src/config.ts`; what it does today is nothing.

## What each tool answers

| id | binary | what it finds | severity |
| :- | :- | :- | :- |
| `semgrep` | `semgrep` | SAST: injection, unsafe deserialization, framework-specific sinks. Registry rules `p/typescript` and `p/javascript` | its own `error`/`warning`/`info` → high/medium/info |
| `gitleaks` | `gitleaks` | committed secrets, in the diff and in the history | always `high` (gitleaks reports no severity) |
| `osv-scanner` | `osv-scanner` | known CVEs in `pnpm-lock.yaml` | CVSS word, `moderate` → medium |
| `trivy` | `trivy` | filesystem vulns and misconfigurations. Not in the default set: it is slow and its overlap with osv-scanner is large | `unknown` → info |

Each adapter mirrors the invocation `.github/workflows/security.yml` already proves daily, including the exit-code
convention (osv-scanner exits 1 when it finds something; gitleaks is given `--exit-code 0`), because whether a finding
blocks is the fleet's decision, not each tool's own.

Two behaviours worth knowing:

- **A secret is never carried.** gitleaks reports both the `Secret` and the matching line; the finding keeps the rule,
  the path and gitleaks' description instead. An event log is the last place a leaked credential should live.
- **A tool that needs a file gets a temp path.** gitleaks only writes a report to `--report-path`, so the daemon names
  one in the OS temp directory — a scan must not dirty the tree it is judging, and two scanners running at once must
  not read each other's report.

## What a skip means

Every run records what it did, including what it could not do. §6.2 has no `scan.failed` event, so a failed scan is
recorded as `scan.skipped` with a reason beginning `failed:`, and counted in the routine run's `actionsFailed` so it
shows in `fleet ls` instead of looking idle:

| `scan.skipped` | what happened | `actionsFailed` |
| :- | :- | :- |
| `semgrep is not installed` | `which` did not find the binary. A real absence, recorded, not a failure | no |
| `failed: <tool> exited 2: …` | the tool ran and broke | yes |
| `failed: <tool> printed no report` | it exited cleanly and said nothing — a broken invocation, never an empty scan | yes |
| `tool: security-scan`, `no checkout for <repo> at <sha>` | the fleet has no worktree for that repository, so nothing was scanned at all | yes |

A missing checkout is the one to act on: it means the PR is not being scanned and the repair is a worktree (§9), not a
tool install.

## Fingerprints

A finding's identity is `hash(ruleId + path + normalized snippet)`: the same problem moved down ten lines is the same
finding, and re-indenting it does not launder it. A fingerprint already in the projection becomes `finding.seen`
(keeping the id it was raised under, incrementing its count) rather than a second `finding.raised`. A different path is
a different finding — copying a vulnerable file does not inherit the original's history.

## Where the code is

| file | what |
| :- | :- |
| `packages/security/findings/src/fingerprint.ts` | `hash(ruleId + path + normalized snippet)`, and the derived id |
| `packages/security/findings/src/plan.ts` | scan outcomes → `finding.raised` / `finding.seen` / `scan.skipped`, deterministically ordered |
| `packages/security/scanners/src/report.ts` | `runTool`: the four outcomes (ok, skipped, failed, unparseable) and the report readers |
| `packages/security/scanners/src/*.ts` | one adapter per tool: `semgrep`, `gitleaks`, `osv`, `trivy` |
| `packages/security/scanners/src/exec.ts` | the injected `exec`/`which`, so no test spawns anything |
| `apps/daemon/src/security.ts` | the routine body: the checkout, the tool set, the skip when there is no checkout |
| `apps/daemon/src/compose.ts` | where the factory is handed to the scheduler, and nowhere else (§1.1) |
