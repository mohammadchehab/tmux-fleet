# lib/lock.sh: one lock helper for every fleet script that changes shared state, so two terminals, the user and the peers can
# run fleet commands at the same time. Sourced, never run. Touches only <dir>/locks/ when a lock is taken.
# A lock is a folder <dir>/locks/<name>.lock (mkdir is atomic) holding the holder's pid, command and start time.
#   fleet_lock <dir> <name> [wait]  take it; wait up to <wait> seconds (default FLEET_LOCK_WAIT, else 30; 0 = fail at once),
#                                   then print "<script>: busy: <name> is held by pid <n> (<command>, <s> s)" and return 1.
#                                   Released when the script exits. A lock whose holder is dead is stale and is taken over.
#                                   Re-entrant: a lock an ancestor holds (FLEET_LOCKS, exported) is not taken again, so
#                                   fleet-scale add -> fleet-up and update -> link.sh do not deadlock.
#   fleet_lock_pass <dir> <name> <pid>  hand a lock this script holds to a background process (the handoff waiter) and stop
#                                   releasing it here; that process calls fleet_lock_adopt <dir> <name> to release it on exit
#   fleet_unlock <dir> <name>       release it now
# Locks the scripts take: fleet (per profile: fleet-up, fleet-down, fleet-scale, fleet-view), clear (fleet-clear),
# handoff-<peer> (fleet-handoff), board (board-jira, board-docs, board-decision), board-page (starting the board's page), and
# install (~/.fleet-state/locks: install, update, link, the board CLI).
[ -z "${_fleet_lock_loaded:-}" ] || return 0   # sourced twice (lib/backlog.sh, lib/worktree.sh): keep the held locks
_fleet_lock_loaded=1
_fleet_held=()
_fleet_lock_release() { local l; for l in ${_fleet_held[@]+"${_fleet_held[@]}"}; do rm -rf "$l"; done; _fleet_held=(); }
_fleet_lock_trap() { trap '_fleet_lock_release' EXIT; trap '_fleet_lock_release; exit 130' INT TERM; }
_fleet_lock_alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null; }
fleet_lock() {
  local dir=$1 name=$2 wait=${3:-${FLEET_LOCK_WAIT:-30}} l pid what since waited=0
  l="$dir/locks/$name.lock"
  # held by an ancestor: listed in FLEET_LOCKS and its holder still runs (a stale FLEET_LOCKS, e.g. inherited by a tmux server
  # that fleet-up started, never counts once that holder is gone)
  case " ${FLEET_LOCKS:-} " in *" $l "*) _fleet_lock_alive "$(cat "$l/pid" 2>/dev/null)" && return 0 ;; esac
  mkdir -p "$dir/locks"
  while ! mkdir "$l" 2>/dev/null; do
    pid=$(cat "$l/pid" 2>/dev/null || true)
    if [ -n "$pid" ] && ! _fleet_lock_alive "$pid"; then rm -rf "$l"; continue; fi   # stale: its holder is gone
    if [ -z "$pid" ] && [ "$waited" -ge 2 ]; then rm -rf "$l"; continue; fi             # half-made by a holder that died
    if [ "$waited" -ge "$wait" ]; then
      what=$(cat "$l/cmd" 2>/dev/null || echo "?"); since=$(cat "$l/since" 2>/dev/null || date +%s)
      echo "$(basename "$0"): busy: $name is held by pid ${pid:-?} ($what, $(( $(date +%s) - since )) s); try again shortly" >&2
      return 1
    fi
    sleep 1; waited=$((waited + 1))
  done
  echo $$ > "$l/pid"; echo "$(basename "$0") ${*:4}" > "$l/cmd"; date +%s > "$l/since"
  _fleet_held+=("$l"); _fleet_lock_trap
  export FLEET_LOCKS="${FLEET_LOCKS:-} $l"
}
fleet_unlock() {
  local l="$1/locks/$2.lock" k keep=()
  rm -rf "$l"
  for k in ${_fleet_held[@]+"${_fleet_held[@]}"}; do [ "$k" = "$l" ] || keep+=("$k"); done
  _fleet_held=(${keep[@]+"${keep[@]}"})
}
fleet_lock_pass() {
  local l="$1/locks/$2.lock" k keep=()
  echo "$3" > "$l/pid"
  for k in ${_fleet_held[@]+"${_fleet_held[@]}"}; do [ "$k" = "$l" ] || keep+=("$k"); done
  _fleet_held=(${keep[@]+"${keep[@]}"})
}
fleet_lock_adopt() { _fleet_held+=("$1/locks/$2.lock"); _fleet_lock_trap; }
