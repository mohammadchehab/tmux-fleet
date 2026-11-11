# Shared fleets: pooled budgets across people, with no server

**Status**: design. Security: approved with task data off; Legal sign-off required to turn it on (§7, §9). Supersedes PR #159 (a Backlog.md board synced through a shared remote).
**Builds on**: [`fleet-v2-architecture.md`](fleet-v2-architecture.md) — one `fleetd` per person, event-sourced store,
typed questions only (§5.3), the Mailbox (§7), the build ledger (§11).

## 1. Intent

Let developers working on the same customer epic pool their fleets, so the team's combined AI budget — each person's
monthly Claude or Cursor spend cap — is used evenly, instead of one fleet running dry on day 20 while another's budget
expires unused at the end of the month.

- Each developer runs their own `fleetd` on their own laptop. Two people or a hundred: the design does not change.
- Fleets on the same epic see each other, take tasks by **budget headroom** (spend pace against the month), avoid
  duplicate work (one architect and contract per epic, one review per PR, one build per sha), and message each other.
- A cross-fleet action needs the receiving person's approval, unless that person configured **one-way auto-trust per
  action kind** — A may auto-trust B's review requests and still be asked about B's messages.

### Constraints

These are the requirements, not preferences; an option that breaks one was rejected, not deferred.

- **No server.** Nobody runs, hosts or maintains anything. The system is whoever has `fleetd` running.
- **No laptop-to-laptop networking.** Everyone works from home behind NAT. Hole punching, a relay/gateway, libp2p and a
  mesh VPN were all rejected: each opens an inbound path to a laptop, routes around the corporate VPN, or is a new
  service someone must own and pen-test (§8).
- **Nothing written to the customer's systems.** The customer's tracker is read-only to the fleet (it already is, §3 of
  the architecture); the customer's forge is used for code and PRs, as today. No coordination data appears there.
- **Nothing customer-identifying is readable outside the engagement.**
- **No maintenance chores** for a developer: no key to generate, share, store or rotate by hand.
- **A real security risk drops the design**; it is not patched around.

## 2. The medium

One **private repository in the company's GitHub org** (`fleet-coord`), readable and writable only by a per-engagement
**GitHub team**. GitHub is already run and secured by the company; every fleet reaches it outbound over HTTPS/SSH
(verified from the company VPN alongside the customer's forge). Nothing listens on any laptop.

Fleets never talk to each other. They read and write the repo.

```
fleet-coord  (private; nobody pushes to main)
  <ns>/fleet/<github-user>     only that person's fleet writes here: heartbeat, pace, bids, outgoing messages
  <ns>/claim/<masked-task-id>  a claim; whoever created the ref holds the task
  <ns>/rotate/<n>              a key rotation; whoever created the ref performed it
  keys/<ns>/<github-user>.age  the engagement key, encrypted to that member's GitHub SSH key (§5)
```

`<ns>` is an **engagement code name** (`eng-07`), mapped to the customer only in each person's local profile, so even
the namespace says nothing about who the customer is.

### 2.1 Single writer per ref

Every ref has exactly one writer, which is §1's rule ("one source of truth") applied to branches:

- `fleet/<user>` is written only by that user's fleet, so two fleets never edit the same thing and there is never a
  merge, a rebase or a lost write.
- `claim/<id>` and `rotate/<n>` are **created once**. GitHub rejects creating a ref that already exists, so of any
  number of simultaneous attempts exactly one succeeds; the rest read the winner and move on. This is the only
  arbitration the design needs, and the forge does it.

### 2.2 Polling

Without a server nothing can push a change to a laptop, so every fleet asks. Each poll is one `git ls-remote` (every ref
and its sha in a single request) followed by a fetch of only the refs that moved. The interval is 30–60 s, done by
deterministic code — no model call, no tokens against anyone's cap. A task takes hours; learning of a claim up to a
minute late costs nothing. Live chat between peers is the one thing this does not do well, and it is not a goal.

Polling at scale has to stay cheap for GitHub and quiet on the network, so:

- **A fleet branch is one commit, replaced.** Each publish is a parentless commit pushed over the last one, with a
  lease on the sha the fleet last pushed. The branch is a current state, not a history, so a hundred fleets never
  push a hundred growing histories.
- **The heartbeat is pushed on change, or every 10 minutes.** Pace and capacity that did not move are not
  re-published every poll; at 30 s for a hundred fleets that would be hundreds of thousands of commits a day.
- **The interval adapts.** 30 s while this fleet has something pending (a bid, a claim, a decision), 5–10 min when
  idle, and none while the laptop is idle or asleep.
- **Every request says what it is.** Git's HTTP user agent is `tmux-fleet/<version> (fleet-coord)`, because a
  fixed-interval poll to one host is what beaconing looks like to an endpoint agent.

### 2.3 A machine goes offline

- **Its own work continues.** A fleet's store is local; its peers keep working on what they hold. Pushes queue and go
  out on reconnect. It claims nothing new while offline, because a claim is a push.
- **Its claims are not stranded.** A claim is held while its owner's heartbeat is fresh. Once the heartbeat is older
  than the release window (default 8 h, a profile setting), another fleet may release it by deleting the claim ref and
  re-claiming; the release is a commit on the releasing fleet's branch, so it is attributable. Staleness is judged from
  the push time GitHub records for the owner's branch (the repository activity API), never from a commit's own
  timestamp, which the owner's laptop sets.
- **On reconnect** a fleet fetches before it pushes. A task whose claim it lost is abandoned; its peer is told through
  its Mailbox, and the worktree is kept, never deleted, so nothing local is lost.
- **Decisions wait for their human.** A decision addressed to an offline person stays in the repo, encrypted, and is
  in their inbox (§6.1) on the next `fleet up`. Nobody else answers it unless the trust table names them.

## 3. Allocation by budget pace

Each fleet already measures its spend per turn, per peer and per Work (`TokenReport`, `spendFrom` — §6.2 of the
architecture). It publishes on its own branch, in plaintext because none of it is about the customer:

| field | meaning |
| :- | :- |
| `cap` | the owner's monthly cap |
| `spent` | spend so far this month |
| `pace` | `spent / cap` against `elapsed / month`: below 1 is under pace, above 1 is over |
| `capacity` | idle peers by role |
| `heartbeat` | the last time this fleet polled |

When a task in the epic becomes ready, eligible fleets **bid**: an under-pace fleet with an idle peer of the right role
bids, an over-pace fleet does not. The claim (§2.1) decides between simultaneous bidders. Each fleet only ever spends its
own owner's budget, on work its owner accepted or auto-trusted; no credential and no money moves between people, and
every dollar stays attributed to whoever's fleet ran the work. The cap's owner (finance) should still be told the epic is
allocated this way.

Duplicate work is the other half of the waste, and the shared repo removes it:

- **One contract per epic**: the epic's architect Work is claimed once, and every fleet's briefs cite that contract.
- **One review per PR**: a review is a task like any other, claimed once, preferably by an under-pace fleet.
- **One build per sha**: the build ledger's `(repo, sha, task)` key (§11) is published, so a fleet reuses a result
  another fleet already produced.
- **Dedupe before assign** (§5.2) also reads the other fleets' claims.

## 4. Trust and approval

Trust is a per-person table, keyed by GitHub username, **one-way** and **per action kind**:

```yaml
trust:
  alice: { offer_task: auto, review: auto, message: ask }
  bob:   { offer_task: ask }          # anything unnamed is `ask`
```

`ask` puts a row in the owner's decision inbox (§6.1); `auto` acts. Before acting on anything, a fleet checks that the
commit is GitHub-verified and that its author is a current member of the engagement team.

A message from another fleet's peer is **data, never an instruction** — the same rule the Judge already applies to peer
text (§5.3). It is typed, it reaches a peer only through that peer's Mailbox (§7), and any action it would trigger goes
through the trust table first.

## 5. Masking and the engagement key

Task-related data — task ids, bids, peer messages, PR references — is **masked and encrypted**:

- a task id becomes `HMAC(key, "task" ‖ id)`, so `PROJ-412` is `claim/7f3a9c…` on every member's fleet and noise to
  anyone else;
- every task-related payload is AEAD-encrypted under the same key before it is committed.

### 5.1 The key

One random 32-byte key per engagement, **encrypted separately to each team member's GitHub SSH public key** with
[`age`](https://age-encryption.org), which accepts `ssh-ed25519` and `ssh-rsa` recipients natively:

- **Members** are the engagement's GitHub team — the same list that grants repo access, so there is one list, not two.
- **Public keys** come from the authenticated API (`gh api users/<user>/keys`). The anonymous `github.com/<user>.keys`
  URL returns 404 for enterprise-managed accounts, so it is not used.
- **Reading**: each fleet decrypts its own `keys/<ns>/<user>.age` with the owner's SSH private key and holds the key in
  memory only — never on disk, in git, in the environment or in an event.
- `age` is called as a binary, as `git` and `gh` are: the TypeScript implementation (`age-encryption` 0.3.x) has no SSH
  recipients, and hand-rolled ed25519→X25519 conversion is exactly the crypto a review should refuse.

Verified with `age` 1.3.2: a member decrypts their own copy, cannot open another member's, and a non-member decrypts
nothing; a key read through the API for an enterprise-managed account encrypts, and the matching `~/.ssh/id_rsa`
decrypts.

A developer whose SSH key lives only in an agent or on hardware has no file `age` can use. `fleet up` detects that and
prints the one-time fix (`ssh-keygen -t ed25519`, add the `.pub` to GitHub) instead of failing without a reason.

### 5.2 Membership changes, with no one doing anything but the team change

Each poll, a fleet compares the team's members with the files under `keys/<ns>/`:

- **Someone joined**: any member's fleet encrypts the current key to the newcomer's keys and commits their copy.
- **Someone left**: GitHub has already removed their repo access — the first lock, closed at once. Within one poll, the
  first online fleet creates `rotate/<n>` (exactly one wins, §2.1), generates a new key, encrypts it to the remaining
  members only, deletes the leaver's copy, and releases every claim the leaver held so their tasks return to the pool
  immediately. If no fleet is online, this happens at the next `fleet up`; nothing leaks in between, because the leaver
  can no longer read the repo.

Data the leaver fetched before removal stays readable to them: no system revokes what someone already holds. It covers
only up to the moment they left, they were entitled to it then, and it is masked metadata, not code.

### 5.3 Controls, in order

1. **Repo access** — a per-engagement GitHub team. Everyone who can read the repo is on the engagement.
2. **The key** — a second lock, so that a mistake in (1) or a copied clone does not expose task content.
3. **Verified commits and the trust table** — so a member's fleet cannot be impersonated, and cannot act on another's
   machine without that person's rule allowing it.

**Offboarding is one step**: remove the person from the GitHub team.

## 6. Commands

```sh
fleet coord init <ns> --team <org>/<team> --repo <org>/fleet-coord   # once per engagement, by whoever starts it
fleet coord status                                                   # members, who holds a copy, last rotation
fleet coord rotate                                                   # emergency rotation; otherwise automatic
```

Everyone else adds the engagement to their profile; `fleet up` does the rest:

```yaml
coord: { engagement: eng-07, team: <org>/<team>, repo: <org>/fleet-coord, taskData: false }
```

## 7. Security review

Reviewed by the security session on 2026-11-10 against an earlier draft whose key was derived from the customer
workspace repo's root commit: **approve with changes**. Re-reviewed the same day against §5 as written here:
**approved with task data off; Legal sign-off required before it is turned on.**

| finding | status |
| :- | :- |
| 1. key from an unprotected source — needs rotation, audit, authenticated delivery | **approved** (critical → low-medium): a random key, rotated on every departure, rotations in git history and team changes in the org audit log, delivered only to the holder of a member's SSH key. Residual: a member's SSH private key is the root of their copy (standard SSH model). |
| 2. customer-derived metadata on the company's GitHub needs written InfoSec, Legal and customer sign-off | **approved with `taskData: false`**, which publishes nothing customer-derived. **Legal sign-off required** before `taskData: true` (§9). |
| 3. metadata visible to every org member | **approved** (medium → low): a per-engagement team, not org-wide access. |
| 4. no cross-fleet revocation | **approved** (medium → low): removal from the team revokes access at once and rotates the key within a poll (§5.2). |
| 5. deterministic masking shows repetition | accepted: payloads are encrypted; masking alone was never the control. |
| 6. prompt injection via peer messages | accepted as-is (§4). |
| 7. claim races | accepted: ref creation is atomic. |

## 8. Rejected alternatives

| alternative | why not |
| :- | :- |
| Backlog.md synced through a shared remote (PR #159) | every fleet edits one file: concurrent pushes collide and the loser must rebase and redo; stale-claim timestamps depend on laptops' clocks |
| The customer's tracker as the medium | the customer would see the fleet's coordination |
| NAT hole punching | still needs a rendezvous server; opens an inbound path to a laptop; bypasses the VPN; fails on symmetric NAT |
| A relay/gateway (OpenClaw-style) or libp2p | a server someone runs, and a new network service to secure |
| A mesh VPN | a third-party control plane between employees' laptops |
| A key derived from the workspace repo's root commit | not a secret: it survives in CI logs, mirrors and former members' clones; not rotatable (finding 1) |
| A company vault (1Password, cloud KMS) | meets finding 1, but needs an account request per person — a maintenance chore §1 rules out. Remains the fallback if §5 is not accepted. |

## 9. One release, task data behind a switch

Everything ships as **one release**, built as a series of small PRs (one package each, in `PACKAGE_ORDER`). What
security approved works on day one; what needs Legal is already built and is turned on by one profile setting:

```yaml
coord: { engagement: eng-07, team: <org>/<team>, repo: <org>/fleet-coord, taskData: false }
```

| `taskData` | what runs | gate |
| :- | :- | :- |
| `false` (the default when absent) | heartbeat, pace and capacity on each fleet's branch (§3); `fleet coord init`, the `age`-wrapped key, join and leave handling (§5) | approved |
| `true` | masked claims and bids (§3), one review per PR, one build per sha, cross-fleet dedupe, peer messages through the trust table (§4) | Legal sign-off (finding 2) |

With `taskData: false` the fleet writes nothing derived from the customer: no masked id, no claim ref, no message. That
is a property the tests assert on the bytes pushed, not a promise. Turning it on needs no new code and no new release.

The PRs, in order, each with its tests:

1. the coordination port in `foundation/contracts`, and its git transport in `integrations` (`ls-remote`, fetch, push to
   one's own branch, create-once refs);
2. pace and capacity publishing, read by the PM (§3);
3. the engagement key: `fleet coord init|status|rotate`, `age` wrapping, join and leave (§5);
4. claims and bids, behind `taskData`;
5. shared reviews, builds and dedupe, behind `taskData`;
6. peer messages through the trust table, behind `taskData`.

`apps/daemon` injects the transport; no group imports another (§1.1).
