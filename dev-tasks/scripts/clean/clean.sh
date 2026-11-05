#!/usr/bin/env bash
# clean/clean.sh: find stale fleet leftovers: git worktrees, fleet state files in $FLEET_STATE (default ~/.fleet-state/<profile>, ~/.fleet-state with no profile:
# fleet-context.md, fleet-handoff*; listed only, never deleted: they are the live resume point), and this fleet's tmux sessions:
# fleet-<profile> and fleet-<profile>-* (fleet and fleet-* with no FLEET_PROFILE); another profile's fleet is left alone.
# Worktrees: `fleet wt prune` (skills/fleet/scripts/fleet-worktree prune, the one implementation) over the fleet repo itself
# ($FLEET_HOME), the target repo (FLEET_REPO, else the profile's; with neither, every profile's) and their child repos. It removes
# merged, gone and orphaned worktrees and their local branches, never one that is dirty, has unpushed commits, has a running
# peer in it or is the caller's own; a branch never pushed is never "merged". DRY RUN by default; --force is its --yes.
# Killing tmux sessions needs its own --sessions flag on top of --force, and never kills the session clean.sh runs in.
# tmux socket: FLEET_TMUX=<name> uses that private server (tmux -L); else the server named in $TMUX; else the default.
# Usage: clean.sh [--force] [--sessions]    FLEET_HOME / FLEET_REPO override the repos looked at (tests)
set -euo pipefail
source "$(dirname "$0")/../lib/env.sh"
source "$ROOT/skills/fleet/scripts/lib/profile.sh"
source "$ROOT/skills/fleet/scripts/lib/worktree.sh"
force=0; sessions=0
for a in "$@"; do
  case "$a" in --force) force=1 ;; --sessions) sessions=1 ;; *) echo "usage: clean.sh [--force] [--sessions]" >&2; exit 2 ;; esac
done
[ $sessions -eq 0 ] || [ $force -eq 1 ] || { echo "clean: --sessions needs --force" >&2; exit 2; }
[ $force -eq 1 ] && echo "clean: --force, deleting stale worktrees" || echo "clean: dry run (nothing is deleted; pass --force)"

echo "== worktrees (fleet wt prune: merged, gone and orphaned; never dirty, unpushed, in use or yours)"
# one implementation: skills/fleet/scripts/fleet-worktree prune (lib/worktree.sh decides; --force is its --yes)
pargs=(); [ $force -eq 0 ] || pargs=(--yes)
"$ROOT/skills/fleet/scripts/fleet-worktree" prune ${pargs[@]+"${pargs[@]}"} | sed 1d

echo "== state files (listed only, never deleted)"
found=0
for f in "$FLEET_STATE"/fleet-context.md "$FLEET_STATE"/fleet-handoff*; do
  [ -e "$f" ] || continue; found=1; echo "keep (live)   $f"
done
[ $found -eq 1 ] || echo "  none"

echo "== tmux sessions"
found=0
if command -v tmux >/dev/null 2>&1; then
  source "$ROOT/skills/fleet/scripts/lib/tmux.sh"   # the one place that picks the tmux server
  own=$(fleet_own_session)
  for s in $(tmux ls -F '#{session_name}' 2>/dev/null | grep -xF "$FLEET_SESSION"; for p in $(fleet_peers); do fleet_session "$p"; done); do
    found=1
    if [ "$s" = "$own" ]; then echo "keep (own)    $s"; continue; fi
    if [ $sessions -eq 1 ] && [ $force -eq 1 ]; then echo "kill          $s"; tmux kill-session -t "$(fleet_target "$s")"
    else echo "session       $s (kept; needs --force --sessions)"; fi
  done
fi
[ $found -eq 1 ] || echo "  none"
