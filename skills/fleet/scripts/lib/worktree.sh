# lib/worktree.sh: where worktrees live, who owns them, and which are stale. Sourced, never run.
# Touches nothing, except fleet_worktree_exclude (one line in a repo's .git/info/exclude) and fleet_worktree_owner_set.
#
# The rule: every repo's worktrees live in <main checkout of that repo>/.claude/worktrees/<topic>, named after the
# topic only (no peer name, no folder per repo). The fleet repo is a repo like any other: FLEET_HOME is its main checkout
# (FLEET_HOME overrides it, for tests). Nothing here moves a worktree that exists.
# Provides: FLEET_HOME, fleet_main_checkout, fleet_worktree_root, fleet_worktree_exclude, fleet_worktree_owner_set,
# fleet_worktree_owner, fleet_child_repos, fleet_branch_state.

# the main checkout of the git repo containing <path>; also right from inside a linked worktree
fleet_main_checkout() {
  local c
  c=$(git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  dirname "$c"
}

source "$(dirname "${BASH_SOURCE[0]}")/lock.sh"   # fleet_wt_cached refreshes under a lock
_fleet_wt_lib=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
FLEET_HOME=${FLEET_HOME:-$(fleet_main_checkout "$_fleet_wt_lib" || true)}
unset _fleet_wt_lib

# <main checkout>/.claude/worktrees for the repo containing <path>
fleet_worktree_root() { local m; m=$(fleet_main_checkout "$1") || return 1; echo "$m/.claude/worktrees"; }

# keep a repo's own tree clean for its checks: exclude the worktrees folder locally, never through its .gitignore
fleet_worktree_exclude() {
  local ex
  ex="$(git -C "$1" rev-parse --path-format=absolute --git-common-dir)/info/exclude"
  mkdir -p "$(dirname "$ex")"
  grep -qx '/.claude/worktrees/' "$ex" 2>/dev/null || echo '/.claude/worktrees/' >> "$ex"
}

# the peer that created a worktree is recorded in the worktree's git dir (not in its files), because the folder name is the
# topic only: fleet_worktree_owner_set <worktree> <peer>; fleet_worktree_owner <worktree> prints it, or nothing
fleet_worktree_owner_set() {
  local g
  g=$(git -C "$1" rev-parse --path-format=absolute --git-dir) || return 1
  printf '%s\n' "$2" > "$g/fleet-owner"
}
fleet_worktree_owner() {
  local g
  g=$(git -C "$1" rev-parse --path-format=absolute --git-dir 2>/dev/null) || return 0
  [ ! -f "$g/fleet-owner" ] || cat "$g/fleet-owner"
}

# child repos of a target repo that may get worktrees: every git repo nested inside it (a submodule or a nested clone, up
# to three folders deep), each its own git repo. Worktree folders and node_modules are skipped.
fleet_child_repos() {
  find "$1" -mindepth 2 -maxdepth 4 \( -name node_modules -o -name worktrees -o -name .git -type d \) -prune -o \
    -name .git -type f -print 2>/dev/null | sed 's|/\.git$||' | sort
  find "$1" -mindepth 2 -maxdepth 4 \( -name node_modules -o -name worktrees \) -prune -o \
    -name .git -type d -print -prune 2>/dev/null | sed 's|/\.git$||' | sort
  return 0
}

# What a worktree's branch says about whether the worktree is still needed. Prints one word:
#   detached  no branch to judge (a peer's launch worktree)
#   open      the branch was never pushed (no upstream, or main itself as upstream): kept whatever its content. A brand-new branch with no commit of its
#             own is an ancestor of main and would otherwise look merged, and a peer may be about to work in it.
#   merged    (pushed) main already holds the branch: an ancestor of main, or, after a squash merge, main has the branch's
#             content on every file the branch touched
#   gone      (pushed) the upstream no longer exists on the remote (deleted after its PR; needs a fetch --prune)
#   open      anything else: pushed and not merged
# So a repo with no remote never reports merged or gone, and its worktrees are removed by hand.
fleet_branch_state() {
  local wt=$1 br base mb branch_files differing
  br=$(git -C "$wt" branch --show-current 2>/dev/null)
  [ -n "$br" ] || { echo detached; return 0; }
  # an upstream of main itself (git worktree add -b x origin/main tracks origin/main) is no push of the branch: never pushed
  case "$(git -C "$wt" for-each-ref --format='%(upstream)' "refs/heads/$br" 2>/dev/null)" in
    ""|refs/remotes/origin/main|refs/heads/main) echo open; return 0 ;;
  esac
  if git -C "$wt" show-ref -q --verify refs/remotes/origin/main; then base=origin/main
  elif git -C "$wt" show-ref -q --verify refs/heads/main; then base=main
  else echo open; return 0; fi
  if git -C "$wt" merge-base --is-ancestor "$br" "$base" 2>/dev/null; then echo merged; return 0; fi
  mb=$(git -C "$wt" merge-base "$base" "$br" 2>/dev/null || true)
  if [ -n "$mb" ]; then
    branch_files=$(git -C "$wt" diff --name-only "$mb" "$br" 2>/dev/null | sort)
    differing=$(git -C "$wt" diff --name-only "$base" "$br" 2>/dev/null | sort)
    if [ -n "$branch_files" ] && [ -z "$(comm -12 <(printf '%s\n' "$branch_files") <(printf '%s\n' "$differing"))" ]; then
      echo merged; return 0
    fi
  fi
  case "$(git -C "$wt" for-each-ref --format='%(upstream:track)' "refs/heads/$br" 2>/dev/null)" in
    *gone*) echo gone; return 0 ;;
  esac
  echo open
}

# ---- inventory: every worktree of every repo the fleet touches (fleet worktree ls|prune|summary|remind, capacity, fleet ls)
# Which repos: with FLEET_REPO or FLEET_PROFILE set, that one target (FLEET_REPO, else the profile's); with neither, every profile
# file's FLEET_REPO (user profiles, then the repo's profiles/, never example); none at all: the repo you run it in. Plus each
# target's child repos, plus the fleet repo itself (FLEET_HOME) unless FLEET_PROFILE narrows it to one profile. Needs lib/profile.sh and lib/tmux.sh.
# fleet_wt_targets: "<profile>|<repo>|<state dir>|<idle days>" per target; the fleet repo as profile "(fleet repo)"
fleet_wt_targets() {
  local p f d
  _wt_target() {  # in a subshell: load profile $1 (or none) and print its line
    ( if [ -n "$1" ]; then export FLEET_PROFILE=$1; fleet_load_profile >/dev/null 2>&1 || exit 0; fi
      [ -n "${FLEET_REPO:-}" ] || exit 0
      echo "$1|$FLEET_REPO|${FLEET_STATE:-$HOME/.fleet-state${1:+/$1}}|${FLEET_WT_IDLE_DAYS:-7}" )
  }
  if [ -n "${FLEET_PROFILE:-}" ]; then _wt_target "$FLEET_PROFILE"
  elif [ -n "${FLEET_REPO:-}" ]; then _wt_target ""
  else
    for p in $(for d in "${FLEET_USER_PROFILES_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/fleet/profiles}" "${FLEET_PROFILES_DIR:-$FLEET_ROOT/profiles}"; do
        for f in "$d"/*.env; do [ -e "$f" ] && basename "$f" .env; done; done | grep -vx example | sort -u); do
      ( unset FLEET_REPO FLEET_STATE FLEET_WT_IDLE_DAYS; _wt_target "$p" )
    done
    [ -n "$(for d in "${FLEET_USER_PROFILES_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/fleet/profiles}"; do ls "$d"/*.env 2>/dev/null; done)" ] \
      || { local r; r=$(fleet_main_checkout "$PWD" 2>/dev/null) && echo "|$r|${FLEET_STATE:-$HOME/.fleet-state}|7"; }
  fi
  if [ -z "${FLEET_PROFILE:-}" ] && [ -n "$FLEET_HOME" ]; then echo "(fleet repo)|$FLEET_HOME|$HOME/.fleet-state|${FLEET_WT_IDLE_DAYS:-7}"; fi
}
_wt_mtime() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo 0; }
# fleet_wt_panes: "<profile>|<peer>|<pane cwd>" for every fleet peer pane on this tmux server (sessions tagged @fleet-role)
fleet_wt_panes() {
  local s tag role cwd base
  while IFS='|' read -r s tag role cwd; do
    [ -n "$role" ] || continue; base=fleet${tag:+-$tag}
    [[ "$s" == "$base"-?* ]] && echo "$tag|${s#"$base"-}|$cwd"
  done < <(tmux list-panes -a -F '#{session_name}|#{@fleet-profile}|#{@fleet-role}|#{pane_current_path}' 2>/dev/null || true)
}
# fleet_wt_fetch: git fetch --prune origin in each target repo and its child repos, so merged and gone are current (ls, prune).
# Never prompts for credentials; a repo with no remote, or one that cannot be reached, is skipped.
fleet_wt_fetch() {
  local repo m r
  while IFS='|' read -r _ repo _ _; do
    m=$(fleet_main_checkout "$repo" 2>/dev/null) || continue
    for r in "$m" $(fleet_child_repos "$m"); do
      git -C "$r" remote get-url origin >/dev/null 2>&1 && GIT_TERMINAL_PROMPT=0 git -C "$r" fetch -q --prune origin 2>/dev/null || true
    done
  done < <(fleet_wt_targets)
}
# fleet_wt_cwds: "<pid> <command>\t<cwd>" for every process of this user (lsof; /proc where there is no lsof). prune keeps a
# worktree any process sits in: a peer's Claude and shell sit in its launch worktree whichever tmux server runs them, which
# fleet_wt_panes (the targeted server only, lib/tmux.sh) cannot see. Reads no tmux server.
fleet_wt_cwds() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -a -u "$(id -u)" -d cwd -Fpcn 2>/dev/null | awk '/^p/ {p = substr($0, 2)} /^c/ {c = substr($0, 2)} /^n/ {print p " " c "\t" substr($0, 2)}'
  else
    local d; for d in /proc/[0-9]*; do [ -O "$d" ] && printf '%s %s\t%s\n' "${d#/proc/}" "$(cat "$d/comm" 2>/dev/null)" "$(readlink "$d/cwd" 2>/dev/null)"; done
  fi
  return 0
}
# fleet_wt_scan <pr: 0|1> <size: none|cache|fresh>: one TSV row per linked worktree:
#   profile repo path owner kind branch pr age_s dirty unpushed size_kb inuse class bstate missing
# kind: launch (a peer's detached home, .claude/worktrees/<peer>) or topic. class, first match wins: orphaned (folder missing;
# a launch worktree whose peer is not running; a topic whose owner is not running while its profile's fleet runs), nested
# (inside another worktree), merged, gone (fleet_branch_state), idle (no commit or file change for the profile's idle days),
# active. PR: gh pr list per repo, cached 10 minutes; "?" without gh. Sizes: du -sk, cached in the cache dir.
fleet_wt_scan() {
  local want_pr=$1 want_size=$2 cache="${FLEET_WT_CACHE:-$HOME/.fleet-state/cache}" now panes seen="" line
  now=$(date +%s); mkdir -p "$cache"; touch "$cache/sizes.tsv"
  panes=$(fleet_wt_panes)
  local all=() rows=(); declare -A prj=()
  while IFS='|' read -r prof repo state idle; do
    [ -d "$repo" ] || continue
    local main; main=$(fleet_main_checkout "$repo" 2>/dev/null || echo "$repo"); main=$(cd "$main" && pwd -P)
    local repos=() r c
    [ -d "$main/.git" ] || [ -f "$main/.git" ] && repos+=("$main")
    while read -r c; do [ -n "$c" ] && repos+=("$(cd "$c" && pwd -P)"); done < <(fleet_child_repos "$main")
    for r in ${repos[@]+"${repos[@]}"}; do
      case " $seen " in *" $r "*) continue ;; esac; seen="$seen $r"
      local prjson="" key
      prj[$r]=""
      if [ "$want_pr" = 1 ] && command -v gh >/dev/null 2>&1; then
        key=$(printf '%s' "$r" | cksum | cut -d' ' -f1)
        if [ -n "$(find "$cache/pr-$key.json" -mmin -10 2>/dev/null)" ]; then prjson=$(cat "$cache/pr-$key.json")
        else prjson=$(cd "$r" && gh pr list --state all --limit 300 --json number,state,headRefName 2>/dev/null) && printf '%s' "$prjson" > "$cache/pr-$key.json" || prjson=""; fi
        prj[$r]=$prjson
      fi
      local base; if git -C "$r" show-ref -q --verify refs/remotes/origin/main; then base=origin/main; else base=main; fi
      local wt="" br="" det=0 prunable=0 first=1
      while IFS= read -r line; do
        case "$line" in
          "worktree "*) wt=${line#worktree }; br=""; det=0; prunable=0 ;;
          "branch refs/heads/"*) br=${line#branch refs/heads/} ;;
          detached) det=1 ;;
          prunable*) prunable=1 ;;
          "")
            if [ -n "$wt" ]; then
              if [ $first = 1 ]; then first=0; else rows+=("$prof|$r|$state|$idle|$wt|$br|$det|$prunable|$base"); all+=("$wt"); fi
            fi; wt="" ;;
        esac
      done < <(git -C "$r" worktree list --porcelain; echo)
    done
  done < <(fleet_wt_targets)
  local row prof r state idle wt br det prunable base
  for row in ${rows[@]+"${rows[@]}"}; do
    IFS='|' read -r prof r state idle wt br det prunable base <<<"$row"; prjson=${prj[$r]:-}
    local owner="" kind=topic pr="-" age=0 dirty=0 unp=0 size="" inuse="-" class="" bstate="" missing=0 x
    [ "$want_pr" = 1 ] && pr="?"
    if [ "$prunable" = 1 ] || [ ! -d "$wt" ]; then missing=1; fi
    # a peer's launch worktree: <repo>/.claude/worktrees/<peer>, named after a role (detached, or on a branch it checked out)
    if [ "$(basename "$(dirname "$wt")")" = worktrees ] && [ -f "${FLEET_ROLES_DIR:-$_fleet_wt_roles}/$(basename "$wt" | sed 's/-[0-9]*$//').md" ]; then
      kind=launch; owner=$(basename "$wt")
    elif [ $missing = 0 ]; then owner=$(fleet_worktree_owner "$wt"); fi
    if [ $missing = 0 ]; then
      local st; st=$(git -C "$wt" status --porcelain 2>/dev/null)
      dirty=$( [ -z "$st" ] && echo 0 || grep -c . <<<"$st")
      age=$(git -C "$wt" log -1 --format=%ct 2>/dev/null || echo 0)
      while IFS= read -r x; do [ -n "$x" ] || continue; x=$(_wt_mtime "$wt/${x:3}"); [ "$x" -le "$age" ] || age=$x; done <<<"$st"
      # unpushed: commits not on the branch's own upstream; a branch never pushed (or tracking main) counts what main lacks
      case "$( [ -n "$br" ] && git -C "$wt" for-each-ref --format='%(upstream)' "refs/heads/$br" 2>/dev/null)" in
        ""|refs/remotes/origin/main|refs/heads/main) unp=$(git -C "$wt" rev-list --count "$base..HEAD" 2>/dev/null || echo 0) ;;
        *) unp=$(git -C "$wt" rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0) ;;
      esac
      bstate=$(fleet_branch_state "$wt")
      case "$want_size" in
        fresh) size=$(du -sk "$wt" 2>/dev/null | cut -f1); awk -F'\t' -v p="$wt" '$1 != p' "$cache/sizes.tsv" > "$cache/sizes.tmp" || true
               printf '%s\t%s\n' "$wt" "$size" >> "$cache/sizes.tmp"; mv "$cache/sizes.tmp" "$cache/sizes.tsv" ;;
        cache) size=$(awk -F'\t' -v p="$wt" '$1 == p {print $2}' "$cache/sizes.tsv" | tail -1) ;;
      esac
      if [ "$want_pr" = 1 ] && [ -n "$prjson" ] && [ -n "$br" ]; then
        pr=$(jq -r --arg b "$br" '[.[] | select(.headRefName == $b)] | (map(select(.state == "OPEN")) + map(select(.state == "MERGED")) + map(select(.state == "CLOSED"))) | first // empty | "#\(.number) \(.state | ascii_downcase)"' <<<"$prjson")
        pr=${pr:-none}
      fi
      while IFS='|' read -r pp peer cwd; do
        [ -n "$cwd" ] || continue; case "$cwd/" in "$wt"/*) inuse=$peer ;; esac
      done <<<"$panes"
    fi
    # running peers of this profile, and whether its fleet runs at all
    local running fleet_up=0; running=$(awk -F'|' -v p="$prof" '$1 == p {print $2}' <<<"$panes" | sort -u)
    [ -z "$running" ] || fleet_up=1
    if [ $missing = 1 ]; then class=orphaned
    elif [ $kind = launch ] && ! grep -qx "$owner" <<<"$running"; then class=orphaned
    elif [ $kind = topic ] && [ -n "$owner" ] && [ $fleet_up = 1 ] && ! grep -qx "$owner" <<<"$running"; then class=orphaned
    else
      for x in ${all[@]+"${all[@]}"}; do [ "$x" != "$wt" ] && case "$wt/" in "$x"/*) class=nested ;; esac; done
      if [ -z "$class" ]; then
        case "$bstate" in merged|gone) class=$bstate ;; esac
        # a squash merge leaves no ancestry, and a repo that keeps branches leaves nothing gone: the PR's own state decides
        case "$pr" in *" merged"*) class=merged ;; esac
      fi
      if [ -z "$class" ] && [ $kind = topic ] && [ $(( (now - age) / 86400 )) -ge "$idle" ]; then class=idle; fi
      class=${class:-active}
    fi
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "${prof:-(none)}" "$r" "$wt" "${owner:--}" "$kind" "${br:--}" "$pr" \
      "$age" "$dirty" "$unp" "${size:--}" "$inuse" "$class" "${bstate:--}" "$missing"
  done | tee "$cache/scan.tmp"
  # keep the last rows per profile for the cheap readers (fleet ls, capacity): fleet_wt_cached
  local pf; while IFS= read -r pf; do awk -F'\t' -v p="$pf" '$1 == p' "$cache/scan.tmp" > "$cache/rows-$(_wt_key "$pf").tsv"; done < <(cut -f1 "$cache/scan.tmp" | sort -u)
  rm -f "$cache/scan.tmp"
}
_wt_key() { printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_'; }
# fleet_wt_cached <profile>: the rows the last scan saw for that profile (no git, no du: fast enough for fleet ls and capacity).
# When they are older than FLEET_WT_CACHE_MIN minutes (default 10), or missing, a scan of that profile is started in the
# background (one at a time) so the next call is current. Prints nothing until a first scan finished.
fleet_wt_cached() {
  local cache="${FLEET_WT_CACHE:-$HOME/.fleet-state/cache}" f; f="$cache/rows-$(_wt_key "${1:-(none)}").tsv"
  if [ ! -f "$f" ] || [ -z "$(find "$f" -mmin -"${FLEET_WT_CACHE_MIN:-10}" 2>/dev/null)" ]; then
    mkdir -p "$cache"
    ( fleet_lock "$cache" "wt-refresh-$(_wt_key "${1:-none}")" 0 2>/dev/null || exit 0
      if [ -n "$1" ] && [ "$1" != "(none)" ]; then export FLEET_PROFILE=$1; fi
      fleet_wt_scan 0 cache >/dev/null 2>&1 ) </dev/null >/dev/null 2>&1 &
  fi
  [ ! -f "$f" ] || cat "$f"
}
_fleet_wt_roles=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../roles" 2>/dev/null && pwd)
