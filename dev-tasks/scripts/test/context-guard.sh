#!/usr/bin/env bash
# test/context-guard.sh: fleet-context-guard on fixture transcripts, with a fake tmux (no tmux server, claude or network) and a
# stub fleet-handoff. Covers a peer under the limit (silent), over it with no state file (block JSON naming the file), the
# project-manager (handoff.md), a stale state file (still blocks), a fresh one (handoff started, a tool result does not make it
# stale), stop_hook_active (no block, miss logged), a profile's FLEET_CLEAR_LIMIT, a pane outside a fleet session (silent) and
# the PreCompact log. Touches only a temp directory (removed on exit). Usage: context-guard.sh
set -euo pipefail
source "$(dirname "$0")/../lib/env.sh"
cd "$ROOT"
fail=0; pass=0
ok() { pass=$((pass+1)); }
bad() { echo "FAIL: $*"; fail=$((fail+1)); }
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT; t=$(cd "$t" && pwd -P)
unset FLEET_REPO FLEET_TMUX FLEET_CLEAR_LIMIT
export FAKE="$t" FLEET_PROFILE=p FLEET_USER_PROFILES_DIR="$t/profiles" FLEET_PROFILES_DIR="$t/noprofiles" \
  FLEET_HANDOFF_BIN="$t/bin/fleet-handoff" TMUX="$t/sock,1,0" TMUX_PANE=%1
S="$t/state"; mkdir -p "$t/bin" "$t/profiles" "$S"; export FLEET_STATE="$S"
G=skills/fleet/scripts/fleet-context-guard

# fake tmux: the pane's session and role come from $FAKE/session and $FAKE/role
cat > "$t/bin/tmux" <<'STUB'
#!/usr/bin/env bash
case "${1:-}" in -L|-S) shift 2 ;; esac
cmd=${1:-}; shift || true
case "$cmd" in
  display) case "$*" in *session_name*) cat "$FAKE/session" ;; *socket_path*) echo "${TMUX%%,*}" ;; esac ;;
  show-options) case "${*: -1}" in @fleet-role) cat "$FAKE/role" ;; @fleet-profile) echo p ;; esac ;;
esac
STUB
printf '#!/bin/sh\necho "$*" >> "%s/handoff.calls"\n' "$t" > "$t/bin/fleet-handoff"
chmod +x "$t/bin/"*; export PATH="$t/bin:$PATH"
echo fleet-p-engineer-1 > "$t/session"; echo engineer > "$t/role"

now=$(date +%s)
iso() { date -u -r "$1" +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || date -u -d "@$1" +%Y-%m-%dT%H:%M:%S.000Z; }
# transcript <tokens>: a user message 100 s ago, an assistant reply using <tokens> (cache read), a tool result now
transcript() {
  {
    printf '{"type":"user","timestamp":"%s","message":{"role":"user","content":"do the card"}}\n' "$(iso $((now-100)))"
    printf '{"type":"assistant","timestamp":"%s","message":{"role":"assistant","usage":{"input_tokens":10,"cache_read_input_tokens":%s,"cache_creation_input_tokens":5,"output_tokens":9}}}\n' "$(iso $((now-90)))" "$1"
    printf '{"type":"user","timestamp":"%s","message":{"role":"user","content":[{"type":"tool_result","content":"ok"}]}}\n' "$(iso "$now")"
  } > "$t/transcript.jsonl"
}
hook() { printf '{"transcript_path":"%s","stop_hook_active":%s}' "$t/transcript.jsonl" "${1:-false}"; }
age() { python3 -c 'import os,sys; os.utime(sys.argv[1], (int(sys.argv[2]),) * 2)' "$1" "$2"; }
run() { hook "${1:-false}" | "$G" 2>&1; }
reset() { rm -f "$S"/* "$t/handoff.calls"; }
expect() { local name=$1 got=$2 want=$3; if [ "$got" = "$want" ]; then ok; else bad "$name: got '$got', want '$want'"; fi; }
has() { local name=$1 got=$2 want=$3; if [[ "$got" == *"$want"* ]]; then ok; else bad "$name: '$got' lacks '$want'"; fi; }

# under the limit: silent, nothing logged, no handoff
transcript 100000; reset
expect "under limit prints nothing" "$(run)" ""
expect "under limit logs nothing" "$(ls "$S")" ""

# over the limit, no state file: the block names this peer's state file
transcript 200000; reset
out=$(run)
has "block is a block decision" "$out" '"decision":"block"'
has "block names the engineer's state file" "$out" "$S/engineer-1-state.md"
has "block names the size and the limit" "$out" "Context is 200k tokens (limit 150k)"
expect "block starts no handoff" "$(cat "$t/handoff.calls" 2>/dev/null)" ""

# the project-manager is told to write handoff.md
echo fleet-p-project-manager > "$t/session"; echo project-manager > "$t/role"
has "the project-manager gets handoff.md" "$(run)" "$S/handoff.md"
echo fleet-p-engineer-1 > "$t/session"; echo engineer > "$t/role"

# a state file older than the last user message is stale: still blocks
echo "old" > "$S/engineer-1-state.md"; age "$S/engineer-1-state.md" $((now-200))
has "a stale state file still blocks" "$(run)" '"decision":"block"'
expect "a stale state file starts no handoff" "$(cat "$t/handoff.calls" 2>/dev/null)" ""

# a fresh state file (written after the user message, before the tool result): handoff started for this peer, nothing printed
echo "card, branch, next step" > "$S/engineer-1-state.md"; age "$S/engineer-1-state.md" $((now-50))
expect "fresh state prints nothing" "$(run)" ""
expect "fresh state starts the handoff for this peer" "$(cat "$t/handoff.calls")" "engineer-1"
has "the handoff is logged" "$(cat "$S/context-guard.log")" "handoff started"

# stop_hook_active with no fresh state: no block, a miss is logged
reset
expect "stop_hook_active never blocks" "$(run true)" ""
has "stop_hook_active logs a miss" "$(cat "$S/context-guard.log")" "MISS"
has "the miss names the peer and the file" "$(cat "$S/context-guard.log")" "engineer-1 200k tokens (limit 150k): MISS, no fresh $S/engineer-1-state.md"

# the limit comes from the profile; the environment wins over it
printf 'FLEET_CLEAR_LIMIT=250000\n' > "$t/profiles/p.env"
expect "a profile limit above the size is silent" "$(run)" ""
has "the environment limit wins over the profile" "$(FLEET_CLEAR_LIMIT=80000 run)" "(limit 80k)"
rm "$t/profiles/p.env"

# outside tmux, and in a session that is not a peer: silent
reset
expect "outside tmux prints nothing" "$(hook | env -u TMUX -u TMUX_PANE "$G" 2>&1)" ""
echo other-session > "$t/session"
expect "a non-fleet session prints nothing" "$(run)" ""
echo fleet-p-board > "$t/session"
expect "the board session prints nothing" "$(run)" ""
echo fleet-p-engineer-1 > "$t/session"
expect "nothing was logged outside a peer" "$(ls "$S")" ""

# PreCompact appends a line, and only that
"$G" --compacted </dev/null
expect "PreCompact logs one line" "$(wc -l < "$S/compactions.log" | tr -d ' ')" "1"
[[ "$(cat "$S/compactions.log")" =~ ^[0-9T:Z-]+\ engineer-1\ autocompacted$ ]] && ok || bad "PreCompact line: $(cat "$S/compactions.log")"
expect "PreCompact prints nothing else" "$(ls "$S")" "compactions.log"

# the hooks are registered: Stop runs the guard, PreCompact (auto) logs
check() { python3 -c 'import json,sys; d=json.load(open("skills/fleet/hooks/peer-settings.json"))["hooks"]; sys.exit(0 if sys.argv[1] in str(d["Stop"]) and "--compacted" in str(d["PreCompact"]) else 1)' fleet-context-guard; }
check && ok || bad "peer-settings.json does not register the guard"

echo "context-guard: $pass passed, $fail failed"
[ $fail -eq 0 ]
