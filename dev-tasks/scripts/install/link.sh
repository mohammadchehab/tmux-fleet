#!/usr/bin/env bash
# install/link.sh: make the fleet skills visible to an agent by symlinking each skills/<name> folder of this checkout
# into <dir> (~/.claude/skills for Claude Code, ~/.cursor/skills for Cursor). One copy: the links point here.
# Touches: symlinks in <dir> only. A real folder, or a link to somewhere else, is reported and left alone (exit 1).
# Claude Code and Cursor get the same links: a Cursor chat loads the fleet skill and reads roles/<role>.md.
# A link of ours whose target is gone is replaced when the skill still exists under that name, else removed
# (old installs linked skills/cursor/<role> as fleet-<role>).
# Usage: link.sh <dir>
set -euo pipefail
source "$(dirname "$0")/../lib/env.sh"
install_lock
dir=${1:?usage: link.sh <dir>}
mkdir -p "$dir"
rc=0
link_one() { # link_one <name> <target>
  local name=$1 want=$2 link="$dir/$1"
  if [ -L "$link" ] && [ "$(readlink "$link")" = "$want" ]; then echo "ok      $name"
  elif [ -L "$link" ] && [ ! -e "$link" ] && [[ "$(readlink "$link")" == "$ROOT"/skills/* ]]; then
    rm "$link"; ln -s "$want" "$link"; echo "relinked $name (its old target was gone)"
  elif [ -L "$link" ]; then echo "SKIPPED $name: $link is a link to $(readlink "$link")" >&2; rc=1
  elif [ -e "$link" ]; then echo "SKIPPED $name: $link exists and is not a link" >&2; rc=1
  else ln -s "$want" "$link"; echo "linked  $name"; fi
}
for d in "$ROOT"/skills/*/; do
  name=$(basename "$d")
  link_one "$name" "${d%/}"
done
for link in "$dir"/*; do   # our links left pointing at a skill that is gone
  [ -L "$link" ] && [ ! -e "$link" ] || continue
  case "$(readlink "$link")" in "$ROOT"/skills/*) rm "$link"; echo "removed $(basename "$link") (its skill is gone)" ;; esac
done
exit $rc
