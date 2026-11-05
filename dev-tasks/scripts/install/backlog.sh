#!/usr/bin/env bash
# install/backlog.sh: install the fleet's board CLI, Backlog.md, at the version the fleet pins (FLEET_BACKLOG_VERSION in
# skills/fleet/scripts/lib/backlog.sh), as a global npm package: the `backlog` command fleet-up, fleet-board and fleet-capacity
# run. Already at the pinned version: nothing to do.
# Touches: the global npm prefix (npm install -g backlog.md@<pin>). Nothing else; each profile's board is created by fleet-up.
# Usage: backlog.sh
set -euo pipefail
source "$(dirname "$0")/../lib/env.sh"
install_lock
source "$ROOT/skills/fleet/scripts/lib/backlog.sh"
v=$(backlog --version 2>/dev/null || true)
if [ "$v" = "$FLEET_BACKLOG_VERSION" ]; then echo "backlog $v already installed ($(command -v backlog))"; exit 0; fi
need npm
npm install -g --no-audit --no-fund "backlog.md@$FLEET_BACKLOG_VERSION"
echo "backlog $(backlog --version) installed ($(command -v backlog))"
