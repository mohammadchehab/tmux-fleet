#!/usr/bin/env bash
# env.sh: shared settings for the dev-tasks scripts. Sourced, never run. Touches nothing.
# shellcheck disable=SC2034  # the variables are used by the scripts that source this file
# ROOT is this repo's checkout (found from this file); the fleet scripts themselves take their target repo from FLEET_REPO.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CLAUDE_SKILLS="${CLAUDE_SKILLS:-$HOME/.claude/skills}"
CURSOR_SKILLS="${CURSOR_SKILLS:-$HOME/.cursor/skills}"
FLEET_STATE="${FLEET_STATE:-$HOME/.fleet-state${FLEET_PROFILE:+/$FLEET_PROFILE}}"   # as lib/tmux.sh fleet_state_dir
# The v1 tree moved to legacy/v1 in fleet v2, so ROOT is now <checkout>/legacy/v1 and an install made before the move points
# at <checkout>/skills/<name>, which no longer exists. fleet_link_is_ours therefore accepts both spellings of "this checkout's
# skills/": the one now and the one before the move. Nothing else matches, so a link to another checkout is still foreign.
FLEET_PRE_MOVE_ROOT=""
if [ "$(basename "$ROOT")" = v1 ] && [ "$(basename "$(dirname "$ROOT")")" = legacy ]; then
  FLEET_PRE_MOVE_ROOT="$(cd "$ROOT/../.." && pwd)"
fi
fleet_link_is_ours() { # fleet_link_is_ours <link target>: is it a skill link from this checkout, before or after the move?
  case "$1" in "$ROOT"/skills/*) return 0 ;; esac
  if [ -n "$FLEET_PRE_MOVE_ROOT" ]; then
    case "$1" in "$FLEET_PRE_MOVE_ROOT"/skills/*) return 0 ;; esac
  fi
  return 1
}
# install, update, uninstall and link take one lock per user (skills/fleet/scripts/lib/lock.sh), so two at once cannot interleave
# a git pull with a relink or an npm install. FLEET_INSTALL_LOCK_DIR overrides where (tests).
source "$ROOT/skills/fleet/scripts/lib/lock.sh"
install_lock() { fleet_lock "${FLEET_INSTALL_LOCK_DIR:-$HOME/.fleet-state}" install "${FLEET_LOCK_WAIT:-120}" || exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "$(basename "$0"): '$1' not found on PATH" >&2; exit 1; }; }
