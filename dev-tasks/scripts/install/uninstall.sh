#!/usr/bin/env bash
# install/uninstall.sh: remove the fleet's symlinks from ~/.claude/skills and ~/.cursor/skills, and the fleet command's link.
# Touches: only symlinks in those two folders that point into this checkout's skills/, and <FLEET_BIN or ~/.local/bin>/fleet
# when it points at this checkout's bin/fleet; anything else is left alone.
# Usage: uninstall.sh
set -euo pipefail
source "$(dirname "$0")/../lib/env.sh"
install_lock
for dir in "$CLAUDE_SKILLS" "$CURSOR_SKILLS"; do
  [ -d "$dir" ] || continue
  for link in "$dir"/*; do
    [ -L "$link" ] || continue
    case "$(readlink "$link")" in "$ROOT"/skills/*) rm "$link"; echo "unlinked $link" ;; esac
  done
done
bin="${FLEET_BIN:-$HOME/.local/bin}/fleet"
if [ -L "$bin" ] && [ "$(readlink "$bin")" = "$ROOT/bin/fleet" ]; then rm "$bin"; echo "unlinked $bin"; fi
