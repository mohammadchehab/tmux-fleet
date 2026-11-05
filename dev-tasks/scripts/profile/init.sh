#!/usr/bin/env bash
# profile/init.sh: create a per-user fleet profile, ~/.config/fleet/profiles/<name>.env, from profiles/example.env.
# Sets FLEET_REPO to the main checkout of <repo>, FLEET_SQUAD to <squad> and FLEET_USER to that repo's git user.name, then runs the profile lint on it.
# Refuses an existing profile, a name that is not lowercase letters, digits and hyphens, a path that is not a git repo and
# a squad that is not a file in skills/fleet/squads/. Touches only that one file (and creates its folder).
# FLEET_USER_PROFILES_DIR or XDG_CONFIG_HOME move the folder (tests).
# Usage: init.sh <name> <repo> [squad]   (squad defaults to squad)
set -euo pipefail
source "$(dirname "$0")/../lib/env.sh"
die() { echo "profile:init: $*" >&2; exit 1; }
[ $# -ge 2 ] || die "usage: task profile:init NAME=<name> REPO=<path to the repo> [SQUAD=<squad>]"
name=$1; repo=$2; squad=${3:-squad}
[[ "$name" =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "name '$name': use lowercase letters, digits and hyphens"
squads=("$ROOT"/skills/fleet/squads/*)
[ -f "$ROOT/skills/fleet/squads/$squad" ] || die "no squad '$squad' (one of: ${squads[*]##*/})"
repo=${repo/#\~/$HOME}
common=$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || die "'$repo' is not a git repo"
main=$(dirname "$common")
dir="${FLEET_USER_PROFILES_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/fleet/profiles}"
out="$dir/$name.env"
[ ! -e "$out" ] || die "$out already exists; edit it or delete it first"
mkdir -p "$dir"
realhome=$(cd "$HOME" && pwd -P)   # git prints the resolved path (macOS: /private/var/... for /var/...)
case "$main/" in "$HOME"/*) shown="~${main#"$HOME"}" ;; "$realhome"/*) shown="~${main#"$realhome"}" ;; *) shown=$main ;; esac
user=$(git -C "$main" config user.name || true)
FLEET_INIT_USER=$user awk -v repo="$shown" -v squad="$squad" '
  /^FLEET_REPO=/ { print "FLEET_REPO=" repo; next }
  /^FLEET_SQUAD=/ { sub(/^FLEET_SQUAD=[^ ]*/, "FLEET_SQUAD=" squad); print; next }
  /^FLEET_USER=/ && ENVIRON["FLEET_INIT_USER"] != "" { print "FLEET_USER=" ENVIRON["FLEET_INIT_USER"] "  # lint: allow the user'"'"'s name, not a project fact"; next }
  { print }' "$ROOT/profiles/example.env" > "$out"
echo "wrote $out (FLEET_REPO=$shown, FLEET_SQUAD=$squad${user:+, FLEET_USER=$user})"
[ -f "$main/AGENTS.md" ] || echo "note: $main has no AGENTS.md; the fleet reads project facts from it"
empty=$(mktemp -d); trap 'rm -rf "$empty"' EXIT
FLEET_USER_PROFILES_DIR="$dir" FLEET_PROFILES_DIR="$empty" "$ROOT/dev-tasks/scripts/lint/profile.sh"
echo "start with: fleet --profile $name up [squad]"
