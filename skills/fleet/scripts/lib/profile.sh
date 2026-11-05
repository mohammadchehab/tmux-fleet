# lib/profile.sh: which repo a fleet command targets, and the fleet-only defaults of a project profile. Sourced, never run.
# Touches nothing. Provides FLEET_ROOT, fleet_load_profile and fleet_resolve_repo (sets REPO).
#
# A profile is <name>.env, chosen with FLEET_PROFILE=<name>, looked up first in the user's folder
# (FLEET_USER_PROFILES_DIR, default ${XDG_CONFIG_HOME:-~/.config}/fleet/profiles) and then in this repo's profiles/ folder.
# Real profiles live per user, outside the repo; profiles/example.env is the template to copy. It holds fleet-only values;
# every fact about the target project (tracker, board, lines of business, paths) lives in that repo's AGENTS.md and is never
# copied here.
# Parsed, never sourced or eval'd: only lines KEY=VALUE with KEY matching FLEET_[A-Z_]+ count, a leading ~ or $HOME in the value
# is expanded, an empty value means unset. Precedence: environment > profile > the script's own default, so an explicit
# FLEET_REPO or FLEET_TMUX always wins. FLEET_PROFILES_DIR overrides the repo's profiles folder (tests).
# FLEET_ROOT is found from this file's real path (pwd -P), so it is right when the skill is reached through a symlink.
_fleet_lib=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
FLEET_ROOT=$(cd "$_fleet_lib/../../../.." && pwd -P)
unset _fleet_lib

fleet_load_profile() {
  [ -n "${FLEET_PROFILE:-}" ] || return 0
  local u="${FLEET_USER_PROFILES_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/fleet/profiles}/$FLEET_PROFILE.env"
  local r="${FLEET_PROFILES_DIR:-$FLEET_ROOT/profiles}/$FLEET_PROFILE.env" f line key val
  if [ -f "$u" ]; then f=$u; elif [ -f "$r" ]; then f=$r
  else echo "$(basename "$0"): no profile '$FLEET_PROFILE' (looked in $u and $r)" >&2; return 1; fi
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^(FLEET_[A-Z_]+)=(.*)$ ]] || continue
    key=${BASH_REMATCH[1]}; val=${BASH_REMATCH[2]}
    val=${val%%[[:space:]]#*}                                   # trailing " # comment"
    val=${val%"${val##*[![:space:]]}"}                          # trailing blanks
    case "$val" in \"*\") val=${val#\"}; val=${val%\"} ;; \'*\') val=${val#\'}; val=${val%\'} ;; esac
    case "$val" in "~"|"~/"*) val=$HOME${val#\~} ;; esac
    val=${val//\$HOME/$HOME}
    [ -n "$val" ] || continue                                   # empty = unset
    [ -z "${!key:-}" ] || continue                              # the environment wins
    export "$key=$val"
  done < "$f"
}

# REPO = FLEET_REPO, else the main checkout of the git repo that contains the current directory.
fleet_resolve_repo() {
  fleet_load_profile || return 1
  if [ -n "${FLEET_REPO:-}" ]; then REPO=$FLEET_REPO; return 0; fi
  local common
  common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) \
    || { echo "$(basename "$0"): no target repo: set FLEET_REPO, set FLEET_PROFILE, or run inside the repo" >&2; return 1; }
  REPO=$(dirname "$common")
}
