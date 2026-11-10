# CI

What runs on every change, what blocks a merge, and how to get out of it when a check is wrong. Two workflows:
[`ci.yml`](../../.github/workflows/ci.yml) and [`security.yml`](../../.github/workflows/security.yml).

Nothing here is hosted beyond GitHub Actions, and no secret lives in the repo: every pin is a version, every scanner is
a public release, and the only credential is the workflow's own `GITHUB_TOKEN`.

## What runs

| workflow | job | runs on | ~time | required on main |
| :- | :- | :- | -: | :- |
| `CI` | `checks` | every PR, every push to main | 1 min | **yes** |
| `CI` | `legacy-v1` | every PR, every push to main | 4 min | no (advisory) |
| `Security` | `security` | every PR, every push to main, nightly 05:17 UTC | 2 min | no (advisory, see below) |

### `checks` — the gate

`pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, from a clean checkout, on the Node in `.node-version`
(22.18.0 — the floor `package.json`'s `engines` promises) with the pnpm in `package.json`'s `packageManager` and the
pnpm store cached. It ends with a step that fails if the working tree is dirty afterwards: a test that writes into the
checkout would pass here and surprise the next person.

`pnpm test` is `node --test` over every package's `test/` **and** `tests/`, so `tests/architecture` — the §1.1 import
rules — is part of this job. A sideways import fails the merge, not just a review.

This is the whole reason the job is required: typecheck, the unit and cross-package tests, and the dependency rules are
mechanical, and a person reviewing a diff is a poor substitute for them.

### `legacy-v1` — v1, still the live fleet

`task lint` (shellcheck every script, skill frontmatter, profiles restate no `AGENTS.md` fact) and the v1 smoke suite via
`task -t legacy/v1/Taskfile.yaml test`. `legacy/v1/` is frozen but running (§1.1), so the rule for it is: no change
without its own suite green.

**Quarantined: `resume.sh`.** The job runs the smoke suite with `FLEET_SMOKE_SKIP_RESUME=1`, which skips
`dev-tasks/scripts/test/resume.sh` and prints a line saying so
([#28](https://github.com/mohammadchehab/tmux-fleet/issues/28): a timing race in fleet-scale add flaked 5 of 10 runs).
A local `task test` still runs it — a flake a developer sees beats a flake CI hides. It comes back when #28 is fixed;
re-enabling it on a green run is not a fix, because the pass would be a rerun of a race.

shellcheck is pinned to 0.11.0 rather than the runner's own copy: its rule set moves between releases, and a lint that is
green locally and red in CI (or the reverse) teaches people to skip it.

### `security` — §6.2, by mechanism

| tool | scans | on |
| :- | :- | :- |
| [semgrep](https://semgrep.dev) `p/typescript`, `p/javascript`, `p/nodejs` | SAST over `packages/ apps/ tests/` | PR + main + nightly |
| [gitleaks](https://github.com/gitleaks/gitleaks) | secrets: the PR's commits, or the whole history on main/nightly | PR + main + nightly |
| [osv-scanner](https://github.com/google/osv-scanner) | `pnpm-lock.yaml` against the OSV database | PR + main + nightly |

Trivy is absent until there is a `Dockerfile`, `infra/` or `deploy/` to scan; `claude-security` (model-driven review) is
phase 2 and belongs on nightly and path-flagged PRs, not every PR. Both are §6.2's call, not an omission.

Each tool writes SARIF, every SARIF is uploaded to **Security → Code scanning** with its own category, and one script
decides pass/fail: [`.github/scripts/severity-gate.mjs`](../../.github/scripts/severity-gate.mjs).

## The severity floor: MEDIUM and above fails

The gate fails the job on any finding at or above **MEDIUM**. Per tool:

| tool | severity comes from | at the floor |
| :- | :- | :- |
| gitleaks | a match is a secret in a commit: always **critical** (§6.2: "a secret in a pushed branch") | any match fails |
| semgrep | the rule: `ERROR` → high, `WARNING` → medium, `INFO` → low | `ERROR` and `WARNING` fail |
| osv-scanner | the advisory's CVSS score: ≥ 9 critical, ≥ 7 high, ≥ 4 medium | scores ≥ 4.0 fail |

Why MEDIUM: LOW/INFO findings in this codebase are overwhelmingly style-adjacent (a rule that fires on a shape, not a
reachable path), and a check that fails on them gets bypassed within a week — which takes the real findings with it.
MEDIUM is the lowest bar whose findings can all plausibly be *fixed* rather than argued about. The floor is one
argument (`--floor`), and raising it is a reviewable diff.

A scanner that produces no report fails the job: a check that did not run must never look like a check that passed.

### When the gate is wrong

Fix a real finding. Suppress a false positive **at the tool**, so the suppression is a reviewable line in the repo and
the reason lives next to it:

| tool | mechanism |
| :- | :- |
| gitleaks | `.gitleaksignore` — one fingerprint per line (`<commit>:<path>:<rule>:<line>`), a comment above it saying why |
| semgrep | `# nosemgrep: <rule-id>` on the line, with a reason |
| osv-scanner | an `osv-scanner.toml` `[[IgnoredVulns]]` entry, with a reason |

Dismissing an alert in code scanning hides it from the list but does **not** make the gate pass — the next run reads the
report again. Two places that disagree about what is acceptable is worse than one that is strict.

## Merging

Branch protection on `main` requires `checks` and an up-to-date branch, and does **not** enforce the rules for
administrators — so the way we merge today keeps working:

```sh
gh pr merge --squash --admin
```

`--admin` still bypasses required checks and the up-to-date requirement. That is deliberate: one maintained account is
a smaller surface than a protection rule that a queue of stacked PRs will teach people to route around. A non-admin
merge, and the GitHub UI, enforce both.

`legacy-v1` and `security` are advisory: they run on every PR, their result is on the PR, and they do not block the
merge. They are not required because both depend on the network and a third party's availability (several tool
downloads, the OSV database, the semgrep registry) — a required check that can fail because a CDN was slow is a check
people learn to bypass. If either proves reliable over a few dozen runs, promote it:

```sh
gh api -X PATCH repos/mohammadchehab/tmux-fleet/branches/main/protection/required_status_checks \
  -f 'checks[][context]=checks' -f 'checks[][context]=security' -F strict=true
```

## Not wired yet: evals

§17 puts evals in phase 2, path-gated on the roles, the Judge prompts and question schemas, the model/limits config and
the `StateFile` schema. `ci.yml` carries a commented-out job where that lands; it is a placeholder, not a TODO someone
should pick up before the Judge is real.
