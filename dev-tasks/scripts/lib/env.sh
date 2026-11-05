#!/usr/bin/env bash
# env.sh: shared settings for the dev-tasks scripts. Sourced, never run. Touches nothing.
# shellcheck disable=SC2034  # the variables are used by the scripts that source this file
# ROOT is this repo's checkout (found from this file); the fleet scripts themselves take their target repo from FLEET_REPO.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CLAUDE_SKILLS="${CLAUDE_SKILLS:-$HOME/.claude/skills}"
CURSOR_SKILLS="${CURSOR_SKILLS:-$HOME/.cursor/skills}"
FLEET_STATE="${FLEET_STATE:-$HOME/.fleet-state${FLEET_PROFILE:+/$FLEET_PROFILE}}"   # as lib/tmux.sh fleet_state_dir
# install, update, uninstall and link take one lock per user (skills/fleet/scripts/lib/lock.sh), so two at once cannot interleave
# a git pull with a relink or an npm install. FLEET_INSTALL_LOCK_DIR overrides where (tests).
source "$ROOT/skills/fleet/scripts/lib/lock.sh"
install_lock() { fleet_lock "${FLEET_INSTALL_LOCK_DIR:-$HOME/.fleet-state}" install "${FLEET_LOCK_WAIT:-120}" || exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "$(basename "$0"): '$1' not found on PATH" >&2; exit 1; }; }
