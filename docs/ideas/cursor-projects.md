# Cursor "multiplayer projects" — what was said, and how it could meet the fleet

Logged 2026-11-11. Source: Slack message from Yanis Bousdira to Mohammad, announcing the release and asking for
context on the API use-case. Nothing here is decided; it is the record and the options (§14.1: remembered, not committed to).

## What was said (condensed, nothing added)

- Projects are the shared workspace in the Cursor agent window: the agents, the task list and the memory live there together.
- Agents work in *our* repositories and open pull requests there, so branch rules and CI still apply. Each runs on a
  Cursor-managed machine, or on one of ours when the work depends on that checkout.
- The command-line agent and other connected agents sit outside the window. **They do not join a Project, and there is
  no API to pull the task list or memory out of it.**
- Invited people share tasks and memory; each has their own chat. A task belongs to the person doing it, who approves a
  new repository, environment or machine. A team admin can turn Projects off for the whole team.
- Rolling out by team, Enterprise included; whether our tenant is on has to be checked on the account (they can enable it).
- Jira: **untested.** Jira can stay the source of truth. The Project agent can be told to claim a work item for one
  developer before starting and write stage changes back; work starts only after a second read shows that developer as
  assignee. Not tested end to end.
- They offered to capture feature requests and asked for context on the API use-case.

## How it relates to the fleet today

- Our `cursor` provider (§4) is the `cursor-agent` CLI, read-only, plan mode only. That is the "command-line agent"
  Yanis says does not join Projects. Projects agents are a different thing: they write code and open PRs.
- Nothing is programmatically reachable, so there is nothing to build against yet. Any integration that exists today
  is by side effect, through the places both systems already touch.

## Options

1. **PR-level, zero code (works as soon as the tenant is on).** A Project agent's PR lands in a repo the fleet
   watches. The forge ports see it like any PR (CI, review, `Work.prs`). Cost: the fleet did not assign it, so there is
   no `Work` behind it unless the PR is linked to a card by the tracker.
2. **Jira as the shared medium.** `tracker-sync` already mirrors the board from Jira. If Project agents claim and move
   Jira items, the fleet sees the same claims and stage changes it sees from a human. The risk is two claimers: the
   fleet's PM assigning a card a Project agent has already claimed. Needs a rule that an externally claimed item is not
   assignable (an `assign` guard on the item's assignee). Depends on the untested claim / write-back flow.
3. **A Projects adapter, once an API exists.** The shape would be a new tracker or provider sink: read the task list
   and memory, create and update tasks. This is the real integration and it is blocked on the missing API.

Recommended order: do nothing in code now; check the tenant; run the Jira claim flow end to end by hand (option 2's
precondition); build option 3 only if the API ships.

## Asks to send back (the API use-case)

1. A read/write API or webhook for the Project task list.
2. An API for Project memory.
3. CLI-agent participation in a Project (claim a task, report progress).
4. Events (task claimed, PR opened, stage changed) to subscribe to instead of polling.
