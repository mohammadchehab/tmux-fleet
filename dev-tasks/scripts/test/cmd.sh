#!/usr/bin/env bash
# test/cmd.sh: the fleet command (bin/fleet) and the lock helper (skills/fleet/scripts/lib/lock.sh), without tmux, claude or the
# network: dispatch and --profile (stub scripts in a copy of the checkout), help and unknown commands, the completion script,
# install:bin / uninstall of the link, and the locks: serialised holders, fail-fast with who holds it, a stale lock taken over,
# re-entrancy only while the holder lives, and fleet-up / fleet-down / fleet-scale refusing while another holds the fleet lock.
# Touches only a temp directory (removed on exit). Usage: cmd.sh
set -euo pipefail
source "$(dirname "$0")/../lib/env.sh"
cd "$ROOT"
fail=0; pass=0
check() { if "$@" >/dev/null 2>&1; then pass=$((pass+1)); else echo "FAIL: $*"; fail=$((fail+1)); fi; }
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
export FLEET_WT_CACHE="$t/wtcache" FLEET_WT_LOCK_DIR="$t/wtlock"   # worktree scans: never the real ~/.fleet-state
unset FLEET_PROFILE FLEET_STATE FLEET_CHECKOUT FLEET_REPO FLEET_BIN TMUX TMUX_PANE; export FLEET_TMUX="cmd-$$"
# dispatch: a copy of bin/fleet in a fake checkout whose scripts print their name, args and FLEET_PROFILE; reached through a
# symlink, as task install:bin leaves it
t=$(cd "$t" && pwd -P); H="$t/home"; mkdir -p "$H/bin" "$H/skills/fleet/scripts" "$H/skills/fleet-scale/scripts" "$H/skills/fleet-board/scripts" \
  "$H/skills/fleet-capacity/scripts" "$H/dev-tasks/scripts/install" "$t/path"
cp bin/fleet "$H/bin/fleet"; ln -s "$H/bin/fleet" "$t/path/fleet"
stub() { printf '#!/usr/bin/env bash\necho "%s|$*|${FLEET_PROFILE-unset}"\n' "$(basename "$1")" > "$1"; chmod +x "$1"; }
for s in fleet-up fleet-down fleet-ls fleet-attach fleet-board fleet-send; do stub "$H/skills/fleet/scripts/$s"; done
stub "$H/skills/fleet-scale/scripts/fleet-scale"; stub "$H/skills/fleet-board/scripts/board-jira"; stub "$H/skills/fleet-capacity/scripts/fleet-capacity"
printf '#!/bin/sh\necho "task|$*"\n' > "$t/path/task"; chmod +x "$t/path/task"
f() { env PATH="$t/path:$PATH" fleet "$@"; }
check test "$(f up squad)" = "fleet-up|squad|unset"
check test "$(f --profile isnadi up squad)" = "fleet-up|squad|isnadi"
check test "$(f up --profile isnadi engineer designer)" = "fleet-up|engineer designer|isnadi"
check test "$(f --profile=x ls)" = "fleet-ls||x"
check test "$(export FLEET_PROFILE=env; f attach engineer)" = "fleet-attach|engineer|env"
check test "$(f send hello -- --profile literal)" = "fleet-send|hello -- --profile literal|unset"
check test "$(f scale add engineer)" = "fleet-scale|add engineer|unset"
check test "$(f capacity 3)" = "fleet-capacity|3|unset"
check test "$(f jira)" = "board-jira||unset"
check test "$(f install)" = "task|-t $H/Taskfile.yaml install"
check test "$(f install bin)" = "task|-t $H/Taskfile.yaml install:bin"
check test "$(f update)" = "task|-t $H/Taskfile.yaml update"
check test "$(f clean --force)" = "task|-t $H/Taskfile.yaml clean -- --force"
check bash -c '! env PATH="$1:$PATH" fleet install nope'
check bash -c 'env PATH="$1:$PATH" fleet help | grep -q "fleet \[--profile <name>\] <command>"' _ "$t/path"
check bash -c '! env PATH="$1:$PATH" fleet bogus 2>&1 | grep -q x; env PATH="$1:$PATH" fleet bogus 2>&1 | grep -q "no such command .bogus."' _ "$t/path"
check bash -c '! env PATH="$1:$PATH" fleet --profile' _ "$t/path"
check bash -c 'FLEET_CHECKOUT="$1" bin/fleet _list squads | grep -qx squad && FLEET_CHECKOUT="$1" bin/fleet _list roles | grep -qx engineer' _ "$ROOT"
mkdir -p "$t/profiles"; : > "$t/profiles/isnadi.env"
check bash -c 'FLEET_USER_PROFILES_DIR="$1" bin/fleet _list profiles | grep -qx isnadi && ! FLEET_USER_PROFILES_DIR="$1" bin/fleet _list profiles | grep -qx example' _ "$t/profiles"
# completion: valid bash, registers _fleet; zsh adds bashcompinit; it completes commands, profiles and squads
check bash -c 'bin/fleet completion bash | bash -n'
check bash -c 'bin/fleet completion zsh | head -2 | grep -q bashcompinit'
check bash -c '! bin/fleet completion fish'
# zsh with no rc files (no compinit yet) loads it and registers the completion for fleet
command -v zsh >/dev/null && check env ZDOTDIR="$t" PATH="$ROOT/bin:$PATH" zsh -fc 'eval "$(fleet completion zsh)" && (( $+_comps[fleet] ))'
comp() {  # comp <words…>: what the completion offers for the last word
  env PATH="$ROOT/bin:$PATH" FLEET_USER_PROFILES_DIR="$t/profiles" bash -c 'eval "$(fleet completion bash)"; COMP_WORDS=("$@"); COMP_CWORD=$(( $# - 1 )); _fleet; printf "%s\n" "${COMPREPLY[@]}"' _ "$@"; }
check bash -c 'grep -qx attach <<<"$1" && grep -qx -- --profile <<<"$1"' _ "$(comp fleet "")"
check bash -c 'grep -qx isnadi <<<"$1"' _ "$(comp fleet --profile "")"
check bash -c 'grep -qx squad <<<"$1" && grep -qx engineer <<<"$1"' _ "$(comp fleet up "")"
check bash -c 'grep -qx remove <<<"$1"' _ "$(comp fleet scale "")"
check bash -c 'grep -qx backlog <<<"$1"' _ "$(comp fleet install b)"
# install:bin links once, is idempotent, leaves a foreign file alone; uninstall removes only our link
export FLEET_INSTALL_LOCK_DIR="$t/installlock" FLEET_BIN="$t/localbin"
check dev-tasks/scripts/install/bin.sh
check test "$(readlink "$t/localbin/fleet")" = "$ROOT/bin/fleet"
check bash -c 'dev-tasks/scripts/install/bin.sh | grep -q "^ok "'
check bash -c 'dev-tasks/scripts/install/bin.sh | grep -q "not on PATH"'
check env CLAUDE_SKILLS="$t/none1" CURSOR_SKILLS="$t/none2" dev-tasks/scripts/install/uninstall.sh
check test ! -e "$t/localbin/fleet"
echo mine > "$t/localbin/fleet"
check bash -c '! dev-tasks/scripts/install/bin.sh'
check grep -qx mine "$t/localbin/fleet"
# locks. Two holders of one lock run one after the other, never interleaved
L=skills/fleet/scripts/lib/lock.sh; D="$t/lockdir"; : > "$t/order"
hold() { bash -c 'source "$1"; fleet_lock "$2" x 20; echo "start $3" >> "$4"; sleep 1; echo "end $3" >> "$4"' _ "$L" "$D" "$1" "$t/order"; }
hold A & hold B & wait
check bash -c '[ "$(sed -n 1p "$1" | cut -d" " -f1)$(sed -n 2p "$1" | cut -d" " -f1)$(sed -n 3p "$1" | cut -d" " -f1)$(sed -n 4p "$1" | cut -d" " -f1)" = startendstartend ]' _ "$t/order"
check test ! -e "$D/locks/x.lock"          # released on exit
# fail fast: wait 0 says who holds it
bash -c 'source "$1"; fleet_lock "$2" x 0 holder-cmd; sleep 3' _ "$L" "$D" & h=$!; sleep 0.5
out=$(bash -c 'source "$1"; fleet_lock "$2" x 0' _ "$L" "$D" 2>&1) && echo "FAIL: lock taken twice" && fail=$((fail+1)) || pass=$((pass+1))
check bash -c 'grep -q "busy: x is held by pid $2 (_ holder-cmd" <<<"$1"' _ "$out" "$h"
# the fleet scripts refuse while another process holds the fleet lock (FLEET_LOCK_WAIT=0), before touching tmux
R="$t/repo"; git init -q -b main "$R"; git -C "$R" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
S="$t/state"; bash -c 'source "$1"; fleet_lock "$2" fleet 0 fleet-up-elsewhere; sleep 4' _ "$L" "$S" & g=$!; sleep 0.5
for c in "skills/fleet/scripts/fleet-up engineer" "skills/fleet/scripts/fleet-down" "skills/fleet-scale/scripts/fleet-scale add engineer"; do
  out=$(env FLEET_STATE="$S" FLEET_REPO="$R" FLEET_LOCK_WAIT=0 $c 2>&1) && { echo "FAIL: $c ran while the fleet lock was held"; fail=$((fail+1)); } || pass=$((pass+1))
  check bash -c 'grep -q "busy: fleet is held by pid $2 (_ fleet-up-elsewhere" <<<"$1"' _ "$out" "$g"
done
wait "$h" "$g" 2>/dev/null || true
# stale: a lock whose holder is dead is taken over; an inherited FLEET_LOCKS whose holder is dead does not count as held
mkdir -p "$D/locks/y.lock"; echo 999999 > "$D/locks/y.lock/pid"
check bash -c 'source "$1"; fleet_lock "$2" y 0 && [ "$(cat "$2/locks/y.lock/pid")" = $$ ]' _ "$L" "$D"
mkdir -p "$D/locks/z.lock"; echo 999999 > "$D/locks/z.lock/pid"
check bash -c 'source "$1"; FLEET_LOCKS=" $2/locks/z.lock" fleet_lock "$2" z 0 && [ "$(cat "$2/locks/z.lock/pid")" = $$ ]' _ "$L" "$D"
# re-entrant: a child of the holder (FLEET_LOCKS exported) goes on, and does not release the parent's lock
check bash -c 'source "$1"; fleet_lock "$2" r 0; bash -c "source \"$1\"; fleet_lock \"$2\" r 0" && [ -d "$2/locks/r.lock" ]' _ "$L" "$D"
echo "cmd: $pass passed, $fail failed"
[ $fail -eq 0 ]
