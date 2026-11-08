#!/usr/bin/env bash
# test/resume.sh: prove `fleet up` with no argument resumes the saved roster after the tmux server dies
# (kill-server = a restart or reboot): each saved peer comes back in the same worktree, with the same
# @fleet-role/@fleet-cli/@fleet-profile and its saved conversation (claude --resume <id>, ori opencode -s <id>,
# agent --resume <chatId>). A real tmux server on a private socket (FLEET_TMUX) is what dies; the CLIs are
# stubs that record argv and env into $FLEET_STATE, so no live model runs. `sleep` is stubbed too: fleet-up's
# settle waits (whole seconds <= 30) are instant, the stubs' keep-alives (3600s) are real, so the panes live.
# Cases:
#  (0) fleet-session-record direct: a real hook JSON line on stdin records the live session id; /clear's new id
#      overwrites it; nothing valid (no state, no session name, no id) exits 0 without writing
#  (1) a fresh start records the roster; ids land there: claude through the hook, agent through create-chat,
#      opencode through the newest session of its worktree; a peer that /clears is saved under its NEW id
#  (2) kill-server, no-argument fleet up: everyone back with the saved id, same worktree, tags and env
#  (3) a peer whose worktree is gone starts fresh (said so in the output); the others still resume
#  (4) corrupt roster entries never block fleet-up (skipped, then pruned)
#  (5) no roster at all = a normal fresh start (the default squad)
#  (6) fleet-down keeps the roster: down, then a no-argument up still resumes
#  (7) fleet-scale remove drops a peer from the roster; add keeps the running fleet's entries
# Touches only a temp directory and a private tmux socket (both removed on exit). Usage: resume.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
fail=0; pass=0
ok() { pass=$((pass+1)); }
bad() { echo "FAIL: $*"; fail=$((fail+1)); }
SOCK="fleet-resume-$$"
t=$(mktemp -d); t=$(cd "$t" && pwd -P)   # real path: git and tmux resolve /var -> /private/var, the roster must match
trap 'rm -rf "$t"; command tmux -L "$SOCK" kill-server 2>/dev/null || true' EXIT
export FLEET_TMUX="$SOCK" FLEET_WT_CACHE="$t/wtcache" FLEET_WT_LOCK_DIR="$t/wtlock" FLEET_HOME="$t/nohome"
export FLEET_REPO="$t/repo" FLEET_STATE="$t/state" FLEET_USER="Ada Test" FLEET_CLI=claude FLEET_BASE=main
export FLEET_BACKLOG_BIN=no-such-backlog   # no board: the test is about the roster, not the board
export FLEET_USER_PROFILES_DIR="$t/profiles"
mkdir -p "$t/bin" "$t/state" "$t/profiles" "$t/repo"
git -C "$t/repo" init -q -b main; git -C "$t/repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
echo "# test profile" > "$t/profiles/test.env"
T() { command tmux -L "$SOCK" "$@"; }
wait_for() {  # the stub panes record their argv asynchronously; give them a bounded real-time grace
  local f=$1
  for _ in $(seq 50); do [ -e "$f" ] && return 0; /bin/sleep 0.1; done
  return 1
}

# claude stub: record argv + the fleet env the pane got, stay in the pane
cat > "$t/bin/claude" <<'STUB'
#!/usr/bin/env bash
d="${FLEET_STATE:-}"
[ -n "$d" ] || exit 0
mkdir -p "$d/cli-logs"
{
  echo "ARGV: $*"
  for v in TERM_SESSION_ID FLEET_STATE FLEET_PROFILE FLEET_USER FLEET_TMUX BACKLOG_CWD CLAUDE_CODE_AUTO_COMPACT_WINDOW; do
    [ -n "${!v:-}" ] && echo "ENV $v=${!v}"
  done
} > "$d/cli-logs/${TERM_SESSION_ID:-?}.argv"
exec /bin/sleep 3600
STUB
# agent stub: create-chat prints a fresh chat id (recorded by fleet-up); the pane launch records and stays
cat > "$t/bin/agent" <<'STUB'
#!/usr/bin/env bash
d="${FLEET_STATE:-}"
if [ "${1:-}" = create-chat ]; then
  [ -n "$d" ] || exit 1
  n=$(( $(cat "$d/agent-chats" 2>/dev/null || echo 0) + 1 ))
  echo "$n" > "$d/agent-chats"
  echo "chat-$n"
  exit 0
fi
[ -n "$d" ] || exit 0
mkdir -p "$d/cli-logs"
{
  echo "ARGV: $*"
  for v in TERM_SESSION_ID FLEET_STATE FLEET_PROFILE FLEET_USER FLEET_TMUX BACKLOG_CWD; do
    [ -n "${!v:-}" ] && echo "ENV $v=${!v}"
  done
} > "$d/cli-logs/${TERM_SESSION_ID:-agent}.argv"
exec /bin/sleep 3600
STUB
# ori stub (OpenCode's launcher): a fresh start (no -s) registers a new session id, newest last (the real
# `opencode session list` prints newest first); -s <id> resumes and registers nothing
cat > "$t/bin/ori" <<'STUB'
#!/usr/bin/env bash
d="${FLEET_STATE:-}"
[ -n "$d" ] || exec /bin/sleep 3600
has_s=0
for a in "$@"; do [ "$a" = -s ] && has_s=1; done
if [ "$has_s" = 0 ]; then
  n=$(( $(cat "$d/opencode-counter" 2>/dev/null || echo 0) + 1 ))
  echo "$n" > "$d/opencode-counter"
  echo "ses-stub-$n" >> "$d/opencode-sessions"
fi
mkdir -p "$d/cli-logs"
{
  echo "ARGV: $*"
  for v in TERM_SESSION_ID FLEET_STATE FLEET_PROFILE FLEET_USER FLEET_TMUX BACKLOG_CWD; do
    [ -n "${!v:-}" ] && echo "ENV $v=${!v}"
  done
} > "$d/cli-logs/${TERM_SESSION_ID:-ori}.argv"
exec /bin/sleep 3600
STUB
# opencode stub: `session list` prints the registered ids, newest first (as in the peer's own worktree)
cat > "$t/bin/opencode" <<'STUB'
#!/usr/bin/env bash
d="${FLEET_STATE:-}"
if [ "${1:-}" = session ] && [ "${2:-}" = list ] && [ -n "$d" ]; then
  [ -f "$d/opencode-sessions" ] && tail -n 1 "$d/opencode-sessions"
  exit 0
fi
exec /bin/sleep 3600
STUB
# test sleep: fleet-up's settle waits (whole seconds <= 30) are instant; the stubs' 3600s keep-alive is real
cat > "$t/bin/sleep" <<'STUB'
#!/bin/sh
case "${1:-}" in ''|*[!0-9]*) exec /bin/sleep "$@" ;; esac
[ "$1" -le 30 ] && exit 0
exec /bin/sleep "$@"
STUB
chmod +x "$t/bin/claude" "$t/bin/agent" "$t/bin/ori" "$t/bin/opencode" "$t/bin/sleep"
export PATH="$t/bin:$PATH"
S=skills/fleet/scripts
R="$t/state/roster.d"

# (0) fleet-session-record, exercised directly with the real hook JSON shapes (a peer's SessionStart/Stop hooks
# pipe one line to it; the endpoint-security SIGKILL that shaped it is why it is plain bash, no python)
HH="$S/fleet-session-record"; HS="$t/state-h"; mkdir -p "$HS"
hook() { TERM_SESSION_ID="$1" FLEET_STATE="$2" FLEET_PROFILE=test "$HH" <<<"$3"; }
SS1='{"session_id":"aaaa-1111","transcript_path":"/x/aaaa-1111.jsonl","cwd":"/repo","hook_event_name":"SessionStart","source":"startup"}'
ST1='{"session_id":"aaaa-1111","transcript_path":"/x/aaaa-1111.jsonl","stop_hook_active":false,"hook_event_name":"Stop"}'
hook fleet-test-engineer-1 "$HS" "$SS1"
[ "$(sed -n 's/^session_id=//p' "$HS/roster.d/engineer-1")" = aaaa-1111 ] && ok || bad "SessionStart did not record the id: $(cat "$HS/roster.d/engineer-1" 2>/dev/null)"
hook fleet-test-engineer-1 "$HS" "$ST1"
[ "$(sed -n 's/^session_id=//p' "$HS/roster.d/engineer-1")" = aaaa-1111 ] && ok || bad "Stop did not keep the live id"
# a /clear mints a new session: its SessionStart overwrites the roster
hook fleet-test-engineer-1 "$HS" '{"session_id":"bbbb-2222","transcript_path":"/x/bbbb-2222.jsonl","cwd":"/repo","hook_event_name":"SessionStart","source":"clear"}'
[ "$(sed -n 's/^session_id=//p' "$HS/roster.d/engineer-1")" = bbbb-2222 ] && ok || bad "/clear's new id did not replace the old one"
# a resume keeps the id
hook fleet-test-engineer-1 "$HS" '{"session_id":"bbbb-2222","transcript_path":"/x/bbbb-2222.jsonl","cwd":"/repo","hook_event_name":"SessionStart","source":"resume"}'
[ "$(sed -n 's/^session_id=//p' "$HS/roster.d/engineer-1")" = bbbb-2222 ] && ok || bad "resume changed the id"
# the hook updates the id in place, never clobbering role/cli/dir fleet-up wrote
hook fleet-test-designer "$HS" "$SS1"
printf 'peer=designer\nrole=designer\ncli=agent\ndir=/wt/designer\nsession_id=\n' > "$HS/roster.d/designer"
hook fleet-test-designer "$HS" "$ST1"
grep -q '^role=designer$' "$HS/roster.d/designer" && grep -q '^cli=agent$' "$HS/roster.d/designer" \
  && grep -q '^session_id=aaaa-1111$' "$HS/roster.d/designer" && ok || bad "the hook clobbered the roster's other fields"
# nothing valid: no state, no session name, no id, a non-fleet session — every one exits 0 and writes nothing
before=$(ls "$HS/roster.d" | tr '\n' ' ')
TERM_SESSION_ID=fleet-test-engineer-1 FLEET_STATE="" "$HH" <<<"$SS1" && ok || bad "the hook failed with no FLEET_STATE"
FLEET_STATE="$HS" FLEET_PROFILE=test "$HH" <<<"$SS1" && ok || bad "the hook failed with no TERM_SESSION_ID"
TERM_SESSION_ID=fleet-test-engineer-1 FLEET_STATE="$HS" FLEET_PROFILE=test "$HH" <<<'{"hook_event_name":"Stop"}'
TERM_SESSION_ID=my-own-terminal FLEET_STATE="$HS" FLEET_PROFILE=test "$HH" <<<"$SS1"
[ "$(ls "$HS/roster.d" | tr '\n' ' ')" = "$before" ] \
  && [ "$(sed -n 's/^session_id=//p' "$HS/roster.d/engineer-1")" = bbbb-2222 ] && ok \
  || bad "an invalid or foreign call changed the roster: $(ls "$HS/roster.d") $(sed -n 's/^session_id=//p' "$HS/roster.d/engineer-1")"

# (1) a fresh start records the roster; the squad mix has one peer per CLI
out=$(env FLEET_PROFILE=test "$S/fleet-up" mix 2>&1) || bad "fleet-up mix failed: $out"
T has-session -t "=fleet-test-engineer-1:" && T has-session -t "=fleet-test-designer:" && T has-session -t "=fleet-test-dev-support:" \
  && ok || bad "the mix peers did not start: $(T ls 2>/dev/null)"
grep -q '^role=engineer$' "$R/engineer-1" && grep -q '^cli=claude$' "$R/engineer-1" \
  && [ "$(sed -n 's/^dir=//p' "$R/engineer-1")" = "$t/repo/.claude/worktrees/engineer-1" ] && ok || bad "engineer-1's roster entry: $(cat "$R/engineer-1")"
grep -q '^role=designer$' "$R/designer" && grep -q '^cli=agent$' "$R/designer" && ok || bad "designer's roster entry: $(cat "$R/designer")"
grep -q '^role=dev-support$' "$R/dev-support" && grep -q '^cli=opencode$' "$R/dev-support" && ok || bad "dev-support's roster entry: $(cat "$R/dev-support")"
# the ids: agent's was minted by create-chat at launch; opencode's was polled from its worktree after launch
[ "$(sed -n 's/^session_id=//p' "$R/designer")" = chat-1 ] && ok || bad "agent's chat id not recorded: $(cat "$R/designer")"
sid=""
for _ in $(seq 30); do sid=$(sed -n 's/^session_id=//p' "$R/dev-support" 2>/dev/null || true); [ -n "$sid" ] && break; /bin/sleep 0.1; done
[ "$sid" = ses-stub-1 ] && ok || bad "opencode's session id not recorded: $(cat "$R/dev-support")"
# claude's id arrives through the peer's hooks: SessionStart at launch, Stop at every turn end. Each peer takes a turn.
hook fleet-test-engineer-1 "$t/state" "$SS1"
T send-keys -t "=fleet-test-engineer-1:" "Remember the codeword: kilni." Enter
T send-keys -t "=fleet-test-designer:" "Draw the card." Enter
T send-keys -t "=fleet-test-dev-support:" "Bring up the stack." Enter
hook fleet-test-engineer-1 "$t/state" "$ST1"
[ "$(sed -n 's/^session_id=//p' "$R/engineer-1")" = aaaa-1111 ] && ok || bad "the claude peer's id did not reach its roster: $(cat "$R/engineer-1")"
# the fresh launches: no --resume for claude; the agent pane resumed the just-minted chat; opencode got no -s
wait_for "$t/state/cli-logs/fleet-test-engineer-1.argv"
grep -q -- '--resume' "$t/state/cli-logs/fleet-test-engineer-1.argv" && bad "fresh claude got --resume" || ok
grep -q -- '--dangerously-skip-permissions --model sonnet --effort low' "$t/state/cli-logs/fleet-test-engineer-1.argv" && ok \
  || bad "fresh claude flags wrong: $(head -1 "$t/state/cli-logs/fleet-test-engineer-1.argv")"
grep -qE -- '--settings /[^ ]*peer-settings.json' "$t/state/cli-logs/fleet-test-engineer-1.argv" && ok \
  || bad "the hook settings path is not absolute (a peer's cwd is its worktree): $(head -1 "$t/state/cli-logs/fleet-test-engineer-1.argv")"
wait_for "$t/state/cli-logs/fleet-test-designer.argv"
grep -q -- 'ARGV: --resume chat-1 --force' "$t/state/cli-logs/fleet-test-designer.argv" && ok \
  || bad "agent pane did not resume its minted chat: $(head -1 "$t/state/cli-logs/fleet-test-designer.argv")"
wait_for "$t/state/cli-logs/fleet-test-dev-support.argv"
grep -q -- 'ARGV: opencode --auto --prompt' "$t/state/cli-logs/fleet-test-dev-support.argv" \
  && ! grep -q -- ' -s ' "$t/state/cli-logs/fleet-test-dev-support.argv" && ok || bad "fresh opencode launch wrong: $(head -1 "$t/state/cli-logs/fleet-test-dev-support.argv")"
grep -q '^ENV TERM_SESSION_ID=fleet-test-engineer-1$' "$t/state/cli-logs/fleet-test-engineer-1.argv" \
  && grep -q '^ENV FLEET_STATE='"$t/state"'$' "$t/state/cli-logs/fleet-test-engineer-1.argv" \
  && grep -q '^ENV FLEET_PROFILE=test$' "$t/state/cli-logs/fleet-test-engineer-1.argv" \
  && grep -q '^ENV FLEET_USER=Ada Test$' "$t/state/cli-logs/fleet-test-engineer-1.argv" \
  && grep -q '^ENV BACKLOG_CWD='"$t/state"'$' "$t/state/cli-logs/fleet-test-engineer-1.argv" \
  && grep -q '^ENV FLEET_TMUX='"$SOCK"'$' "$t/state/cli-logs/fleet-test-engineer-1.argv" && ok || bad "the peer pane lost its fleet env: $(cat "$t/state/cli-logs/fleet-test-engineer-1.argv")"
# /clear: the peer's SessionStart saves the NEW id — that is the one a resume must carry
T send-keys -t "=fleet-test-engineer-1:" "/clear" Enter
hook fleet-test-engineer-1 "$t/state" '{"session_id":"bbbb-2222","transcript_path":"/x/bbbb-2222.jsonl","cwd":"/repo","hook_event_name":"SessionStart","source":"clear"}'
[ "$(sed -n 's/^session_id=//p' "$R/engineer-1")" = bbbb-2222 ] && ok || bad "/clear did not move the roster to the new id"

# (2) the tmux server dies (a restart or reboot); the roster in $FLEET_STATE survives. A no-argument fleet up
# resumes every peer: same worktree, same tags, the saved conversation id in the launch command
rm -f "$t/state/cli-logs"/*.argv
T kill-server
out=$(env FLEET_PROFILE=test "$S/fleet-up" 2>&1) || bad "the resume failed: $out"
echo "$out" | grep -q 'resuming the saved roster: designer dev-support engineer-1' && ok || bad "fleet-up did not report the resume: $out"
for p in engineer-1 designer dev-support; do
  T has-session -t "=fleet-test-$p:" || bad "resumed peer $p has no session"
done
[ "$(T display -p -t "=fleet-test-engineer-1:" '#{pane_current_path}')" = "$t/repo/.claude/worktrees/engineer-1" ] && ok \
  || bad "engineer-1 did not come back in its saved worktree: $(T display -p -t "=fleet-test-engineer-1:" '#{pane_current_path}')"
[ "$(T display -p -t "=fleet-test-dev-support:" '#{pane_current_path}')" = "$t/repo/.claude/worktrees/dev-support" ] && ok \
  || bad "dev-support did not come back in its saved worktree"
for p in engineer-1 designer dev-support; do
  [ "$(T show-options -qv -t "=fleet-test-$p:" @fleet-role)" = "$(sed -n 's/^role=//p' "$R/$p")" ] \
    && [ "$(T show-options -qv -t "=fleet-test-$p:" @fleet-cli)" = "$(sed -n 's/^cli=//p' "$R/$p")" ] \
    && [ "$(T show-options -qv -t "=fleet-test-$p:" @fleet-profile)" = test ] && ok || bad "resumed peer $p lost its @fleet-* tags"
done
wait_for "$t/state/cli-logs/fleet-test-engineer-1.argv"
grep -q -- '--resume bbbb-2222' "$t/state/cli-logs/fleet-test-engineer-1.argv" && ok \
  || bad "claude did not resume the /cleared (NEW) id: $(head -1 "$t/state/cli-logs/fleet-test-engineer-1.argv")"
grep -qE -- '--settings /[^ ]*peer-settings.json' "$t/state/cli-logs/fleet-test-engineer-1.argv" && ok \
  || bad "the resumed claude lost its absolute hook settings path: $(head -1 "$t/state/cli-logs/fleet-test-engineer-1.argv")"
wait_for "$t/state/cli-logs/fleet-test-designer.argv"
grep -q -- 'ARGV: --resume chat-1 --force' "$t/state/cli-logs/fleet-test-designer.argv" && ok \
  || bad "agent did not resume its saved chat: $(head -1 "$t/state/cli-logs/fleet-test-designer.argv")"
wait_for "$t/state/cli-logs/fleet-test-dev-support.argv"
grep -q -- 'ARGV: opencode -s ses-stub-1 --auto' "$t/state/cli-logs/fleet-test-dev-support.argv" \
  && ! grep -q -- '--prompt' "$t/state/cli-logs/fleet-test-dev-support.argv" && ok \
  || bad "opencode did not resume its saved session: $(head -1 "$t/state/cli-logs/fleet-test-dev-support.argv")"
grep -q '^ENV FLEET_STATE='"$t/state"'$' "$t/state/cli-logs/fleet-test-engineer-1.argv" \
  && grep -q '^ENV FLEET_PROFILE=test$' "$t/state/cli-logs/fleet-test-engineer-1.argv" && ok \
  || bad "the resumed peer lost its fleet env"
T has-session -t "=fleet-test:" && ok || bad "the view was not rebuilt on resume"

# (3) a peer whose worktree is gone starts fresh (and says so); the others still resume
d=$(sed -n 's/^dir=//p' "$R/dev-support")
rm -rf "$d"; git -C "$t/repo" worktree prune
rm -f "$t/state/cli-logs"/*.argv
T kill-server
out=$(env FLEET_PROFILE=test "$S/fleet-up" 2>&1) || bad "the resume with a gone worktree failed: $out"
echo "$out" | grep -q "dev-support: its worktree $d is gone, starting it fresh" && ok || bad "the gone worktree was not said: $out"
[ -d "$d" ] && ok || bad "the gone worktree was not recreated"
wait_for "$t/state/cli-logs/fleet-test-dev-support.argv"
grep -q -- 'ARGV: opencode --auto --prompt' "$t/state/cli-logs/fleet-test-dev-support.argv" \
  && ! grep -q -- ' -s ' "$t/state/cli-logs/fleet-test-dev-support.argv" && ok \
  || bad "the fresh peer did not start fresh: $(head -1 "$t/state/cli-logs/fleet-test-dev-support.argv")"
[ "$(sed -n 's/^session_id=//p' "$R/dev-support")" = ses-stub-2 ] && ok \
  || bad "the fresh opencode peer's new session id was not recorded: $(cat "$R/dev-support")"
wait_for "$t/state/cli-logs/fleet-test-engineer-1.argv"
grep -q -- '--resume bbbb-2222' "$t/state/cli-logs/fleet-test-engineer-1.argv" && ok \
  || bad "the surviving peer stopped resuming: $(head -1 "$t/state/cli-logs/fleet-test-engineer-1.argv")"

# (4) corrupt roster entries never block fleet-up: skipped (said so), and pruned afterwards
printf 'not a roster file\000garbage\n' > "$R/zz-broken"
printf 'role=engineer\ncli=bogus\n' > "$R/zz-badcli"
rm -f "$t/state/cli-logs"/*.argv
T kill-server
out=$(env FLEET_PROFILE=test "$S/fleet-up" 2>&1) || bad "fleet-up was blocked by corrupt roster entries: $out"
echo "$out" | grep -q 'zz-broken: no role file roles/zz-broken.md, skipping it' && ok || bad "the corrupt entry was not reported: $out"
echo "$out" | grep -q "zz-badcli: the roster's cli 'bogus' is not claude, agent or opencode, skipping it" && ok || bad "the bad cli was not reported: $out"
[ "$(ls "$R" | wc -l | tr -d ' ')" = 3 ] && ok || bad "the corrupt entries were not pruned: $(ls "$R")"
wait_for "$t/state/cli-logs/fleet-test-engineer-1.argv"
grep -q -- '--resume bbbb-2222' "$t/state/cli-logs/fleet-test-engineer-1.argv" && ok \
  || bad "the good peers stopped resuming because of the corrupt ones"

# (5) no roster at all = a normal fresh start: the default squad, every peer without --resume, every id empty
rm -rf "$R"
T kill-server
rm -f "$t/state/cli-logs"/*.argv
out=$(env FLEET_PROFILE=test "$S/fleet-up" 2>&1) || bad "a fresh start with no roster failed: $out"
echo "$out" | grep -q 'peers run claude (environment)' && ok || bad "no-argument up with no roster did not report a fresh start: $out"
[ "$(ls "$R" | wc -l | tr -d ' ')" = 7 ] && ok || bad "the default squad did not record 7 roster entries: $(ls "$R")"
for p in project-manager architect pr-architect security-architect engineer-1 engineer-2 dev-support; do
  T has-session -t "=fleet-test-$p:" || bad "default peer $p did not start"
done
wait_for "$t/state/cli-logs/fleet-test-architect.argv"
grep -q -- '--resume' "$t/state/cli-logs/fleet-test-architect.argv" && bad "a fresh peer got --resume" || ok
grep -q -- '--model opus --effort high' "$t/state/cli-logs/fleet-test-architect.argv" && ok \
  || bad "the models file did not apply on a fresh start: $(head -1 "$t/state/cli-logs/fleet-test-architect.argv")"

# (6) fleet-down keeps the roster; a no-argument up afterwards still resumes every peer under its saved id
for p in project-manager architect pr-architect security-architect engineer-1 engineer-2 dev-support; do
  hook "fleet-test-$p" "$t/state" "{\"session_id\":\"uuid-$p\",\"transcript_path\":\"/x/uuid-$p.jsonl\",\"cwd\":\"/repo\",\"hook_event_name\":\"SessionStart\",\"source\":\"startup\"}"
done
out=$(env FLEET_PROFILE=test "$S/fleet-down" 2>&1) || bad "fleet-down failed: $out"
# the last session goes, the server goes with it: the has-session stderr is that, not a failure
T has-session -t "=fleet-test-engineer-1:" 2>/dev/null && bad "fleet-down left a peer" || ok
T has-session -t "=fleet-test:" 2>/dev/null && bad "fleet-down left the view" || ok
[ "$(ls "$R" | wc -l | tr -d ' ')" = 7 ] && ok || bad "fleet-down touched the roster: $(ls "$R")"
rm -f "$t/state/cli-logs"/*.argv
out=$(env FLEET_PROFILE=test "$S/fleet-up" 2>&1) || bad "the up after fleet-down failed: $out"
echo "$out" | grep -q 'resuming the saved roster' && ok || bad "up after fleet-down did not resume: $out"
wait_for "$t/state/cli-logs/fleet-test-architect.argv"
grep -q -- '--resume uuid-architect' "$t/state/cli-logs/fleet-test-architect.argv" && ok \
  || bad "the down-then-up peer did not resume its saved id: $(head -1 "$t/state/cli-logs/fleet-test-architect.argv")"

# (7) fleet-scale keeps the roster in step: remove drops the stopped peer's entry (project-manager is protected
# from scale remove, so the test stops the architect); add leaves the running fleet's entries alone
out=$(env FLEET_PROFILE=test skills/fleet-scale/scripts/fleet-scale remove architect 2>&1) || bad "fleet-scale remove failed: $out"
[ ! -f "$R/architect" ] && [ "$(ls "$R" | wc -l | tr -d ' ')" = 6 ] && ok || bad "remove did not drop the peer's roster entry: $(ls "$R")"
T has-session -t "=fleet-test-architect:" 2>/dev/null && bad "remove left the stopped peer" || ok
out=$(env FLEET_PROFILE=test skills/fleet-scale/scripts/fleet-scale add engineer 2>&1) || bad "fleet-scale add failed: $out"
[ -f "$R/engineer" ] && [ "$(ls "$R" | wc -l | tr -d ' ')" = 7 ] && ok || bad "add did not write the new peer's roster entry: $(ls "$R")"
grep -q '^role=engineer$' "$R/engineer" && grep -q '^cli=claude$' "$R/engineer" && ok || bad "add's roster entry is wrong: $(cat "$R/engineer")"
[ -f "$R/security-architect" ] && [ "$(sed -n 's/^session_id=//p' "$R/security-architect")" = uuid-security-architect ] && ok \
  || bad "add clobbered the running fleet's roster entries"
T has-session -t "=fleet-test-engineer:" 2>/dev/null && ok || bad "add did not start the new peer"

echo "resume: $pass passed, $fail failed"
[ $fail -eq 0 ]
