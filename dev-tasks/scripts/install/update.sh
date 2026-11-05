#!/usr/bin/env bash
# install/update.sh: pull the latest main into this checkout, then link any new skills.
# Touches: this checkout (fast-forward only, refuses a dirty tree or a non-main branch), new symlinks in
# ~/.claude/skills and ~/.cursor/skills, the fleet command's link; the board CLI, reinstalled when the pin moved (install/backlog.sh).
# Usage: update.sh
set -euo pipefail
source "$(dirname "$0")/../lib/env.sh"
install_lock
need git
cd "$ROOT"
[ "$(git branch --show-current)" = main ] || { echo "update: checkout is not on main; switch first" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "update: working tree is dirty" >&2; exit 1; }
git pull --ff-only
"$(dirname "$0")/backlog.sh"
"$(dirname "$0")/link.sh" "$CLAUDE_SKILLS"
"$(dirname "$0")/link.sh" "$CURSOR_SKILLS"
"$(dirname "$0")/bin.sh"
