#!/usr/bin/env bash
# test/tmux-isolation.sh: prove a test run cannot see or kill the live tmux server's sessions (Incident 2026-10-24).
# A fake `tmux` first on PATH keeps per-socket state in a temp dir and NEVER starts or contacts a real tmux server,
# so even a regression cannot touch a live fleet. The "default" socket holds decoy fleet-* sessions (the live fleet).
# Cases: (A) FLEET_TMUX=private: down, send, clear-heavy, handoff, capacity, scale stop and fleet-up (crash 1) pass
# the private socket on every call and leave the decoys alone; (B) fleet-up passes -e FLEET_TMUX to peers and the
# socket to the nested attach; (C) self-guard: the caller's own session is never killed, and is reported;
# (D) inside a private server with no FLEET_TMUX, calls go to that server (-S), not the default one;
# (E) no tmux context at all: the default server, unchanged; (H) fleet-up with no CLAUDE_* set (Cursor); (I) fleet-up reports
# the peers' CLI and its source; (J) fleet-up passes FLEET_USER to peers, (J2) and the tracker override; (K) session names carry
# FLEET_PROFILE (fleet-<p>-<peer>, fleet-<p>, tagged @fleet-profile), two profiles' fleets coexist, state goes to ~/.fleet-state/<p>;
# (L) the board: fleet-up creates $FLEET_STATE/backlog, gives peers BACKLOG_CWD and --mcp-config, starts fleet-<p>-board (tagged,
# no role, never a peer, left alone when it runs), fleet-down stops only its own, fleet-board starts it with the fleet down,
# fleet-capacity reads assignments from the board (a fake backlog CLI with fixture JSON) and falls back without one; (M) exact targets: with fleet-engineer gone, nothing for "engineer" reaches fleet-engineer-2,
# and no script relies on tmux's prefix match; (N) fleet-spinup (= fleet-scale add) peers get the board and the tags;
# (O) fleet ls and fleet attach (bin/fleet) against the fake tmux; (G) clean.sh (crash 2); (F) every script that runs tmux sources lib/tmux.sh.
# Touches only a temp directory (removed on exit). Usage: tmux-isolation.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
fail=0; pass=0
ok() { pass=$((pass+1)); }
bad() { echo "FAIL: $*"; fail=$((fail+1)); }
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
export FLEET_WT_CACHE="$t/wtcache" FLEET_WT_LOCK_DIR="$t/wtlock" FLEET_HOME="$t/nohome"   # worktree scans: never the real ~/.fleet-state
mkdir -p "$t/bin" "$t/srv/default" "$t/srv/private" "$t/sock" "$t/repo"
: > "$t/calls.log"; : > "$t/violations.log"
export FAKE="$t"

cat > "$t/bin/tmux" <<'STUB'
#!/usr/bin/env bash
# fake tmux: sessions are files under $FAKE/srv/<socket>/. -L <name> or -S <path> (key = basename); no flag = default.
# Session user options (@fleet-role, @fleet-profile …) are files $FAKE/srv/<socket>/.opt/<session>.<option>.
# Targets work like real tmux: -t =<name>:[window] names exactly that session; a bare -t <name> falls back to a prefix match
# when no session is named exactly <name>, and every such fallback is logged in $FAKE/prefix.log (the fleet must never rely on it).
sock=default; path="$FAKE/sock/default"
case "${1:-}" in
  -L) sock=$2; path="$FAKE/sock/$2"; shift 2 ;;
  -S) sock=$(basename "$2"); path=$2; shift 2 ;;
esac
d="$FAKE/srv/$sock"; echo "$sock $*" >> "$FAKE/calls.log"
[ "$sock" = default ] && [ -n "${FAKE_REQUIRE_FLAG:-}" ] && echo "tmux without socket flag: $*" >> "$FAKE/violations.log"
cmd=${1:-}; shift || true
# tg <target>: the session a -t target names (empty and status 1 when none): =x: or =x exactly, x exactly, else (logged) the
# first session whose name starts with x
tg() { local x=$1; case "$x" in %*) echo "${FAKE_OWN:-}"; return ;; esac; x=${x%%:*}
  case "$x" in =*) [ -e "$d/${x#=}" ] && echo "${x#=}" ;; *) [ -e "$d/$x" ] && { echo "$x"; return; }
    for f in "$d/$x"*; do case "$f" in *.keys) continue ;; esac; [ -e "$f" ] && { echo "$cmd -t $x -> $(basename "$f")" >> "$FAKE/prefix.log"; basename "$f"; return; }; done; return 1 ;; esac; }
T=; prev=; for a in "$@"; do [ "$prev" = -t ] && T=$a; prev=$a; done   # the -t argument, wherever it is
case "$cmd" in
  ls) fmt='#{session_name}'; [ "${1:-}" = -F ] && fmt=$2   # the format's #{session_name} and #{@option} fields are filled in
      for f in "$d"/*; do case "$f" in *.keys) continue ;; esac; [ -e "$f" ] || continue; n=$(basename "$f"); out=${fmt//'#{session_name}'/$n}
        for o in "$d/.opt/$n".@*; do [ -e "$o" ] || continue; k=${o##*/"$n".}; out=${out//"#{$k}"/$(cat "$o")}; done
        sed -E 's/#\{@[a-z-]+\}//g' <<<"$out"; done; exit 0 ;;
  kill-session) n=$(tg "${T:?}") || exit 1; rm -f "$d/$n" "$d/.opt/$n".@* ;;
  set-option) o=; for a in "$@"; do [[ "$a" == @* ]] && o=$a; done; [ -n "$o" ] || exit 0
      n=$(tg "${T:?}") || exit 1; mkdir -p "$d/.opt"; printf '%s' "${@: -1}" > "$d/.opt/$n.$o" ;;
  show-options) n=$(tg "${T:?}") || exit 0; cat "$d/.opt/$n.${*: -1}" 2>/dev/null; exit 0 ;;
  has-session) tg "${T:?}" >/dev/null ;;
  capture-pane) n=$(tg "${T:?}") || exit 1; echo "${FAKE_PANE:-idle}" ;;
  send-keys) n=$(tg "${T:?}") || exit 1; echo "$*" >> "$d/$n.keys" ;;
  display) case "$*" in *socket_path*) echo "$path" ;; *session_name*) echo "${FAKE_OWN:-}" ;;
      *) [ -z "$T" ] || tg "$T" >/dev/null || exit 1; echo "%1" ;; esac ;;
  new-session) printf '%s\n' "${@: -1}" >> "$FAKE/panecmd.log"   # the pane's command, as tmux hands it to default-shell
      while [ $# -gt 0 ]; do [ "$1" = -s ] && { : > "$d/$2"; rm -f "$d/.opt/$2".@*; }; shift; done ;;
  split-window) printf '%s\n' "${@: -1}" >> "$FAKE/panecmd.log" ;;
  *) exit 0 ;;
esac
STUB
# fake backlog CLI: logs "<cwd>|<BACKLOG_CWD>|<args>", answers --version with the pin, init writes a config like the real one,
# task/decision list print the fixture JSON in $BACKLOG_CWD/backlog (empty lists without one)
cat > "$t/bin/backlog" <<'STUB'
#!/usr/bin/env bash
echo "$PWD|${BACKLOG_CWD:-}|$*" >> "$FAKE/backlog.log"
case "${1:-}" in
  --version) echo "${FAKE_BACKLOG_VERSION:?}" ;;
  init) mkdir -p backlog/tasks; printf 'statuses: ["To Do", "In Progress", "Done"]\ndefault_status: "To Do"\n' > backlog/config.yml ;;
  task) cat "$BACKLOG_CWD/backlog/fixture-tasks.json" 2>/dev/null || echo '{"tasks":[]}' ;;
  decision) cat "$BACKLOG_CWD/backlog/fixture-decisions.json" 2>/dev/null || echo '{"decisions":[]}' ;;
esac
STUB
FAKE_BACKLOG_VERSION=$(sed -n 's/^FLEET_BACKLOG_VERSION=//p' skills/fleet/scripts/lib/backlog.sh); export FAKE_BACKLOG_VERSION
printf '#!/bin/sh\necho "$*" >> "$FAKE/open.log"\n' > "$t/bin/open"
printf '#!/bin/sh\nexit 0\n' > "$t/bin/sleep"; chmod +x "$t/bin/tmux" "$t/bin/sleep" "$t/bin/backlog" "$t/bin/open"
export PATH="$t/bin:$PATH"

git -C "$t/repo" init -q -b main; git -C "$t/repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
export FLEET_REPO="$t/repo" FLEET_BASE=main FLEET_STATE="$t/state" FLEET_CLI=claude; mkdir -p "$t/state"; echo handoff > "$t/state/handoff.md"
live() { for s in fleet fleet-engineer fleet-project-manager; do : > "$t/srv/default/$s"; done; }   # the live fleet (decoys)
# a running session as fleet-up leaves it: sess <socket> <session> [role] [profile]
sess() { local d="$t/srv/$1"; mkdir -p "$d/.opt"; : > "$d/$2"; rm -f "$d/.opt/$2".@*
  [ -z "${3:-}" ] || printf '%s' "$3" > "$d/.opt/$2.@fleet-role"; printf '%s' "${4:-}" > "$d/.opt/$2.@fleet-profile"; }
priv() { rm -rf "$t/srv/private"/* "$t/srv/private/.opt"; sess private fleet; sess private fleet-engineer engineer; sess private fleet-designer designer; }
reset() { : > "$t/calls.log"; : > "$t/violations.log"; rm -f "$t/srv/default"/*; live; priv; }
default_intact() { [ "$(ls "$t/srv/default" | wc -l | tr -d ' ')" = 3 ] && ! ls "$t/srv/default"/*.keys >/dev/null 2>&1; }
S=skills/fleet/scripts

# (A) FLEET_TMUX=private, outside tmux
reset; export FLEET_TMUX=private; unset TMUX TMUX_PANE FAKE_OWN 2>/dev/null || true; export FAKE_REQUIRE_FLAG=1
$S/fleet-send -i engineer >/dev/null 2>&1 || true
$S/fleet-send hello engineer >/dev/null 2>&1 || true
$S/fleet-clear-heavy -n >/dev/null 2>&1 || true
skills/fleet-capacity/scripts/fleet-capacity >/dev/null 2>&1 || true
skills/fleet-scale/scripts/fleet-scale remove designer >/dev/null 2>&1 || true
$S/fleet-up engineer >/dev/null 2>&1 || bad "fleet-up failed against the private socket"
TMUX_PANE="" $S/fleet-handoff >/dev/null 2>&1 || true
[ -s "$t/calls.log" ] && ok || bad "no tmux call was made, the test proved nothing"
[ ! -s "$t/violations.log" ] && ok || bad "a call reached the default server: $(cat "$t/violations.log")"
! grep -q '^default ' "$t/calls.log" && ok || bad "default socket used: $(grep '^default ' "$t/calls.log" | head -3)"
default_intact && ok || bad "default server changed: $(ls "$t/srv/default")"
[ ! -e "$t/srv/private/fleet-designer" ] && ok || bad "fleet-scale remove did not stop the private peer"
[ -e "$t/srv/private/fleet-engineer" ] && ok || bad "fleet-up did not start fleet-engineer on the private socket"
# (B) fleet-up wiring
grep -qE 'new-session -d -e FLEET_TMUX=private (-e FLEET_USER=[^-]* )?(-e FLEET_STATE=[^ ]* )?(-e BACKLOG_CWD=[^ ]* )?-s fleet-engineer' "$t/calls.log" && ok || bad "peer not started with -e FLEET_TMUX"
grep -q "attach -t '=fleet-engineer:'" "$t/calls.log" && grep -q "TMUX= tmux -L private attach" "$t/calls.log" && ok || bad "nested attach does not name the socket"
# the view's pane commands run through tmux's default-shell: zsh (the macOS default) and sh must both hand tmux the exact
# target, not expand "=fleet-engineer:" as =cmd (the view then died at once)
for sh in zsh sh; do
  command -v $sh >/dev/null || continue
  : > "$t/panecmd.log"; : > "$t/calls.log"; $S/fleet-view >/dev/null 2>&1 || true
  grep 'attach -t' "$t/panecmd.log" | while IFS= read -r c; do if [ $sh = zsh ]; then zsh -fc "$c"; else sh -c "$c"; fi; done 2>"$t/sh.err" || true
  grep -qE '^private attach -t =fleet-(engineer|designer):$' "$t/calls.log" && [ ! -s "$t/sh.err" ] && ok || bad "$sh mangles the view's attach command: $(cat "$t/sh.err") $(cat "$t/panecmd.log")"
done
# (H) no CLAUDE_*/AI_AGENT in the environment (Cursor's agent, a plain shell): fleet-up still starts peers
reset; noclaude=$(env | grep -oE '^(CLAUDE[A-Z_]*|AI_AGENT)=' | tr -d = | sed 's/^/-u /' | tr '\n' ' ' || true)
env $noclaude $S/fleet-up engineer >/dev/null 2>&1 && [ -e "$t/srv/private/fleet-engineer" ] && ok || bad "fleet-up fails with no CLAUDE_* in the environment"
# (I) fleet-up says which CLI peers run and where that came from: a profile's FLEET_CLI, unless the environment overrides it
mkdir -p "$t/profiles"; echo FLEET_CLI=agent > "$t/profiles/p.env"
reset; out=$(env -u FLEET_CLI FLEET_USER_PROFILES_DIR="$t/profiles" FLEET_PROFILE=p $S/fleet-up engineer 2>&1) || true
echo "$out" | grep -q 'peers run agent (profile p)' && ok || bad "fleet-up did not report the profile's CLI: $out"
reset; out=$(FLEET_USER_PROFILES_DIR="$t/profiles" FLEET_PROFILE=p $S/fleet-up engineer 2>&1) || true
echo "$out" | grep -q 'peers run claude (environment)' && ok || bad "fleet-up did not report the environment override: $out"
# (J) fleet-up passes FLEET_USER (who the peers work for) to every peer, spaces intact
reset; FLEET_USER="Ada Lovelace" $S/fleet-up engineer >/dev/null 2>&1 || true
grep -q "new-session -d -e FLEET_TMUX=private -e FLEET_USER=Ada Lovelace -e FLEET_STATE=$t/state -e BACKLOG_CWD=$t/state -s fleet-engineer" "$t/calls.log" && ok || bad "peer not started with -e FLEET_USER: $(grep new-session "$t/calls.log" | tail -1)"
# (J2) fleet-up passes the tracker override (rule 9) to every peer, and nothing when it is unset
reset; $S/fleet-down >/dev/null 2>&1 || true
reset; FLEET_USER="Ada Lovelace" FLEET_TRACKER_PROJECT=none $S/fleet-up engineer >/dev/null 2>&1 || true
grep -q "new-session -d -e FLEET_TMUX=private -e FLEET_USER=Ada Lovelace -e FLEET_STATE=$t/state -e BACKLOG_CWD=$t/state -e FLEET_TRACKER_PROJECT=none -s fleet-engineer" "$t/calls.log" && ok || bad "peer not started with -e FLEET_TRACKER_PROJECT: $(grep new-session "$t/calls.log" | tail -1)"
grep -q 'FLEET_TRACKER_SITE' "$t/calls.log" && bad "unset FLEET_TRACKER_SITE was passed" || ok
reset; $S/fleet-down >/dev/null 2>&1 || true
[ -z "$(ls "$t/srv/private")" ] && ok || bad "fleet-down left private sessions: $(ls "$t/srv/private")"
default_intact && ok || bad "fleet-down touched the default server"

# (C) self-guard: inside a peer, fleet-up and fleet-down refuse; with FLEET_ALLOW_IN_PEER=1 the caller's own session survives
# and is reported (FLEET_TMUX private, the caller sits in private)
reset; export FLEET_TMUX=private TMUX="$t/sock/private,1,0" TMUX_PANE=%1 FAKE_OWN=fleet-engineer
# a peer never starts or stops the fleet (Incident 2026-10-28: a peer ran fleet-up and killed its team)
out=$($S/fleet-down 2>&1) && bad "fleet-down ran inside a peer session" || ok
echo "$out" | grep -q 'refused: this runs inside peer session fleet-engineer' && ok || bad "fleet-down did not say why: $out"
[ -e "$t/srv/private/fleet-designer" ] && ok || bad "fleet-down from a peer killed another peer"
$S/fleet-up designer >/dev/null 2>&1 && bad "fleet-up ran inside a peer session" || ok
[ -e "$t/srv/private/fleet-designer" ] && ok || bad "fleet-up from a peer killed another peer"
# FLEET_ALLOW_IN_PEER=1 (the user, on purpose): the caller's own session survives and is reported, the others go
out=$(FLEET_ALLOW_IN_PEER=1 $S/fleet-down 2>&1) || true
[ -e "$t/srv/private/fleet-engineer" ] && ok || bad "fleet-down killed the session it runs in"
echo "$out" | grep -q 'skipped fleet-engineer' && ok || bad "fleet-down did not report the skipped session: $out"
[ ! -e "$t/srv/private/fleet-designer" ] && ok || bad "fleet-down did not kill the other peers"
reset; FLEET_ALLOW_IN_PEER=1 $S/fleet-up designer >/dev/null 2>&1 || true
[ -e "$t/srv/private/fleet-engineer" ] && ok || bad "fleet-up killed the session it runs in"

# (D) inside a private server, no FLEET_TMUX: the same server (-S), never the default one
reset; unset FLEET_TMUX; export TMUX="$t/sock/private,1,0" TMUX_PANE=%1 FAKE_OWN=fleet-engineer
$S/fleet-down >/dev/null 2>&1 || true
$S/fleet-send -i designer >/dev/null 2>&1 || true
$S/fleet-up designer >/dev/null 2>&1 || true
! grep -q '^default ' "$t/calls.log" && ok || bad "inside a private server a call reached the default one: $(grep '^default ' "$t/calls.log" | head -3)"
grep -q '^private ' "$t/calls.log" && ok || bad "inside a private server no call reached it"
default_intact && ok || bad "default server changed from inside a private one"

# (E) no tmux context: the default server, as before
reset; unset FLEET_TMUX TMUX TMUX_PANE FAKE_OWN FAKE_REQUIRE_FLAG
$S/fleet-send -i engineer >/dev/null 2>&1 || true
grep -q '^default ' "$t/calls.log" && ok || bad "with no tmux context scripts should use the default server"

# (K) session names carry the profile: FLEET_PROFILE=a -> fleet-a-<peer> and fleet-a, each tagged @fleet-profile=a; two
# profiles' fleets coexist with the unprofiled one (fleet, fleet-*), each command reaches only its own fleet, a peer without
# FLEET_PROFILE targets its own fleet (from its session's tag), and the state goes to ~/.fleet-state/<profile>
P="$t/userprofiles"; mkdir -p "$P"; for n in a b isnadi; do echo FLEET_CLI=claude > "$P/$n.env"; done; export FLEET_USER_PROFILES_DIR="$P"
has() { [ -e "$t/srv/private/$1" ]; }
reset; export FLEET_TMUX=private FAKE_REQUIRE_FLAG=1
FLEET_PROFILE=a $S/fleet-up engineer >/dev/null 2>&1 || bad "fleet-up with FLEET_PROFILE=a failed"
has fleet-a-engineer && has fleet-a && ok || bad "profile a: no fleet-a-engineer / fleet-a: $(ls "$t/srv/private")"
! has a-fleet-engineer && has fleet-engineer && has fleet && ok || bad "profile a touched or misnamed the unprofiled fleet: $(ls "$t/srv/private")"
[ "$(cat "$t/srv/private/.opt/fleet-a-engineer.@fleet-profile")" = a ] && [ "$(cat "$t/srv/private/.opt/fleet-a.@fleet-profile")" = a ] && ok || bad "fleet-a sessions not tagged @fleet-profile=a"
grep -q 'new-session -d -e FLEET_TMUX=private -e FLEET_PROFILE=a .*-s fleet-a-engineer ' "$t/calls.log" && ok || bad "peer not started with -e FLEET_PROFILE: $(grep new-session "$t/calls.log" | head -1)"
grep -q 'new-session -d -s fleet-a -n peers' "$t/calls.log" && grep -q "attach -t '=fleet-a-engineer:'" "$t/calls.log" && ok || bad "view fleet-a does not attach fleet-a-engineer"
FLEET_PROFILE=b $S/fleet-up engineer designer >/dev/null 2>&1 || bad "fleet-up with FLEET_PROFILE=b failed"
has fleet-b-engineer && has fleet-b-designer && has fleet-b && has fleet-a-engineer && has fleet-a && ok || bad "profiles a and b do not coexist: $(ls "$t/srv/private")"
rm -f "$t/srv/private"/*.keys; FLEET_PROFILE=b $S/fleet-send hello >/dev/null 2>&1 || true
has fleet-b-engineer.keys && has fleet-b-designer.keys && ! has fleet-a-engineer.keys && ! has fleet-engineer.keys && ok || bad "fleet-send for b reached another fleet: $(ls "$t/srv/private")"
rm -f "$t/srv/private"/*.keys; $S/fleet-send hello >/dev/null 2>&1 || true
has fleet-engineer.keys && has fleet-designer.keys && ! has fleet-a-engineer.keys && ! has fleet-b-engineer.keys && ok || bad "unprofiled fleet-send reached a profile's fleet: $(ls "$t/srv/private")"
[ "$(FLEET_PROFILE=b skills/fleet-capacity/scripts/fleet-capacity 2>&1 | grep -cE '^(engineer|designer) ')" = 2 ] && ok || bad "fleet-capacity for b did not list exactly b's two peers"
sess private fleet-isnadi-bot-engineer engineer isnadi-bot; sess private fleet-isnadi-bot "" isnadi-bot
FLEET_PROFILE=isnadi $S/fleet-down >/dev/null 2>&1 || true
has fleet-isnadi-bot-engineer && has fleet-isnadi-bot && ok || bad "fleet-down for isnadi killed isnadi-bot's sessions"
FLEET_PROFILE=a $S/fleet-down >/dev/null 2>&1 || true
! has fleet-a-engineer && ! has fleet-a && ok || bad "fleet-down for a left: $(ls "$t/srv/private")"
has fleet-b-engineer && has fleet-b-designer && has fleet-b && has fleet-engineer && has fleet && ok || bad "fleet-down for a stopped another fleet: $(ls "$t/srv/private")"
# no profile: fleet-down stops fleet + its own fleet-* peers only, never b's or isnadi-bot's
$S/fleet-down >/dev/null 2>&1 || true
! has fleet-engineer && ! has fleet && has fleet-b-engineer && has fleet-b && has fleet-isnadi-bot-engineer && ok || bad "unprofiled fleet-down: $(ls "$t/srv/private")"
# inside fleet-b-engineer with no FLEET_PROFILE: the profile comes from the session's tag, so fleet-send hits b's peers;
# fleet-down refuses (a peer), and fleet-view rebuilds fleet-b
rm -f "$t/srv/private"/*.keys; sess private fleet-engineer engineer
out=$(env -u FLEET_PROFILE TMUX="$t/sock/private,1,0" TMUX_PANE=%1 FAKE_OWN=fleet-b-engineer $S/fleet-send -i 2>&1) || true
has fleet-b-designer.keys && ! has fleet-engineer.keys && ok || bad "fleet-send inside fleet-b-engineer missed b's fleet: $out $(ls "$t/srv/private")"
out=$(env -u FLEET_PROFILE TMUX="$t/sock/private,1,0" TMUX_PANE=%1 FAKE_OWN=fleet-b-engineer $S/fleet-down 2>&1) && bad "fleet-down ran inside fleet-b-engineer" || ok
echo "$out" | grep -q 'refused: this runs inside peer session fleet-b-engineer' && ok || bad "fleet-down inside fleet-b-engineer did not refuse: $out"
out=$(env -u FLEET_PROFILE TMUX="$t/sock/private,1,0" TMUX_PANE=%1 FAKE_OWN=fleet-b-engineer $S/fleet-view 2>&1) || true
echo "$out" | grep -q 'fleet view fleet-b: 2 peers' && ok || bad "fleet-view inside fleet-b-engineer did not rebuild fleet-b: $out"
rm -f "$t/srv/private"/*.keys   # from the user's view fleet-b: the profile comes from the view's tag, and the view is no peer
env -u FLEET_PROFILE TMUX="$t/sock/private,1,0" TMUX_PANE=%1 FAKE_OWN=fleet-b $S/fleet-send -i engineer >/dev/null 2>&1 || true
has fleet-b-engineer.keys && ! has fleet-engineer.keys && ok || bad "fleet-send from the fleet-b view missed fleet-b-engineer"
out=$(env -u FLEET_PROFILE TMUX="$t/sock/private,1,0" TMUX_PANE=%1 FAKE_OWN=fleet-b $S/fleet-down 2>&1) || true
echo "$out" | grep -q refused && bad "fleet-down refused in the user's view fleet-b: $out" || ok
# state: with a profile and no FLEET_STATE, ~/.fleet-state/<profile>, created and passed to every peer
reset; out=$(env -u FLEET_STATE HOME="$t/home" FLEET_PROFILE=a $S/fleet-up engineer 2>&1) || true
[ -d "$t/home/.fleet-state/a" ] && grep -q "new-session .*-e FLEET_STATE=$t/home/.fleet-state/a .*-s fleet-a-engineer " "$t/calls.log" && ok || bad "fleet-up did not use ~/.fleet-state/a: $out $(grep new-session "$t/calls.log" | head -1)"
reset; env -u FLEET_STATE HOME="$t/home" $S/fleet-up engineer >/dev/null 2>&1 || true
grep -q "new-session .*-e FLEET_STATE=$t/home/.fleet-state -e BACKLOG_CWD=$t/home/.fleet-state -s fleet-engineer " "$t/calls.log" && ok || bad "unprofiled fleet-up did not keep ~/.fleet-state"
[ ! -s "$t/violations.log" ] && default_intact && ok || bad "profile runs reached the default server"
unset FLEET_USER_PROFILES_DIR FLEET_TMUX FAKE_REQUIRE_FLAG

# (L) the board. Profile a: fleet-up creates the board with the five columns in a's state, starts fleet-a-board on a's port with
# no browser tab, tags it a and gives it no role; peers get BACKLOG_CWD and --mcp-config <state>/backlog-mcp.json
PORT_A=$(env FLEET_PROFILE=a bash -c 'source skills/fleet/scripts/lib/tmux.sh; source skills/fleet/scripts/lib/backlog.sh; fleet_board_port')
P="$t/userprofiles"; export FLEET_USER_PROFILES_DIR="$P"
reset; : > "$t/backlog.log"; export FLEET_TMUX=private FAKE_REQUIRE_FLAG=1; SA="$t/state-a"; SB="$t/state-b"
FLEET_PROFILE=a FLEET_STATE="$SA" $S/fleet-up engineer > "$t/up.out" 2>&1 || bad "fleet-up with a board failed: $(cat "$t/up.out")"
grep -q '^statuses: \["Backlog", "Next", "In Progress", "Review", "Done"\]' "$SA/backlog/config.yml" && grep -q '^default_status: "Backlog"' "$SA/backlog/config.yml" && ok || bad "board not created with the five columns: $(cat "$SA/backlog/config.yml" 2>/dev/null)"
grep -q "^$SA||init a --no-git --integration-mode none --auto-open-browser false --check-branches false --include-remote false" "$t/backlog.log" && ok || bad "backlog init not run in the state folder: $(cat "$t/backlog.log")"
has fleet-a-board && [ "$(cat "$t/srv/private/.opt/fleet-a-board.@fleet-profile")" = a ] && [ ! -e "$t/srv/private/.opt/fleet-a-board.@fleet-role" ] && ok || bad "fleet-a-board not started, not tagged a, or given a role"
grep -q "new-session -d -s fleet-a-board -x 200 -y 50 -c $SA .*backlog browser --port $PORT_A --no-open" "$t/calls.log" && ok || bad "board not started on port $PORT_A in $SA: $(grep 'fleet-a-board' "$t/calls.log" | head -2)"
grep -q "new-session .*-e BACKLOG_CWD=$SA .*-s fleet-a-engineer .*--mcp-config $SA/backlog-mcp.json" "$t/calls.log" && ok || bad "peer not given BACKLOG_CWD and --mcp-config: $(grep 'new-session.*fleet-a-engineer' "$t/calls.log")"
jq -e --arg d "$SA" '.mcpServers.backlog.args == ["mcp", "start", "--cwd", $d]' "$SA/backlog-mcp.json" >/dev/null && ok || bad "backlog-mcp.json does not start the MCP server on $SA"
grep -q "board:  http://127.0.0.1:$PORT_A" "$t/up.out" && grep -q 'attach: tmux -L private attach -t fleet-a' "$t/up.out" && ok || bad "fleet-up did not print the board URL and attach line: $(tail -3 "$t/up.out")"
[ ! -s "$t/open.log" ] && ok || bad "fleet-up opened a browser tab"
[ "$(FLEET_PROFILE=a skills/fleet-capacity/scripts/fleet-capacity | grep -c 'board ')" = 0 ] && ok || bad "fleet-capacity listed the board as a peer"
rm -f "$t/srv/private"/*.keys; FLEET_PROFILE=a $S/fleet-send hello >/dev/null 2>&1 || true
! has fleet-a-board.keys && has fleet-a-engineer.keys && ok || bad "fleet-send typed into the board session"
FLEET_PROFILE=a FLEET_STATE="$SA" $S/fleet-up engineer >/dev/null 2>&1 || true
[ "$(grep -c 'new-session -d -s fleet-a-board' "$t/calls.log")" = 1 ] && ok || bad "a second fleet-up restarted the running board"
# with the view gone, a plain -t fleet-a would prefix-match fleet-a-board: fleet-up and fleet-view must leave the board alone
rm -f "$t/srv/private/fleet-a" "$t/srv/private/.opt/fleet-a".@*; FLEET_PROFILE=a FLEET_STATE="$SA" $S/fleet-up engineer >/dev/null 2>&1 || true
has fleet-a-board && [ "$(grep -c 'new-session -d -s fleet-a-board' "$t/calls.log")" = 1 ] && ok || bad "fleet-up with no view killed or restarted the board"
# profile b's board runs too; fleet-down for a stops a's board only
FLEET_PROFILE=b FLEET_STATE="$SB" $S/fleet-up engineer >/dev/null 2>&1 || true
has fleet-b-board && ok || bad "profile b has no board"
FLEET_PROFILE=a $S/fleet-down >/dev/null 2>&1 || true
! has fleet-a-board && has fleet-b-board && ok || bad "fleet-down for a: a's board left or b's stopped: $(ls "$t/srv/private")"
[ -f "$SA/backlog/config.yml" ] && ok || bad "fleet-down removed the board's files"
# fleet-board with the fleet down: starts fleet-a-board again, prints the URL, opens it; --no-open opens nothing
: > "$t/open.log"; out=$(FLEET_PROFILE=a FLEET_STATE="$SA" $S/fleet-board 2>&1) || bad "fleet-board failed: $out"
has fleet-a-board && echo "$out" | grep -q "board: http://127.0.0.1:$PORT_A" && grep -q "http://127.0.0.1:$PORT_A" "$t/open.log" && ok || bad "fleet-board did not start, print and open the board: $out"
: > "$t/open.log"; FLEET_PROFILE=a FLEET_STATE="$SA" $S/fleet-board --no-open >/dev/null 2>&1 || true
[ ! -s "$t/open.log" ] && ok || bad "fleet-board --no-open opened a tab"
out=$(FLEET_BOARD_PORT=7001 $S/fleet-board --no-open 2>&1) || true
echo "$out" | grep -q 'board: http://127.0.0.1:7001' && ok || bad "FLEET_BOARD_PORT not used: $out"
[ "$(bash -c 'source skills/fleet/scripts/lib/tmux.sh; source skills/fleet/scripts/lib/backlog.sh; fleet_board_port')" = 6420 ] && [ "$PORT_A" != 6420 ] && ok || bad "default ports: no profile must be 6420, a must differ (a=$PORT_A)"
# no backlog CLI: fleet-up warns and starts the peers without a board
echo FLEET_CLI=claude > "$P/c.env"
reset; out=$(FLEET_BACKLOG_BIN=no-such-backlog FLEET_PROFILE=c FLEET_STATE="$t/state-c" $S/fleet-up engineer 2>&1) || true
echo "$out" | grep -q 'no backlog CLI on PATH' && has fleet-c-engineer && ! has fleet-c-board && ok || bad "fleet-up without a backlog CLI: $out"
# fleet-capacity reads the board: In Progress by assignee, unassigned Next, proposed decisions, idle peers with the waiting work
reset; sess private fleet-a-engineer engineer a; sess private fleet-a-designer designer a; sess private fleet-a-board "" a
cat > "$SA/backlog/fixture-tasks.json" <<'JSON'
{"tasks":[{"id":"TASK-1","title":"Login screen","status":"In Progress","assignees":["@engineer"]},
{"id":"TASK-2","title":"Waiting one","status":"Next","assignees":[]},{"id":"TASK-3","title":"Waiting two","status":"Next","assignees":[]},
{"id":"TASK-4","title":"Earmarked","status":"Next","assignees":["@designer"]},{"id":"TASK-5","title":"Old","status":"Done","assignees":["@designer"]}]}
JSON
echo '{"decisions":[{"id":"decision-1","status":"proposed"},{"id":"decision-2","status":"accepted"}]}' > "$SA/backlog/fixture-decisions.json"
printf '## Active Team\n| fleet-a-engineer | from-context |\n' > "$SA/fleet-context.md"
out=$(FAKE_PANE=$'done.\n❯ \n? for shortcuts' FLEET_PROFILE=a FLEET_STATE="$SA" skills/fleet-capacity/scripts/fleet-capacity 2>&1)
echo "$out" | grep -qE '^ +engineer +TASK-1 Login screen$' && echo "$out" | grep -qE '^ +designer +no In Progress task$' && ok || bad "capacity did not read assignments from the board: $out"
echo "$out" | grep -q 'Waiting: 2 unassigned in Next · 1 decisions proposed' && echo "$out" | grep -q 'idle: designer, engineer · 2 tasks waiting in Next' && ok || bad "capacity waiting/idle lines wrong: $out"
echo "$out" | grep -q 'Total: 2 peers' && ! echo "$out" | grep -qE '^board ' && ! echo "$out" | grep -q from-context && ok || bad "capacity counted the board or read fleet-context.md: $out"
rm -rf "$SA/backlog"; out=$(FLEET_PROFILE=a FLEET_STATE="$SA" skills/fleet-capacity/scripts/fleet-capacity 2>&1)
echo "$out" | grep -q 'from-context' && ! echo "$out" | grep -q '^Board' && ok || bad "capacity without a board did not fall back to fleet-context.md: $out"
[ ! -s "$t/violations.log" ] && default_intact && ok || bad "board runs reached the default server"
unset FLEET_USER_PROFILES_DIR FLEET_TMUX FAKE_REQUIRE_FLAG

# (M) exact targets: fleet-engineer is gone and fleet-engineer-2 runs. Nothing addressed to "engineer" may reach fleet-engineer-2
# (a bare -t fleet-engineer would prefix-match it); every script gets "no session" instead
reset; export FLEET_TMUX=private FAKE_REQUIRE_FLAG=1; unset TMUX TMUX_PANE FAKE_OWN
rm -f "$t/srv/private/fleet-engineer" "$t/srv/private/.opt/fleet-engineer".@*; sess private fleet-engineer-2 engineer; : > "$t/prefix.log"
out=$($S/fleet-send hello engineer 2>&1) || true; echo "$out" | grep -q 'engineer: no session fleet-engineer' && ok || bad "fleet-send to a gone engineer did not say so: $out"
$S/fleet-send -i engineer >/dev/null 2>&1 || true
out=$(skills/fleet-scale/scripts/fleet-scale remove engineer 2>&1) || true; echo "$out" | grep -q 'no session fleet-engineer' && ok || bad "fleet-scale remove engineer did not refuse: $out"
echo state > "$t/state/engineer-state.md"; out=$(skills/fleet-handoff/scripts/fleet-handoff engineer 2>&1) || true
echo "$out" | grep -q 'no tmux session fleet-engineer' && ok || bad "fleet-handoff engineer did not refuse: $out"
$S/fleet-peek engineer >/dev/null 2>&1 || true
out=$(skills/fleet-capacity/scripts/fleet-capacity 2>&1) || true
echo "$out" | grep -qE '^engineer-2 ' && ! echo "$out" | grep -qE '^engineer ' && ok || bad "fleet-capacity: $out"
has fleet-engineer-2 && [ ! -e "$t/srv/private/fleet-engineer-2.keys" ] && ok || bad "a script for engineer reached fleet-engineer-2: $(cat "$t/srv/private/fleet-engineer-2.keys" 2>/dev/null) $(ls "$t/srv/private")"
[ ! -s "$t/prefix.log" ] && ok || bad "a script relied on tmux's prefix match: $(cat "$t/prefix.log")"
# (N) spinup = fleet-scale add: the new peer gets the board (BACKLOG_CWD, --mcp-config), its role, CLI and profile tags, and the
# fleet-<profile>-<peer> name, so capacity and fleet-down treat it like any other peer
P="$t/userprofiles"; export FLEET_USER_PROFILES_DIR="$P"; reset; : > "$t/prefix.log"; SN="$t/state-n"
sess private fleet-a-engineer engineer a
FLEET_PROFILE=a FLEET_STATE="$SN" skills/fleet-scale/scripts/fleet-scale add engineer >/dev/null 2>&1 || bad "fleet-scale add engineer failed"
has fleet-a-engineer-1 && [ "$(cat "$t/srv/private/.opt/fleet-a-engineer-1.@fleet-role")" = engineer ] \
  && [ "$(cat "$t/srv/private/.opt/fleet-a-engineer-1.@fleet-cli")" = claude ] && [ "$(cat "$t/srv/private/.opt/fleet-a-engineer-1.@fleet-profile")" = a ] \
  && ok || bad "spun-up peer not named fleet-a-engineer-1 or not tagged: $(ls "$t/srv/private")"
grep -q "new-session .*-e BACKLOG_CWD=$SN .*-s fleet-a-engineer-1 .*--mcp-config $SN/backlog-mcp.json" "$t/calls.log" && ok || bad "spun-up peer has no board: $(grep 'fleet-a-engineer-1' "$t/calls.log" | head -1)"
has fleet-a-engineer && [ "$(FLEET_PROFILE=a skills/fleet-capacity/scripts/fleet-capacity | grep -cE '^engineer(-1)? ')" = 2 ] && ok || bad "capacity does not list both engineers"
FLEET_PROFILE=a $S/fleet-down >/dev/null 2>&1 || true
! has fleet-a-engineer-1 && ! has fleet-a-engineer && ok || bad "fleet-down left the spun-up peer"
[ ! -s "$t/prefix.log" ] && [ ! -s "$t/violations.log" ] && default_intact && ok || bad "spinup relied on a prefix match or reached the default server: $(cat "$t/prefix.log")"
unset FLEET_USER_PROFILES_DIR FLEET_TMUX FAKE_REQUIRE_FLAG

# (O) fleet ls and fleet attach, through bin/fleet. ls: every fleet grouped by profile, view and board status, peers with role,
# CLI and state; never the board, a role-less session or a non-fleet session as a peer; --profile narrows it; read-only.
# attach: the view (rebuilt when gone) or one peer, exact targets, switch-client inside tmux on the same server
reset; export FLEET_TMUX=private FAKE_REQUIRE_FLAG=1 FLEET_USER_PROFILES_DIR="$t/userprofiles"; unset TMUX TMUX_PANE FAKE_OWN; : > "$t/prefix.log"; rm -rf "$t/srv/private"/* "$t/srv/private/.opt"
sess private fleet-a "" a; sess private fleet-a-engineer engineer a; printf claude > "$t/srv/private/.opt/fleet-a-engineer.@fleet-cli"
sess private fleet-a-board "" a; sess private fleet-a-tmp "" a; sess private fleet-b-designer designer b; sess private other
FK=$'done.\n❯ \n? for shortcuts'
out=$(FAKE_PANE=$FK bin/fleet ls 2>&1); : > "$t/calls.log"
echo "$out" | grep -qE '^fleet a +view fleet-a: running +board http://127.0.0.1:[0-9]+: running$' && ok || bad "fleet ls: no line for fleet a: $out"
echo "$out" | grep -qE '^  engineer +engineer +claude +idle$' && ok || bad "fleet ls: engineer row wrong: $out"
echo "$out" | grep -qE '^fleet b +view fleet-b: gone +board .*: stopped$' && echo "$out" | grep -qE '^  designer +designer ' && ok || bad "fleet ls: fleet b wrong: $out"
! echo "$out" | grep -qE '^  (board|tmp|other) ' && ok || bad "fleet ls listed the board or a non-peer session as a peer: $out"
out=$(FAKE_PANE=$FK bin/fleet --profile b ls 2>&1)
echo "$out" | grep -q '^fleet b ' && ! echo "$out" | grep -q '^fleet a ' && ok || bad "fleet --profile b ls: $out"
FAKE_PANE=$FK bin/fleet ls >/dev/null 2>&1; ! grep -qE ' (kill-session|send-keys|set-option|new-session) ' "$t/calls.log" && ok || bad "fleet ls changed something: $(grep -E 'kill|send|set-option|new-session' "$t/calls.log" | head -2)"
: > "$t/calls.log"; bin/fleet --profile a attach >/dev/null 2>&1 || true
grep -q '^private attach -t =fleet-a:$' "$t/calls.log" && ok || bad "fleet attach did not attach the view: $(tail -2 "$t/calls.log")"
: > "$t/calls.log"; bin/fleet --profile a attach engineer >/dev/null 2>&1 || true
grep -q '^private attach -t =fleet-a-engineer:$' "$t/calls.log" && ok || bad "fleet attach engineer: $(tail -2 "$t/calls.log")"
: > "$t/calls.log"; out=$(bin/fleet --profile a attach nobody 2>&1) && bad "fleet attach nobody succeeded" || ok
echo "$out" | grep -q 'no session fleet-a-nobody. Peers of fleet-a: engineer' && ! grep -qE ' (attach|switch-client) ' "$t/calls.log" && ok || bad "fleet attach nobody: $out"
: > "$t/calls.log"; TMUX="$t/sock/private,1,0" TMUX_PANE=%1 FAKE_OWN=other bin/fleet --profile a attach engineer >/dev/null 2>&1 || true
grep -q '^private switch-client -t =fleet-a-engineer:$' "$t/calls.log" && ! grep -q ' attach ' "$t/calls.log" && ok || bad "inside tmux fleet attach did not switch-client: $(tail -2 "$t/calls.log")"
rm -f "$t/srv/private/fleet-a" "$t/srv/private/.opt/fleet-a".@*; : > "$t/calls.log"; bin/fleet --profile a attach >/dev/null 2>&1 || true
has fleet-a && grep -q 'new-session -d -s fleet-a -n peers' "$t/calls.log" && grep -q '^private attach -t =fleet-a:$' "$t/calls.log" && ok || bad "fleet attach with the view gone did not rebuild it: $(cat "$t/calls.log" | tail -3)"
[ ! -s "$t/prefix.log" ] && [ ! -s "$t/violations.log" ] && default_intact && ok || bad "fleet ls/attach: prefix match or default server: $(cat "$t/prefix.log")"
# a second handoff of one peer while the first is queued (its waiter holds handoff-<peer>) is refused, nothing typed
sess private fleet-a-engineer engineer a; echo state > "$t/state/engineer-state.md"; rm -f "$t/srv/private"/*.keys
bash -c 'source skills/fleet/scripts/lib/lock.sh; fleet_lock "$1" handoff-engineer 0; /bin/sleep 3' _ "$t/state" & hw=$!; /bin/sleep 0.5
out=$(FLEET_PROFILE=a FLEET_STATE="$t/state" skills/fleet-handoff/scripts/fleet-handoff engineer 2>&1) || true
echo "$out" | grep -q 'a handoff of engineer is already queued' && ! has fleet-a-engineer.keys && ok || bad "a second handoff was not refused: $out"
kill "$hw" 2>/dev/null; wait "$hw" 2>/dev/null || true
unset FLEET_TMUX FAKE_REQUIRE_FLAG FLEET_USER_PROFILES_DIR

# (P) FLEET_CLI=opencode: the peer starts via Ori's launcher, `ori opencode`, whose --model/--reasoning-effort must come
# before the upstream flags; --auto for approval; the role load goes in as --prompt (no /rename, no typed prompt, no
# Claude-only --mcp-config/--settings); @fleet-cli is tagged opencode. The opencode model comes from the models file's
# 5th–6th columns when the role's row has them.
reset; export FLEET_TMUX=private FAKE_REQUIRE_FLAG=1; unset TMUX TMUX_PANE FAKE_OWN
: > "$t/models"; printf 'engineer sonnet low 150000 openrouter/test-model high\n' > "$t/models"
out=$(env FLEET_MODELS="$t/models" FLEET_CLI=opencode $S/fleet-up engineer 2>&1) || bad "fleet-up with FLEET_CLI=opencode failed: $out"
echo "$out" | grep -q 'peers run opencode (environment)' && ok || bad "fleet-up did not report the opencode CLI: $out"
n=$(grep -- '-s fleet-engineer ' "$t/calls.log" | grep new-session | tail -1 || true)
echo "$n" | grep -q -- 'ori opencode' && ok || bad "opencode peer not launched with ori opencode: $n"
echo "$n" | grep -q -- '--model openrouter/test-model --reasoning-effort high --auto' && ok || bad "opencode model/effort/auto flags wrong or misordered: $n"
echo "$n" | grep -q -- '--prompt' && ok || bad "opencode peer not started with the role load in --prompt: $n"
echo "$n" | grep -q -- '--mcp-config' && bad "opencode peer got the Claude-only --mcp-config: $n" || ok
[ "$(cat "$t/srv/private/.opt/fleet-engineer.@fleet-cli" 2>/dev/null)" = opencode ] && ok || bad "@fleet-cli not tagged opencode"
rm -f "$t/srv/private"/*.keys
[ ! -e "$t/srv/private/fleet-engineer.keys" ] && ok || bad "opencode peer got send-keys it should not (/rename or a typed prompt): $(cat "$t/srv/private/fleet-engineer.keys")"
# without 5th–6th columns the opencode peer gets no model flags (its default applies)
: > "$t/models"; printf 'engineer sonnet low\n' > "$t/models"
$S/fleet-down >/dev/null 2>&1 || true
out=$(env FLEET_MODELS="$t/models" FLEET_CLI=opencode $S/fleet-up engineer 2>&1) || bad "fleet-up opencode without model columns failed: $out"
n=$(grep -- '-s fleet-engineer ' "$t/calls.log" | grep new-session | tail -1 || true)
echo "$n" | grep -qE -- '--model|--reasoning-effort' && bad "opencode peer got model flags from a row without them: $n" || ok
# (P2) fleet-peek shows the opencode CLI from the pane's chrome when @fleet-cli is unset; state still reads idle
export FLEET_TMUX=private FAKE_REQUIRE_FLAG=1; unset TMUX TMUX_PANE FAKE_OWN
reset; sess private fleet-engineer engineer; : > "$t/calls.log"
FKOC=$'Done. TASK-5 is in Review.\n┃\n┃  Ask anything… "Fix a TODO"\n╹▀▀▀▀▀\n/tmp/proj  shift+tab agents  ctrl+p commands\n⊙ 1 MCP /mcps'
out=$(FAKE_PANE="$FKOC" $S/fleet-peek 2>&1) || true
echo "$out" | grep -q '^===== engineer (opencode, idle)$' && ok || bad "fleet-peek did not read the opencode CLI and idle state from the pane: $out"
unset FLEET_TMUX FAKE_REQUIRE_FLAG FLEET_MODELS

# (G) clean.sh (crash 2): --force alone never kills a session; --force --sessions kills only the private server's
# sessions, keeps the caller's own, and never deletes fleet state (a stand-in for ~/.fleet-state/fleet-context.md)
export FLEET_STATE="$t/state" FLEET_HOME="$t/nohome" FLEET_REPO="$t/notarget"; : > "$t/state/fleet-context.md"; C=dev-tasks/scripts/clean/clean.sh
reset; export FLEET_TMUX=private FAKE_REQUIRE_FLAG=1; unset TMUX TMUX_PANE FAKE_OWN
$C --force >/dev/null 2>&1 || true
! grep -q kill-session "$t/calls.log" && [ "$(ls "$t/srv/private" | wc -l | tr -d ' ')" = 3 ] && ok || bad "clean --force killed sessions without --sessions"
$C --force --sessions >/dev/null 2>&1 || true
[ -z "$(ls "$t/srv/private")" ] && ok || bad "clean --force --sessions left private sessions: $(ls "$t/srv/private")"
default_intact && [ ! -s "$t/violations.log" ] && ok || bad "clean reached the default server"
[ -e "$t/state/fleet-context.md" ] && ok || bad "clean deleted the fleet state file"
reset; export TMUX="$t/sock/private,1,0" TMUX_PANE=%1 FAKE_OWN=fleet-engineer
out=$($C --force --sessions 2>&1) || true
[ -e "$t/srv/private/fleet-engineer" ] && echo "$out" | grep -q 'keep (own)    fleet-engineer' && [ ! -e "$t/srv/private/fleet-designer" ] && ok || bad "clean killed its own session or kept others: $out"
# inside a private server, no FLEET_TMUX: clean follows $TMUX, never the default server
reset; unset FLEET_TMUX; $C --force --sessions >/dev/null 2>&1 || true
! grep -q '^default ' "$t/calls.log" && default_intact && ok || bad "clean inside a private server reached the default one"
unset FLEET_STATE FLEET_HOME FLEET_REPO TMUX TMUX_PANE FAKE_OWN FAKE_REQUIRE_FLAG

# (F) static: every script that runs tmux sources the helper (cc-send is exempt: it reads every pane by design)
while IFS= read -r f; do
  case "$f" in skills/fleet-cc-send/*|*/lib/tmux.sh) continue ;; esac
  grep -q 'lib/tmux.sh"' "$f" && ok || bad "$f runs tmux without sourcing lib/tmux.sh"
grep -q 'lib/tmux.sh' dev-tasks/scripts/clean/clean.sh && ok || bad "clean.sh does not source lib/tmux.sh"
done < <(grep -rlE '(^|[ ;&(])tmux ' skills -I | while IFS= read -r f; do head -1 "$f" | grep -q '^#!' && echo "$f"; done)
echo "tmux-isolation: $pass passed, $fail failed"
[ $fail -eq 0 ]
