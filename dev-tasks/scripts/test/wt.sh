#!/usr/bin/env bash
# test/wt.sh: fleet worktree ls|prune|summary|remind (skills/fleet/scripts/fleet-worktree, lib/worktree.sh fleet_wt_scan) and the
# capacity flag, on fixture repos (a target with a bare remote and a child repo, the fleet repo), a fake tmux whose peers have
# pane cwds, and a stub gh with fixture PRs. Every class (active, idle, merged, gone, orphaned incl. a missing folder, nested),
# the never-remove guards (dirty, unpushed, a peer in it, the caller's cwd), branch deletion, space freed, the dry run, the
# locks, remind once per worktree, the cached summary. Touches only a temp directory (removed on exit). Usage: wt.sh
set -euo pipefail
source "$(dirname "$0")/../lib/env.sh"
cd "$ROOT"
fail=0; pass=0
ok() { pass=$((pass+1)); }
bad() { echo "FAIL: $*"; fail=$((fail+1)); }
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT; t=$(cd "$t" && pwd -P)
unset FLEET_REPO FLEET_PROFILE FLEET_STATE TMUX TMUX_PANE
export GIT_CEILING_DIRECTORIES="$t" FLEET_TMUX=wt-$$ FAKE="$t" FLEET_USER_PROFILES_DIR="$t/profiles" FLEET_PROFILES_DIR="$t/noprofiles" \
  FLEET_WT_CACHE="$t/cache" FLEET_WT_LOCK_DIR="$t/locks" FLEET_HOME="$t/fleetrepo"
mkdir -p "$t/bin" "$t/profiles" "$t/noprofiles" "$t/state"
G() { git -C "$1" -c user.email=t@t -c user.name=t "${@:2}"; }
commit() { echo "$2" >> "$1/$3"; G "$1" add -A; G "$1" commit -q -m "$2"; }
mkrepo() { git init -q --bare -b main "$1.git"; git clone -q "$1.git" "$1" 2>/dev/null; G "$1" checkout -q -b main 2>/dev/null || true
  commit "$1" base base.txt; G "$1" push -q -u origin main; }
# fake tmux: $FAKE/sessions holds "session|profile|role|cwd"; ls/list-panes fill their -F formats from it
cat > "$t/bin/tmux" <<'STUB'
#!/usr/bin/env bash
case "${1:-}" in -L|-S) shift 2 ;; esac
cmd=${1:-}; shift || true
T=; prev=; for a in "$@"; do [ "$prev" = -t ] && T=$a; prev=$a; done; T=${T#=}; T=${T%%:*}
row() { grep "^$1|" "$FAKE/sessions" | head -1; }
fill() { local f=$1 s p r c; IFS='|' read -r s p r c <<<"$2"; f=${f//'#{session_name}'/$s}; f=${f//'#{@fleet-profile}'/$p}; f=${f//'#{@fleet-role}'/$r}
  f=${f//'#{@fleet-cli}'/claude}; f=${f//'#{pane_current_path}'/$c}; echo "$f"; }
case "$cmd" in
  ls|list-panes) fmt=; prev=; for a in "$@"; do [ "$prev" = -F ] && fmt=$a; prev=$a; done
    while IFS= read -r l; do [ -n "$l" ] && fill "$fmt" "$l"; done < "$FAKE/sessions" ;;
  has-session) [ -n "$(row "$T")" ] ;;
  show-options) l=$(row "$T"); [ -n "$l" ] || exit 0; IFS='|' read -r _ p r _ <<<"$l"
    case "${*: -1}" in @fleet-profile) echo "$p" ;; @fleet-role) echo "$r" ;; @fleet-cli) echo claude ;; esac ;;
  display) case "$*" in *pane_current_path*) l=$(row "$T"); [ -n "$l" ] || exit 1; IFS='|' read -r _ _ _ c <<<"$l"; echo "$c" ;;
      *socket_path*) echo /fake ;; *) echo "" ;; esac ;;
  capture-pane) [ -n "$(row "$T")" ] || exit 1; printf '%s\n' '⏺ done.' '───' '❯ ' '───' '  ⏵⏵ bypass permissions on' ;;
  send-keys) echo "$T $*" >> "$FAKE/keys" ;;
  *) exit 0 ;;
esac
STUB
printf '#!/bin/sh\nexit 0\n' > "$t/bin/sleep"
# stub gh: the PRs of the target repo, by branch
cat > "$t/bin/gh" <<'STUB'
#!/bin/sh
echo '[{"number":7,"state":"MERGED","headRefName":"t-merged"},{"number":8,"state":"OPEN","headRefName":"t-open"},{"number":6,"state":"CLOSED","headRefName":"t-open"}]'
STUB
chmod +x "$t/bin/"*; export PATH="$t/bin:$PATH"; : > "$t/sessions"; : > "$t/keys"

# ---- fixtures. Target repo R (profile p, idle after 3 days), its child repo, the fleet repo
mkrepo "$t/R"; R="$t/R"; W="$R/.claude/worktrees"; mkdir -p "$R/apps"; mkrepo "$R/apps/child"; mkrepo "$t/fleetrepo"
printf 'FLEET_REPO=%s\nFLEET_STATE=%s\nFLEET_WT_IDLE_DAYS=3\n' "$R" "$t/state" > "$t/profiles/p.env"
OWN() { bash -c 'source "$1/skills/fleet/scripts/lib/worktree.sh"; fleet_worktree_owner_set "$2" "$3"' _ "$ROOT" "$1" "$2"; }
G "$R" worktree add -q --detach "$W/engineer-1" main                                       # launch, its peer runs: active
G "$R" worktree add -q --detach "$W/designer" main                                         # launch, peer not running, clean: orphaned
G "$R" worktree add -q --detach "$W/architect" main; echo x > "$W/architect/scratch.txt"   # launch, not running, dirty: kept
G "$R" worktree add -q -b t-merged "$W/t-merged"; commit "$W/t-merged" m m.txt; G "$W/t-merged" push -q -u origin t-merged
G "$R" merge -q --no-ff t-merged -m "merge t-merged"; OWN "$W/t-merged" engineer-1         # merged, owner running
G "$R" worktree add -q -b t-gone "$W/t-gone"; commit "$W/t-gone" g g.txt; G "$W/t-gone" push -q -u origin t-gone
git --git-dir="$R.git" branch -q -D t-gone                                                  # gone
G "$R" worktree add -q -b t-busy "$W/t-busy"; commit "$W/t-busy" b b.txt; G "$W/t-busy" push -q -u origin t-busy
G "$R" merge -q --no-ff t-busy -m "merge t-busy"                                            # merged, engineer-2 is in it
G "$R" worktree add -q -b t-open "$W/t-open"; commit "$W/t-open" o o.txt; G "$W/t-open" push -q -u origin t-open   # active, PR #8
G "$R" worktree add -q -b t-old "$W/t-old"; GIT_COMMITTER_DATE="2026-10-01T00:00:00" GIT_AUTHOR_DATE="2026-10-01T00:00:00" commit "$W/t-old" old old.txt
G "$W/t-old" push -q -u origin t-old                                                       # idle (pushed)
G "$R" worktree add -q -b t-oldlocal "$W/t-oldlocal"; GIT_COMMITTER_DATE="2026-10-01T00:00:00" GIT_AUTHOR_DATE="2026-10-01T00:00:00" commit "$W/t-oldlocal" ol ol.txt   # idle, unpushed
G "$R" worktree add -q -b t-ghost "$W/t-ghost"; commit "$W/t-ghost" gh gh.txt; G "$W/t-ghost" push -q -u origin t-ghost; OWN "$W/t-ghost" ghost   # orphaned: owner gone
G "$R" worktree add -q -b t-nest "$W/engineer-1/.claude/worktrees/t-nest"; commit "$W/engineer-1/.claude/worktrees/t-nest" n n.txt
G "$W/engineer-1/.claude/worktrees/t-nest" push -q -u origin t-nest                         # nested
G "$R" worktree add -q -b t-missing "$W/t-missing"; rm -rf "$W/t-missing"                  # folder missing
G "$R/apps/child" worktree add -q -b c-merged "$R/apps/child/.claude/worktrees/c-merged"; commit "$R/apps/child/.claude/worktrees/c-merged" c c.txt
G "$R/apps/child/.claude/worktrees/c-merged" push -q -u origin c-merged; G "$R/apps/child" merge -q --no-ff c-merged -m mc; G "$R/apps/child" push -q origin main
G "$t/fleetrepo" worktree add -q -b f-open "$t/fleetrepo/.claude/worktrees/f-open"
G "$R" push -q origin main
printf '%s\n' "fleet-p-engineer-1|p|engineer|$W/engineer-1" "fleet-p-engineer-2|p|engineer|$W/t-busy/src" "fleet-p-board|p||$t/state" > "$t/sessions"
mkdir -p "$W/t-busy/src"   # an empty folder: the peer's cwd, not a change
G "$R" fetch -q --prune origin   # ls reads the remote-tracking refs as they are; prune fetches itself
WT=skills/fleet/scripts/fleet-worktree
cls() { awk -F'\t' -v p="$2" '$3 == p {print $13}' <<<"$1"; }

# ---- ls: classes, owner, PR, in use, totals, json; the board session is no peer
tsv=$($WT ls --tsv)
for c in "engineer-1:active" "designer:orphaned" "architect:orphaned" "t-merged:merged" "t-gone:gone" "t-busy:merged" "t-open:active" \
         "t-old:idle" "t-oldlocal:idle" "t-ghost:orphaned" "engineer-1/.claude/worktrees/t-nest:nested" "t-missing:orphaned"; do
  [ "$(cls "$tsv" "$W/${c%%:*}")" = "${c#*:}" ] && ok || bad "class of ${c%%:*}: want ${c#*:}, got '$(cls "$tsv" "$W/${c%%:*}")'"
done
[ "$(cls "$tsv" "$R/apps/child/.claude/worktrees/c-merged")" = merged ] && ok || bad "the child repo's merged worktree"
[ "$(awk -F'\t' -v p="$t/fleetrepo/.claude/worktrees/f-open" '$3 == p {print $1, $13}' <<<"$tsv")" = "(fleet repo) active" ] && ok || bad "the fleet repo's worktree: $tsv"
[ "$(awk -F'\t' -v p="$W/t-merged" '$3 == p {print $4, $7}' <<<"$tsv")" = "engineer-1 #7 merged" ] && ok || bad "owner and merged PR of t-merged"
[ "$(awk -F'\t' -v p="$W/t-open" '$3 == p {print $7}' <<<"$tsv")" = "#8 open" ] && ok || bad "an open PR wins over a closed one"
[ "$(awk -F'\t' -v p="$W/t-busy" '$3 == p {print $12}' <<<"$tsv")" = engineer-2 ] && ok || bad "a peer whose pane is in a worktree is shown in use"
[ "$(awk -F'\t' -v p="$W/engineer-1" '$3 == p {print $4, $5, $12}' <<<"$tsv")" = "engineer-1 launch engineer-1" ] && ok || bad "the running peer's launch worktree"
[ "$(awk -F'\t' -v p="$W/t-oldlocal" '$3 == p {print $10}' <<<"$tsv")" = 1 ] && [ "$(awk -F'\t' -v p="$W/architect" '$3 == p {print $9}' <<<"$tsv")" = 1 ] && ok || bad "unpushed and dirty counts"
out=$($WT ls)
grep -q '^profile p: 13 worktrees, 11 stale, ' <<<"$out" && grep -q "^  repo $R/apps/child (1 worktrees" <<<"$out" && grep -qE '^total: 14 worktrees, 11 stale, [0-9.]+[KMG]; fleet wt prune' <<<"$out" && ok || bad "ls totals: $out"
$WT ls --json | jq -e 'length == 14 and (map(select(.class == "nested")) | length) == 1 and (.[0].size_kb | type) == "number"' >/dev/null && ok || bad "ls --json"
[ "$($WT ls --stale --tsv | grep -c .)" = 11 ] && ok || bad "ls --stale lists only the stale ones"
FLEET_PROFILE=p $WT ls --tsv | grep -q fleetrepo && bad "--profile p must not list the fleet repo" || ok

# ---- summary (fresh and cached), capacity's flag
s=$(FLEET_PROFILE=p $WT summary); grep -qE '^worktrees \(p\): 13, 11 stale \(.*3 merged.*\), [0-9.]+[KMG]; fleet wt prune$' <<<"$s" && ok || bad "summary: $s"
s=$(FLEET_PROFILE=p $WT summary --cached); grep -q '^worktrees (p): 13, 11 stale' <<<"$s" && ok || bad "summary --cached reads the last scan: $s"
out=$(FLEET_PROFILE=p skills/fleet/scripts/fleet-ls 2>&1)
grep -q '^  worktrees (p): 13, 11 stale' <<<"$out" && ok || bad "fleet ls shows the profile's worktree summary: $out"
out=$(cd "$t" && env -u FLEET_PROFILE -u FLEET_REPO FLEET_STATE="$t/state" "$ROOT/skills/fleet/scripts/fleet-down" 2>&1) && ok || bad "fleet down with no target repo must exit 0: $out"
grep -q '^worktrees: no target repo, skipped' <<<"$out" && ok || bad "fleet down with no target repo: $out"
out=$(FLEET_PROFILE=p FLEET_STATE="$t/state" skills/fleet-capacity/scripts/fleet-capacity 2>&1)
grep -q 'In a stale worktree: engineer-2 (merged: t-busy)' <<<"$out" && ! grep -qE '^board ' <<<"$out" && ok || bad "capacity flags engineer-2 in a merged worktree: $out"

# ---- remind: once per worktree, only to a running owner; never removes anything
: > "$t/keys"; out=$(FLEET_STATE="$t/state" $WT remind)
grep -q "told engineer-1: #7 merged branch t-merged is merged: remove your worktree $W/t-merged" <<<"$out" && grep -q "fleet-p-engineer-1 .*t-merged" "$t/keys" && ok || bad "remind did not tell engineer-1: $out $(cat "$t/keys")"
! grep -q 'ghost\|engineer-2' "$t/keys" && ok || bad "remind told someone it should not: $(cat "$t/keys")"
: > "$t/keys"; out=$($WT remind); grep -q 'nothing to remind' <<<"$out" && [ ! -s "$t/keys" ] && ok || bad "remind must tell each owner once: $out"
[ -d "$W/t-merged" ] && ok || bad "remind removed a worktree"

# ---- prune: dry run, guards, --yes, branches, freed, locks
out=$($WT prune)
grep -q '^fleet wt prune: dry run' <<<"$out" && [ -d "$W/t-merged" ] && [ -d "$W/designer" ] && ok || bad "the dry run removed something: $out"
for k in designer t-merged t-gone t-ghost; do grep -q "^would remove $W/$k " <<<"$out" && ok || bad "dry run should offer $k: $out"; done
grep -q "^would prune $W/t-missing (folder missing" <<<"$out" && ok || bad "a missing folder is pruned: $out"
grep -q "^keep $W/architect (orphaned; dirty: 1 files)" <<<"$out" && grep -q "^keep $W/t-busy (merged; engineer-2 is in it)" <<<"$out" && ok || bad "guards: $out"
! grep -q "t-old\b\|t-oldlocal\|t-nest\|t-open\|/engineer-1 " <<<"$out" && ok || bad "idle, nested, active must not be offered by default: $out"
bash -c 'source "$1"; fleet_lock "$2" worktrees 0; /bin/sleep 3' _ skills/fleet/scripts/lib/lock.sh "$t/locks" & h=$!; /bin/sleep 0.5
out=$(FLEET_LOCK_WAIT=0 $WT prune --yes 2>&1) && bad "prune --yes ran while the worktrees lock was held" || ok
grep -q 'busy: worktrees is held by pid' <<<"$out" && [ -d "$W/t-merged" ] && ok || bad "prune --yes under a held lock: $out"
wait $h 2>/dev/null || true
out=$(cd "$W/t-gone" && "$ROOT/$WT" prune 2>&1)
grep -q "^keep $W/t-gone (gone; it is your current directory)" <<<"$out" && [ -d "$W/t-gone" ] && ok || bad "the caller's own worktree must be kept: $out"
out=$($WT prune --yes 2>&1)
[ ! -d "$W/designer" ] && [ ! -d "$W/t-merged" ] && [ ! -d "$W/t-gone" ] && [ ! -d "$W/t-ghost" ] && [ ! -d "$R/apps/child/.claude/worktrees/c-merged" ] && ok || bad "--yes must remove the stale worktrees: $out"
[ -d "$W/architect" ] && [ -d "$W/t-busy" ] && [ -d "$W/engineer-1" ] && [ -d "$W/t-open" ] && [ -d "$W/t-old" ] && ok || bad "--yes must keep the guarded and active ones"
! G "$R" worktree list --porcelain | grep -q t-missing && ok || bad "the missing folder's entry must be pruned"
! G "$R" show-ref -q --verify refs/heads/t-merged && ! G "$R" show-ref -q --verify refs/heads/t-gone && ! G "$R" show-ref -q --verify refs/heads/t-ghost && ok || bad "the branches of removed worktrees must go"
grep -q "deleted branch t-ghost (the remote keeps it)" <<<"$out" && git --git-dir="$R.git" show-ref -q --verify refs/heads/t-ghost && ok || bad "an orphaned pushed branch: local deleted, remote kept: $out"
grep -qE '^freed [0-9.]+[KMG] \([0-9]+ worktrees\), kept 2' <<<"$out" && ok || bad "--yes reports the space freed: $out"
out=$($WT prune --yes --idle 2>&1)
[ ! -d "$W/t-old" ] && grep -q "^keep $W/t-oldlocal (idle; 1 unpushed commits)" <<<"$out" && [ -d "$W/t-oldlocal" ] && ok || bad "--idle removes a pushed idle worktree, never an unpushed one: $out"
out=$($WT prune --yes --nested 2>&1)
[ ! -d "$W/engineer-1/.claude/worktrees/t-nest" ] && [ -d "$W/engineer-1" ] && ok || bad "--nested removes the nested worktree only: $out"
[ ! -d "$t/locks/locks/worktrees.lock" ] && ok || bad "the worktrees lock must be released"

# ---- a peer on another tmux server than the one targeted: no pane of it here, so ba's launch worktree looks orphaned, but its
# process sits in it and prune keeps it (real processes, read with lsof; nothing reads the other server)
G "$R" worktree add -q --detach "$W/ba" main
(cd "$W/ba" && exec /bin/sleep 60) & sp=$!; /bin/sleep 0.3
[ "$(cls "$($WT ls --tsv --no-pr --no-fetch)" "$W/ba")" = orphaned ] && ok || bad "ba has no pane on the targeted server"
out=$($WT prune --yes 2>&1)
[ -d "$W/ba" ] && grep -q "^keep $W/ba (orphaned; process $sp sleep is in it)" <<<"$out" && ok || bad "prune must keep a worktree a process sits in: $out"
kill $sp 2>/dev/null; wait $sp 2>/dev/null || true
out=$($WT prune --yes 2>&1); [ ! -d "$W/ba" ] && ok || bad "once the process is gone the clean launch worktree goes: $out"

# ---- nested: a parent holding a worktree that stays stays too; else the nested ones go first and sizes are not counted twice
bash -c 'source "$1/skills/fleet/scripts/lib/worktree.sh"; fleet_worktree_exclude "$2"' _ "$ROOT" "$R"   # as fleet wt new does
G "$R" worktree add -q --detach "$W/pr-architect" main
G "$R" worktree add -q -b p-unp "$W/pr-architect/.claude/worktrees/p-unp"; G "$W/pr-architect/.claude/worktrees/p-unp" push -q -u origin p-unp
commit "$W/pr-architect/.claude/worktrees/p-unp" u u.txt                                  # 1 unpushed commit
G "$R" worktree add -q --detach "$W/spec-reviewer" main; S="$W/spec-reviewer/.claude/worktrees/s-done"
G "$R" worktree add -q -b s-done "$S"; head -c 2097152 /dev/zero > "$S/big.bin"; G "$S" add -A; G "$S" commit -q -m big; G "$S" push -q -u origin s-done
out=$($WT prune 2>&1)
grep -q "^keep $W/pr-architect (orphaned; contains kept worktree $W/pr-architect/.claude/worktrees/p-unp (nested; skipped without --nested))" <<<"$out" \
  && ! grep -q "would remove $W/pr-architect " <<<"$out" && ok || bad "a parent holding a worktree prune skips must be kept: $out"
out=$($WT prune --nested 2>&1)
grep -q "^keep $W/pr-architect/.claude/worktrees/p-unp (nested; 1 unpushed commits)" <<<"$out" \
  && grep -q "^keep $W/pr-architect (orphaned; contains kept worktree $W/pr-architect/.claude/worktrees/p-unp)" <<<"$out" && ok || bad "an unpushed nested worktree keeps its parent: $out"
grep -q "^would remove $S (nested, branch s-done, 2M)" <<<"$out" && grep -qE "^would remove $W/spec-reviewer \(orphaned, spec-reviewer, [0-9]+K\)" <<<"$out" \
  && ok || bad "the parent's size must exclude its nested worktree: $out"
out=$($WT prune --yes --nested 2>&1)
[ -d "$W/pr-architect/.claude/worktrees/p-unp" ] && [ -d "$W/pr-architect" ] && [ ! -d "$W/spec-reviewer" ] && ok || bad "--yes --nested: $out"
c=$(grep -n "^removed $S " <<<"$out" | cut -d: -f1); p=$(grep -n "^removed $W/spec-reviewer " <<<"$out" | cut -d: -f1)
[ -n "$c" ] && [ -n "$p" ] && [ "$c" -lt "$p" ] && ok || bad "the nested worktree must be removed before its parent: $out"
! G "$R" worktree list --porcelain | grep -q s-done && ok || bad "the nested worktree must be removed by git, not deleted with its parent"

# ---- ls fetches first: a branch deleted on the remote shows gone at once (--no-fetch shows the last fetch)
G "$R" worktree add -q -b t-late "$W/t-late"; commit "$W/t-late" l l.txt; G "$W/t-late" push -q -u origin t-late
git --git-dir="$R.git" branch -q -D t-late
[ "$(cls "$($WT ls --tsv --no-pr --no-fetch)" "$W/t-late")" = active ] && ok || bad "--no-fetch must not fetch"
[ "$(cls "$($WT ls --tsv --no-pr)" "$W/t-late")" = gone ] && ok || bad "ls must fetch and show a branch deleted on the remote as gone"

# ---- the fleet command routes wt and worktree here
[ "$(bin/fleet wt ls --tsv | grep -c .)" = "$($WT ls --tsv | grep -c .)" ] && bin/fleet worktree summary >/dev/null && ok || bad "fleet wt / fleet worktree"
echo "wt: $pass passed, $fail failed"
[ $fail -eq 0 ]
