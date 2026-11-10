#!/usr/bin/env bash
# test/worktrees.sh: the worktree layout helper (skills/fleet/scripts/lib/worktree.sh), fleet-worktree's topic-only names and
# owner marker, and clean.sh's stale rule, all against real temporary git repos with a real bare remote.
# Layout: the main checkout is found from inside a linked worktree; FLEET_HOME overrides the fleet repo's.
# fleet-worktree: the folder is the topic only (no peer name), the owner is recorded, `list <peer>` finds it by owner and finds a
#   legacy <peer>-<topic> folder by its prefix, a repo outside the target is refused; "." from a peer's launch worktree, the
#   launch worktree's path and a child repo's worktree path all land in that repo's main checkout, never nested.
# clean.sh removes ONLY worktrees whose branch is merged into main (an ancestor, or squash-merged: main holds the content) or
#   gone from the remote; it keeps a dirty one, a detached HEAD, an unmerged branch that is still on the remote, and one never
#   pushed; a dry run removes nothing; --force removes the folder but never the branch; it covers the fleet repo's own
#   worktrees (FLEET_HOME), the target repo's and its child repos'.
# Touches only a temp directory (removed on exit); no tmux server (a private socket name), no network.
# Usage: worktrees.sh
set -euo pipefail
source "$(dirname "$0")/../lib/env.sh"
cd "$ROOT"
fail=0; pass=0
ok() { pass=$((pass+1)); }
bad() { echo "FAIL: $*"; fail=$((fail+1)); }
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
t=$(cd "$t" && pwd -P)
export FLEET_WT_CACHE="$t/wtcache" FLEET_WT_LOCK_DIR="$t/wtlock"   # worktree scans: never the real ~/.fleet-state
export FLEET_TMUX="wt-test-$$" FLEET_STATE="$t/state" GIT_CEILING_DIRECTORIES="$t"
mkdir -p "$t/state"
G() { git -C "$1" -c user.email=t@t -c user.name=t "${@:2}"; }
commit() { echo "$2" >> "$1/$3"; G "$1" add -A; G "$1" commit -q -m "$2"; }

# a repo with a bare remote: main pushed, an origin/main to compare with
mkrepo() {  # mkrepo <dir>: a repo with a bare remote next to it
  git init -q --bare -b main "$1.git"
  git clone -q "$1.git" "$1" 2>/dev/null
  G "$1" checkout -q -b main 2>/dev/null || true
  commit "$1" base base.txt; G "$1" push -q -u origin main
}
LIB="$ROOT/skills/fleet/scripts/lib/worktree.sh"
C="$ROOT/dev-tasks/scripts/clean/clean.sh"
WT="$ROOT/skills/fleet/scripts/fleet-worktree"

# ---- layout helper
mkrepo "$t/fleet"
G "$t/fleet" worktree add -q -b topic-a "$t/fleet/.claude/worktrees/topic-a"; commit "$t/fleet/.claude/worktrees/topic-a" "work in progress" wip.txt
out=$(env FLEET_HOME="$t/fleet" bash -c "source '$LIB'; fleet_main_checkout '$t/fleet/.claude/worktrees/topic-a'; fleet_worktree_root '$t/fleet/.claude/worktrees/topic-a'; echo \"\$FLEET_HOME\"")
[ "$out" = "$(printf '%s\n%s\n%s' "$t/fleet" "$t/fleet/.claude/worktrees" "$t/fleet")" ] && ok || bad "main checkout, root and the FLEET_HOME override from inside a worktree: $out"
out=$(env -u FLEET_HOME bash -c "source '$LIB'; echo \"\$FLEET_HOME\"")
[ "$out" = "$(cd "$ROOT" && git rev-parse --path-format=absolute --git-common-dir | xargs dirname)" ] && ok || bad "FLEET_HOME default is the fleet repo's main checkout: $out"

# ---- fleet-worktree: topic-only names, owner, list, a repo outside the target refused
mkdir -p "$t/umb/bundles"
mkrepo "$t/umb/bundles/app"
out=$(env FLEET_REPO="$t/umb" "$WT" alice "$t/umb/bundles/app" feat/my-topic 2>&1)
[ "$out" = "$t/umb/bundles/app/.claude/worktrees/feat-my-topic" ] && ok || bad "the folder is the topic only, no peer name: $out"
[ -d "$t/umb/bundles/app/.claude/worktrees/feat-my-topic" ] && ok || bad "the worktree must exist"
owner=$(env bash -c "source '$LIB'; fleet_worktree_owner '$t/umb/bundles/app/.claude/worktrees/feat-my-topic'")
[ "$owner" = alice ] && ok || bad "the owner must be recorded: $owner"
out=$(env FLEET_REPO="$t/umb" "$WT" bob "$t/umb/bundles/app" feat/my-topic 2>&1)
[ "$out" = "$t/umb/bundles/app/.claude/worktrees/feat-my-topic" ] && ok || bad "an existing worktree is returned as it is: $out"
owner=$(env bash -c "source '$LIB'; fleet_worktree_owner '$t/umb/bundles/app/.claude/worktrees/feat-my-topic'")
[ "$owner" = alice ] && ok || bad "the owner must not change when another peer asks for the same topic: $owner"
G "$t/umb/bundles/app" worktree add -q -b legacy-x "$t/umb/bundles/app/.claude/worktrees/carol-legacy-x"
l=$(env FLEET_REPO="$t/umb" "$WT" list alice); echo "$l" | grep -q 'feat-my-topic' && ! echo "$l" | grep -q 'carol-legacy-x' && ok || bad "list <peer> must find a peer's worktree by owner: $l"
l=$(env FLEET_REPO="$t/umb" "$WT" list carol); echo "$l" | grep -q 'carol-legacy-x' && ! echo "$l" | grep -q 'feat-my-topic' && ok || bad "list <peer> must find a legacy <peer>- folder by its prefix: $l"
[ "$(env FLEET_REPO="$t/umb" "$WT" list | wc -l | tr -d ' ')" = 2 ] && ok || bad "list with no peer shows every worktree"
mkrepo "$t/outside"
if env FLEET_REPO="$t/umb" "$WT" alice "$t/outside" x >/dev/null 2>&1; then bad "a repo outside the target repo must be refused"; else ok; fi
# never nested: a peer runs it from its launch worktree <repo>/.claude/worktrees/<peer>; "." and that worktree's path are the
# target repo, and the topic lands in the main checkout's .claude/worktrees, not in <peer>/.claude/worktrees
mkrepo "$t/tr"; G "$t/tr" worktree add -q --detach "$t/tr/.claude/worktrees/engineer-1" main
out=$(cd "$t/tr/.claude/worktrees/engineer-1" && env -u FLEET_REPO -u FLEET_PROFILE "$WT" engineer-1 . feat/todo 2>&1)
[ "$out" = "$t/tr/.claude/worktrees/feat-todo" ] && [ -d "$out" ] && ok || bad "fleet-worktree . from a launch worktree: $out"
[ ! -e "$t/tr/.claude/worktrees/engineer-1/.claude" ] && ok || bad "a topic worktree was nested in the peer's launch worktree"
[ "$(G "$out" branch --show-current)" = feat/todo ] && ok || bad "the topic worktree is not on its branch"
out=$(env FLEET_REPO="$t/tr" "$WT" engineer-1 "$t/tr/.claude/worktrees/engineer-1" feat/two 2>&1)
[ "$out" = "$t/tr/.claude/worktrees/feat-two" ] && ok || bad "the launch worktree's path must redirect to the main checkout: $out"
out=$(env FLEET_REPO="$t/umb" "$WT" alice "$t/umb/bundles/app/.claude/worktrees/feat-my-topic" feat/three 2>&1)
[ "$out" = "$t/umb/bundles/app/.claude/worktrees/feat-three" ] && ok || bad "a child repo's worktree path must redirect to the child's main checkout: $out"

# ---- clean.sh: the stale rule. One repo per case set; each worktree sits in <repo>/.claude/worktrees/<topic>
mkrepo "$t/tgt"
R="$t/tgt"; WTD="$R/.claude/worktrees"
G "$R" worktree add -q --detach "$WTD/launch" main                                        # detached: kept
# fresh branches, never pushed and with no commit of their own: kept (one at main's tip now, one that main will move ahead of)
G "$R" worktree add -q -b fresh-behind "$WTD/fresh-behind"
# merged by ancestry
G "$R" worktree add -q -b m-anc "$WTD/m-anc"; commit "$WTD/m-anc" "anc" anc.txt; G "$WTD/m-anc" push -q -u origin m-anc; G "$R" merge -q --no-ff m-anc -m "merge anc"
# squash-merged: main gets the same content in a different commit
G "$R" worktree add -q -b m-squash "$WTD/m-squash"; commit "$WTD/m-squash" "squash" sq.txt; G "$WTD/m-squash" push -q -u origin m-squash
G "$R" merge -q --squash m-squash >/dev/null; G "$R" commit -q -m "squash m-squash"
# not merged, pushed, still on the remote: kept
G "$R" worktree add -q -b open "$WTD/open"; commit "$WTD/open" "open" open.txt; G "$WTD/open" push -q -u origin open
# not merged, never pushed: kept
G "$R" worktree add -q -b local-only "$WTD/local-only"; commit "$WTD/local-only" "lo" lo.txt
# not merged, pushed, then deleted on the remote: stale (gone)
G "$R" worktree add -q -b gone "$WTD/gone"; commit "$WTD/gone" "gone" gone.txt; G "$WTD/gone" push -q -u origin gone
git --git-dir="$R.git" branch -q -D gone
# merged but dirty: kept
G "$R" worktree add -q -b dirty "$WTD/dirty"; commit "$WTD/dirty" "dirty" d.txt; G "$WTD/dirty" push -q -u origin dirty; G "$R" merge -q --no-ff dirty -m "merge dirty"; echo x > "$WTD/dirty/untracked.txt"
G "$R" push -q origin main
G "$R" worktree add -q -b fresh-tip "$WTD/fresh-tip"                                    # at main's tip, never pushed
# a merged branch that was never pushed is kept too (a repo with no remote, or a local-only merge)
G "$R" worktree add -q -b merged-unpushed "$WTD/merged-unpushed"; commit "$WTD/merged-unpushed" "mu" mu.txt; G "$R" merge -q --no-ff merged-unpushed -m "merge mu"; G "$R" push -q origin main
export FLEET_HOME="$t/nohome" FLEET_REPO="$R"
out=$("$C" 2>&1)
rm_=$(grep '^would remove' <<<"$out")
! grep -q '/launch ' <<<"$rm_" && ok || bad "a detached HEAD must be kept: $out"
grep -q "/m-anc (merged, branch m-anc" <<<"$rm_" && ok || bad "an ancestor-merged branch is stale: $out"
grep -q "/m-squash (merged, branch m-squash" <<<"$rm_" && ok || bad "a squash-merged branch is stale: $out"
grep -q "/gone (gone, branch gone" <<<"$rm_" && ok || bad "a branch gone from the remote is stale: $out"
for k in open local-only fresh-tip fresh-behind merged-unpushed; do
  ! grep -q "/$k " <<<"$rm_" && ok || bad "$k must be kept (not merged, or never pushed): $out"
done
grep -q "^keep .*/dirty (merged; dirty: 1 files)" <<<"$out" && ok || bad "a dirty worktree must be kept even when merged: $out"
grep -q "^would free .* (3 worktrees), kept 1" <<<"$out" && ok || bad "the dry run must report the space it would free: $out"
[ -d "$WTD/m-anc" ] && [ -d "$WTD/m-squash" ] && [ -d "$WTD/gone" ] && ok || bad "a dry run must remove nothing"
out=$("$C" --force 2>&1)
[ ! -d "$WTD/m-anc" ] && [ ! -d "$WTD/m-squash" ] && [ ! -d "$WTD/gone" ] && ok || bad "--force must remove the stale worktrees: $out"
[ -d "$WTD/launch" ] && [ -d "$WTD/open" ] && [ -d "$WTD/local-only" ] && [ -d "$WTD/dirty" ] && ok || bad "--force must keep the rest"
[ -d "$WTD/fresh-tip" ] && [ -d "$WTD/fresh-behind" ] && [ -d "$WTD/merged-unpushed" ] && ok || bad "--force must keep every never-pushed branch, fresh or merged"
! G "$R" show-ref -q --verify refs/heads/m-squash && ! G "$R" show-ref -q --verify refs/heads/gone && ok || bad "--force deletes the branches of merged and gone worktrees"
G "$R" show-ref -q --verify refs/heads/open && G "$R" show-ref -q --verify refs/heads/local-only && G "$R" show-ref -q --verify refs/heads/dirty && ok || bad "--force must keep the branches of kept worktrees"
grep -q "^freed .* (3 worktrees)" <<<"$out" && ok || bad "--force must report the space freed: $out"

# the fleet repo's own worktrees (FLEET_HOME) and a child repo's are covered too
G "$t/fleet" worktree add -q -b f-merged "$t/fleet/.claude/worktrees/f-merged"; commit "$t/fleet/.claude/worktrees/f-merged" f f.txt; G "$t/fleet/.claude/worktrees/f-merged" push -q -u origin f-merged
G "$t/fleet" merge -q --no-ff f-merged -m "merge f"; G "$t/fleet" push -q origin main
mkrepo "$t/umb2"; mkdir -p "$t/umb2/bundles"; mkrepo "$t/umb2/bundles/child"
G "$t/umb2/bundles/child" worktree add -q -b c-merged "$t/umb2/bundles/child/.claude/worktrees/c-merged"
commit "$t/umb2/bundles/child/.claude/worktrees/c-merged" c c.txt; G "$t/umb2/bundles/child/.claude/worktrees/c-merged" push -q -u origin c-merged; G "$t/umb2/bundles/child" merge -q --no-ff c-merged -m "merge c"; G "$t/umb2/bundles/child" push -q origin main
export FLEET_HOME="$t/fleet" FLEET_REPO="$t/umb2"
"$C" --force >/dev/null 2>&1
[ ! -d "$t/fleet/.claude/worktrees/f-merged" ] && ok || bad "the fleet repo's own merged worktree must be removed (FLEET_HOME)"
[ ! -d "$t/umb2/bundles/child/.claude/worktrees/c-merged" ] && ok || bad "a child repo's merged worktree must be removed"
[ -d "$t/fleet/.claude/worktrees/topic-a" ] && ok || bad "the fleet repo's unmerged worktree must stay"
echo "worktrees: $pass passed, $fail failed"
[ $fail -eq 0 ]
