#!/usr/bin/env bash
# test/smoke.sh: smoke-test the fleet scripts without tmux, claude or the network: every script parses (bash -n),
# fleet-up rejects a bad FLEET_CLI, every squad names only peers that have a roles/<role>.md and a models row,
# and the dev-tasks install/uninstall/clean scripts behave in a throwaway HOME.
# Touches only a temp directory (removed on exit).
# Usage: smoke.sh
set -euo pipefail
source "$(dirname "$0")/../lib/env.sh"
cd "$ROOT"
fail=0; pass=0
check() { if "$@" >/dev/null 2>&1; then pass=$((pass+1)); else echo "FAIL: $*"; fail=$((fail+1)); fi; }
# every tmux call in this test goes to a private socket (and the fake tmux below), never the live server
export FLEET_TMUX="smoke-$$"; unset TMUX TMUX_PANE
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
export FLEET_WT_CACHE="$t/wtcache" FLEET_WT_LOCK_DIR="$t/wtlock"   # worktree scans: never the real ~/.fleet-state

while IFS= read -r f; do
  head -1 "$f" | grep -qE '^#!.*\b(ba)?sh\b' && check bash -n "$f"
done < <(find skills dev-tasks bin -type f ! -name '*.md')
check bash -c '! FLEET_CLI=bogus skills/fleet/scripts/fleet-up solo'
for s in skills/fleet/squads/*; do
  while read -r peer role cli _; do   # <peer> [role] [cli]
    case "$peer" in ""|"#"*) continue ;; esac; role=${role:-${peer%-[0-9]*}}
    check test -f "skills/fleet/roles/$role.md"
    check grep -q "^${role}[[:space:]]" skills/fleet/models
    check bash -c "case '${cli:-claude}' in claude|agent|opencode) ;; *) exit 1 ;; esac"
  done < "$s"
done
# link.sh: links, idempotent, leaves a foreign folder alone; uninstall removes only our links
export FLEET_INSTALL_LOCK_DIR="$t/installlock" CLAUDE_SKILLS="$t/claude" CURSOR_SKILLS="$t/cursor"; mkdir -p "$CURSOR_SKILLS/fleet-rca"
check bash -c '! dev-tasks/scripts/install/link.sh "$CURSOR_SKILLS"'  # fleet-rca is a real folder: reported, exit 1
rmdir "$CURSOR_SKILLS/fleet-rca"
check dev-tasks/scripts/install/link.sh "$CURSOR_SKILLS"
check dev-tasks/scripts/install/link.sh "$CLAUDE_SKILLS"
check test ! -e "$CURSOR_SKILLS/cursor"
check test ! -e "$CURSOR_SKILLS/fleet-engineer"
check test "$(readlink "$CURSOR_SKILLS/fleet-triage")" = "$ROOT/skills/fleet-triage"
check test "$(readlink "$CURSOR_SKILLS/fleet-rca")" = "$ROOT/skills/fleet-rca"
check test ! -e "$CURSOR_SKILLS/fleet-ops"
check test "$(readlink "$CLAUDE_SKILLS/fleet-triage")" = "$ROOT/skills/fleet-triage"
check test "$(readlink "$CURSOR_SKILLS/fleet")" = "$ROOT/skills/fleet"
check test "$(readlink "$CLAUDE_SKILLS/fleet")" = "$ROOT/skills/fleet"
check dev-tasks/scripts/install/link.sh "$CURSOR_SKILLS"
# old installs: a stale link of ours to an existing skill name is replaced, one to a gone role pack is removed
rm "$CURSOR_SKILLS/fleet-rca"; ln -s "$ROOT/skills/cursor/triage" "$CURSOR_SKILLS/fleet-rca"
ln -s "$ROOT/skills/cursor/engineer" "$CURSOR_SKILLS/fleet-engineer"
check dev-tasks/scripts/install/link.sh "$CURSOR_SKILLS"
check test "$(readlink "$CURSOR_SKILLS/fleet-rca")" = "$ROOT/skills/fleet-rca"
check test ! -L "$CURSOR_SKILLS/fleet-engineer"
ln -s /elsewhere "$CURSOR_SKILLS/foreign"
check dev-tasks/scripts/install/uninstall.sh
check test ! -e "$CURSOR_SKILLS/fleet"
check test ! -e "$CLAUDE_SKILLS/fleet"
check test ! -e "$CURSOR_SKILLS/fleet-engineer"
check test -L "$CURSOR_SKILLS/foreign"
# clean: dry run deletes nothing
# clean.sh looks only at throwaway paths here (FLEET_HOME and FLEET_REPO), never at the real fleet checkout
export FLEET_HOME="$t/nohome" FLEET_REPO="$t/notarget"
check dev-tasks/scripts/clean/clean.sh
# clean --force never deletes fleet state and never touches tmux without --sessions (fake tmux records its calls)
mkdir -p "$t/state" "$t/bin"; : > "$t/state/fleet-context.md"
printf '#!/usr/bin/env bash\necho "$*" >> "%s/tmux.log"\ncase "$*" in *"ls -F"*) echo fleet-x;; esac \nexit 0\n' "$t" > "$t/bin/tmux"; chmod +x "$t/bin/tmux"
check env PATH="$t/bin:$PATH" FLEET_STATE="$t/state" dev-tasks/scripts/clean/clean.sh --force
check test -f "$t/state/fleet-context.md"
check bash -c '! grep -q kill-session "$1"' _ "$t/tmux.log"
check bash -c '! env PATH="$1/bin:$PATH" dev-tasks/scripts/clean/clean.sh --sessions' _ "$t"
check env PATH="$t/bin:$PATH" FLEET_TMUX=smoke FLEET_STATE="$t/state" dev-tasks/scripts/clean/clean.sh --force --sessions
check grep -q -- '-L smoke kill-session -t =fleet-x' "$t/tmux.log"
check dev-tasks/scripts/test/tmux-isolation.sh
check dev-tasks/scripts/test/cmd.sh
check dev-tasks/scripts/test/pane.sh
check dev-tasks/scripts/test/wt.sh
check dev-tasks/scripts/test/profile.sh
check dev-tasks/scripts/test/profile-init.sh
check dev-tasks/scripts/test/worktrees.sh
# no ops role: no agent touches production (the user, 2026-10-24)
check test ! -f skills/fleet/roles/ops.md
check bash -c '! grep -rqE "^ops([[:space:]]|$)" skills/fleet/squads skills/fleet/models'
check test ! -e skills/fleet/scripts/fleet-brief
# the board (Backlog.md). install:backlog does nothing when the pinned version is on PATH (a fake one here, so no npm).
PIN=$(sed -n 's/^FLEET_BACKLOG_VERSION=//p' skills/fleet/scripts/lib/backlog.sh)
mkdir -p "$t/blbin"; printf '#!/bin/sh\n[ "$1" = --version ] && echo %s\n' "$PIN" > "$t/blbin/backlog"; chmod +x "$t/blbin/backlog"
check bash -c 'env PATH="$1:/usr/bin:/bin" dev-tasks/scripts/install/backlog.sh | grep -q "already installed"' _ "$t/blbin"
mkdir -p "$t/blstate/backlog"; : > "$t/blstate/backlog/config.yml"   # board-jira refuses input that is not a JSON array
check bash -c 'echo "{}" | env PATH="$1:$PATH" FLEET_STATE="$2/blstate" skills/fleet-board/scripts/board-jira; [ $? -eq 2 ]' _ "$t/blbin" "$t"
# with the real backlog CLI at the pinned version (task install:backlog), the board scripts end to end in a temp state folder
if [ "$(backlog --version 2>/dev/null)" = "$PIN" ]; then
  export FLEET_STATE="$t/board"; R="$t/docrepo"; mkdir -p "$R/docs/architecture" "$R/src"; git -C "$R" init -q
  printf -- '---\nx: 1\n---\n# Overview\n' > "$R/docs/architecture/overview.md"; echo '# not a spec' > "$R/src/notes.md"; git -C "$R" add -A
  J='[{"key":"KEY-1","summary":"One","status":"To Do","statusCategory":"new","epic":"KEY-9 Epic","url":"https://site/browse/KEY-1"},
      {"key":"KEY-2","summary":"Two","status":"In Review","statusCategory":"indeterminate","epic":null,"url":"https://site/browse/KEY-2"}]' # lint: allow fixture keys
  check bash -c 'skills/fleet-board/scripts/board-jira <<<"$1" | grep -q "2 created, 0 updated"' _ "$J"
  check bash -c 'skills/fleet-board/scripts/board-jira <<<"$1" | grep -q "0 created, 0 updated, 2 unchanged"' _ "$J"
  check bash -c 'BACKLOG_CWD=$FLEET_STATE backlog task list --plain | grep -A1 "^Review:" | grep -q "\[KEY-2\] Two"'  # lint: allow fixture key
  check bash -c 'BACKLOG_CWD=$FLEET_STATE backlog milestone list --plain | grep -q "KEY-9 Epic"'  # lint: allow fixture key
  check bash -c 'FLEET_REPO="$1" skills/fleet-board/scripts/board-docs | grep -q "board-docs: 1 files"' _ "$R"
  check bash -c 'BACKLOG_CWD=$FLEET_STATE backlog doc list --plain | grep -q "doc-repo-docs-architecture-overview"'
  # a second run updates docs/repo in place (same folder, so the running page's watcher keeps seeing it) and drops a gone file
  ino=$(stat -f %i "$FLEET_STATE/backlog/docs/repo"); git -C "$R" rm -qf docs/architecture/overview.md
  mkdir -p "$R/docs/specs"; echo '# Journey' > "$R/docs/specs/journey.md"; git -C "$R" add -A
  check bash -c 'FLEET_REPO="$1" skills/fleet-board/scripts/board-docs | grep -q "board-docs: 1 files"' _ "$R"
  check test "$(stat -f %i "$FLEET_STATE/backlog/docs/repo")" = "$ino"
  check test -f "$FLEET_STATE/backlog/docs/repo/docs/specs/journey.md"
  check test ! -e "$FLEET_STATE/backlog/docs/repo/docs/architecture"
  check bash -c 'id=$(skills/fleet-board/scripts/board-decision ask "Q?" "A or B; recommend A") && skills/fleet-board/scripts/board-decision answer "$id" "A (user)" && skills/fleet-board/scripts/board-decision list accepted | grep -q "Q?"'
  check grep -q '^A (user)$' "$FLEET_STATE"/backlog/decisions/decision-1*.md
  unset FLEET_STATE
else
  echo "smoke: backlog $PIN not on PATH, the board's end-to-end checks were skipped (task install:backlog)"
fi
echo "smoke: $pass passed, $fail failed"
[ $fail -eq 0 ]
