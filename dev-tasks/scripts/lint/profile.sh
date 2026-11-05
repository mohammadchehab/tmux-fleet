#!/usr/bin/env bash
# lint/profile.sh: a fleet profile (profiles/<name>.env) must not restate a fact its target repo's AGENTS.md already holds.
# For each profile it finds the target repo from the profile's FLEET_REPO (~ and $HOME expanded) and reads that repo's AGENTS.md.
# Every other value is split into tokens on blanks and commas; a token of 4 or more characters that appears in AGENTS.md as a
# whole token (not inside a longer word) is a hit, printed with the AGENTS.md line. FLEET_REPO itself is exempt: it locates the repo.
# A justified hit is accepted by a trailing `# lint: allow <reason>` on the profile line (the reason is required).
# When the repo or its AGENTS.md is not on disk the profile is reported as "skipped: <path> not found", never passed silently.
# Checks both places a profile can live: the repo's profiles/ folder and the user's folder (~/.config/fleet/profiles, where real
# profiles are kept). Touches nothing (read-only). FLEET_PROFILES_DIR and FLEET_USER_PROFILES_DIR override the folders (tests).
# Usage: profile.sh
set -euo pipefail
source "$(dirname "$0")/../lib/env.sh"
dirs=("${FLEET_PROFILES_DIR:-$ROOT/profiles}" "${FLEET_USER_PROFILES_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/fleet/profiles}")
bad=0; checked=0
shopt -s nullglob
for f in "${dirs[0]}"/*.env "${dirs[1]}"/*.env; do
  name=$(basename "$f")
  repo=$(sed -n 's/^FLEET_REPO=\([^#]*\).*$/\1/p' "$f" | head -1 | sed 's/[[:space:]]*$//; s/^"\(.*\)"$/\1/')
  repo=${repo/#\~/$HOME}; repo=${repo//\$HOME/$HOME}
  if [ -z "$repo" ]; then echo "FAIL $name: no FLEET_REPO, so the lint cannot find AGENTS.md"; bad=1; continue; fi
  agents="$repo/AGENTS.md"
  if [ ! -f "$agents" ]; then echo "skipped: $agents not found ($name)"; continue; fi
  checked=$((checked+1)); n=0
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n+1))
    [[ "$line" =~ ^(FLEET_[A-Z_]+)=(.*)$ ]] || continue
    key=${BASH_REMATCH[1]}; val=${BASH_REMATCH[2]}
    [ "$key" = FLEET_REPO ] && continue
    allow=""
    if [[ "$val" =~ [[:space:]]\#[[:space:]]*lint:[[:space:]]*allow(.*)$ ]]; then
      allow=$(printf '%s' "${BASH_REMATCH[1]}" | sed 's/^[[:space:]]*//')
      [ -n "$allow" ] || { echo "FAIL $name:$n $key: '# lint: allow' needs a reason"; bad=1; continue; }
    fi
    val=${val%%[[:space:]]#*}; val=${val//\"/}; val=${val//\'/}
    val=${val/#\~/$HOME}; val=${val//\$HOME/$HOME}
    for tok in $(printf '%s' "$val" | tr ',' ' '); do
      [ ${#tok} -ge 4 ] || continue
      esc=$(printf '%s' "$tok" | sed 's/[][\.*^$(){}?+|/]/\\&/g')
      hits=$(grep -n -E "(^|[^A-Za-z0-9_-])${esc}([^A-Za-z0-9_-]|\$)" "$agents" || true)
      [ -n "$hits" ] || continue
      if [ -n "$allow" ]; then echo "allowed $name:$n $key '$tok' ($allow)"; continue; fi
      echo "FAIL $name:$n $key '$tok' repeats a fact in $agents:"
      printf '%s\n' "$hits" | head -3 | sed 's/^/       AGENTS.md:/' | cut -c1-200
      bad=1
    done
  done < "$f"
done
[ $bad -eq 0 ] && echo "profiles: $checked checked, none restates an AGENTS.md fact"
exit $bad
