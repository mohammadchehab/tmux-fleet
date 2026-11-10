# CI

What runs on every change, what blocks a merge, and how to get out of it when a check is wrong. Two workflows:
[`ci.yml`](../../.github/workflows/ci.yml) and [`security.yml`](../../.github/workflows/security.yml).

Nothing here is hosted beyond GitHub Actions, and no secret lives in the repo: every pin is a version, every scanner is
a public release, and the only credential is the workflow's own `GITHUB_TOKEN`.

## What runs

| workflow | job | runs on | ~time | required on main |
| :- | :- | :- | -: | :- |
| `CI` | `checks` | every PR, every push to main | 1 min | **yes** |
| `CI` | `stale-squash` | every PR | 5 s | **yes** |
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

There was a second job, `legacy-v1`, that ran shellcheck and v1's smoke suite. It went with `legacy/v1/` when that tree
was deleted, along with the `resume.sh` quarantine it carried ([#28](https://github.com/mohammadchehab/tmux-fleet/issues/28),
closed as obsolete with it).

### `stale-squash` — a green PR that would revert main

[#179](https://github.com/mohammadchehab/tmux-fleet/pull/179) was squash-merged from a branch that predated seven merged
PRs. A squash applies the diff between the branch's merge-base and its head, so the merge deleted everything those seven
had added to the files it touched — their tests included, which is why the run stayed green: the reverted tests went with
the reverted code, and `main` was red afterwards. [#187](https://github.com/mohammadchehab/tmux-fleet/pull/187) is the
restore.

The job runs [`stale-squash-guard.ts`](../../.github/scripts/stale-squash-guard.ts) on the PR's **head**, not on GitHub's
merge commit — the merge contains `main`, so nothing would ever look deleted. It takes the lines `main` gained after the
PR's merge-base, keeps the files the PR touches (only those hunks are applied, so a file with no hunk cannot be
reverted), and fails if the head no longer has any of them. Each finding is one annotation per file and commit that added
the lines, with a few example lines: no similarity score, no model, either the line is there or it is not.

A revert is a legitimate thing to want. A line of its own in the PR body declares it — `Revert: #180`, GitHub's own
`Reverts owner/repo#180`, or `This reverts commit <sha>` — and the check passes, writes the declaration and everything it
drops into the log, and lets a reviewer see the decision. Prose that contains the word does not count: #179's own body
said "Nothing in #166 is reverted".

When it fails, it is usually right. Rebase onto `main` and re-run; the PR diff then says what it actually changes. If it
fired on a PR that genuinely means to delete those lines, declare the revert.

The guard is only as good as its history: it compares `HEAD` with a fetched `origin/main`, so it runs on the head's full
history (`fetch-depth: 0`) plus an explicit `git fetch` of `main`. If those refs are missing the check exits 2 — an error,
never a pass.

### `security` — §6.2, by mechanism

| tool | scans | on |
| :- | :- | :- |
| [semgrep](https://semgrep.dev) `p/typescript`, `p/javascript`, `p/nodejs` | SAST over `packages/ apps/ tests/` | PR + main + nightly |
| [gitleaks](https://github.com/gitleaks/gitleaks) | secrets: the whole history, on every event | PR + main + nightly |
| [osv-scanner](https://github.com/google/osv-scanner) | `pnpm-lock.yaml` against the OSV database | PR + main + nightly |

A PR scans the same ranges as `main`, history included, so a green PR is evidence of a green `main`. It used to scan
`base..head` only, and that is blind to the change that matters: #103 deleted a spike directory and the `.gitleaksignore`
entry for a secret in it, the PR was green because the diff touched no commit holding the secret, and `main` went red on
the next push (#104). The full scan takes about a second.

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

A gitleaks fingerprint is a claim about a **commit**, not about the working tree: `<commit>:<path>:<rule>:<line>` names a
point in history that cannot be edited away. Deleting the path it names does **not** retire it — the commit is still in
the history the next scan reads, so the finding comes straight back and the entry has to stay. That is what #103 did to
the spike's `probe.mjs` and #104 undid.

Dismissing an alert in code scanning hides it from the list but does **not** make the gate pass — the next run reads the
report again. Two places that disagree about what is acceptable is worse than one that is strict.

### When the finding is a transitive dependency

Sometimes the vulnerable package is not one we chose and no version inside the dependent's own range is patched — the
dependent has to move, and it hasn't. `pnpm.overrides` in the root `package.json` is the fix then: it is a real fix, not
a suppression, so nothing is hidden from the next run.

The cost is that it moves a dependency across a major the dependent did not choose, so the PR that adds one runs the
thing that depends on it and says what it saw. Today's set:

| override | why |
| :- | :- |
| `glob@^13` → 14, `minimatch@^10` → 11, `basic-ftp@^5` → 6 | promptfoo 0.125.1 (dev-only, in `packages/evals`) declares `glob@^13`, `minimatch@^10` and pulls `basic-ftp@5` through `get-uri`; every patched version is a major it does not allow yet. Verified by running `promptfoo eval` over the judge suite after the bump. |

## Merging

Branch protection on `main` requires `checks` and `stale-squash`, does **not** require an up-to-date branch, requires no
reviews, and does not enforce the rules for administrators — so the way we merge today keeps working:

```sh
gh pr merge --squash --admin
```

`--admin` still bypasses the required check. That is deliberate: one maintained account is a smaller surface than a
protection rule that a queue of stacked PRs will teach people to route around. A non-admin merge, and the GitHub UI,
enforce it.

Squash is the only merge method the repo allows, and auto-merge is on, so a PR can be queued the moment it is opened:

```sh
gh pr merge --auto --squash
```

It merges when the required checks go green and not before — that is the whole point of arming it early. Up-to-date is off on
purpose: with a branch that must be current, every merge knocks every other open PR out of date and a queue of them
stalls on rebase rounds. The trade is that two PRs touching the same lines can each be green alone and still conflict
after the first lands; the second's own run catches it, and its merge is what fails.

`security` is advisory: it runs on every PR, its result is on the PR, and it does not block the
merge. It is not required because it depends on the network and a third party's availability (several tool
downloads, the OSV database, the semgrep registry) — a required check that can fail because a CDN was slow is a check
people learn to bypass. If it proves reliable over a few dozen runs, promote it:

```sh
gh api -X PATCH repos/mohammadchehab/tmux-fleet/branches/main/protection/required_status_checks \
  -f 'checks[][context]=checks' -f 'checks[][context]=security'
```

## Not wired yet: evals

§17 puts evals in phase 2, path-gated on the roles, the Judge prompts and question schemas, the model/limits config and
the `StateFile` schema. `ci.yml` carries a commented-out job where that lands; it is a placeholder, not a TODO someone
should pick up before the Judge is real.
