#!/usr/bin/env bash
# install/uninstall.sh: remove the fleet's symlinks from ~/.claude/skills and ~/.cursor/skills, and the fleet command's link.
# Touches: only symlinks in those two folders that point into this checkout's skills/ (now or, for a pre-move install, at the
# checkout root: lib/env.sh fleet_link_is_ours), and <FLEET_BIN or ~/.local/bin>/fleet when it points at this checkout's bin/fleet;
# anything else is left alone.
# Usage: uninstall.sh
set -euo pipefail
source "$(dirname "$0")/../lib/env.sh"
install_lock
for dir in "$CLAUDE_SKILLS" "$CURSOR_SKILLS"; do
  [ -d "$dir" ] || continue
  for link in "$dir"/*; do
    [ -L "$link" ] || continue
    fleet_link_is_ours "$(readlink "$link")" && { rm "$link"; echo "unlinked $link"; }
  done
done
bin="${FLEET_BIN:-$HOME/.local/bin}/fleet"
if [ -L "$bin" ] && [ "$(readlink "$bin")" = "$ROOT/bin/fleet" ]; then rm "$bin"; echo "unlinked $bin"; fi
