# lib/roster.sh: the per-peer roster that lets `fleet up` (with no fleet running) resume the saved fleet after a
# restart or reboot. Sourced, never run. fleet-up sources lib/tmux.sh first (for fleet_state_dir) and lib/profile.sh.
#
# One file per peer in $FLEET_STATE/roster.d/<peer> as KEY=VALUE lines:
#     peer=<name>  role=<role>  cli=<claude|agent|opencode>  dir=<worktree path>  session_id=<the CLI's session/chat id>
# Model and effort are NOT stored: they come from the current models config at resume time, so a model change
# propagates to a resumed peer. The roster file is one per peer (not one shared file) because the peers' own claude
# hooks write their session_id back concurrently — one file per peer keeps those writes from racing.
# Written by fleet-up (the whole file, fresh or resume); updated in place by a claude peer's hook (session_id only).
# fleet-down keeps the roster (it stops sessions only); fleet-up and fleet-scale prune it so it mirrors the fleet.

_roster_dir() { echo "$1/roster.d"; }

# roster_get <state> <peer> <field>: the field's value (empty when absent)
roster_get() {
  local f v; f="$1/roster.d/$2"; [ -f "$f" ] || return 0
  v=$(sed -n "s/^$3=//p" "$f" 2>/dev/null | tail -1)
  printf '%s' "$v"
}

# roster_write <state> <peer> <role> <cli> <dir> <session_id>: (re)write the peer's whole roster file
roster_write() {
  local st=$1 peer=$2 role=$3 cli=$4 dir=$5 sid=$6 d
  d="$st/roster.d"; mkdir -p "$d"
  { printf 'peer=%s\n' "$peer"; printf 'role=%s\n' "$role"; printf 'cli=%s\n' "$cli"
    printf 'dir=%s\n' "$dir"; printf 'session_id=%s\n' "$sid"; } > "$d/$peer"
}

# roster_set_id <state> <peer> <session_id>: update just the session_id line (the peers' claude hooks call this; it
# creates a stub file only when absent, so it never clobbers the role/cli/dir fleet-up wrote)
roster_set_id() {
  local st=$1 peer=$2 sid=$3 f tmp
  [ -n "$sid" ] || return 0
  mkdir -p "$st/roster.d"; f="$st/roster.d/$peer"
  if [ -f "$f" ] && grep -q '^session_id=' "$f"; then
    tmp=$(mktemp); sed "s/^session_id=.*/session_id=$sid/" "$f" > "$tmp" && mv "$tmp" "$f"
  else
    printf 'peer=%s\nsession_id=%s\n' "$peer" "$sid" > "$f"
  fi
}

# roster_peers <state>: the peers with a roster file, one per line (sorted)
roster_peers() {
  local d f
  d="$1/roster.d"; [ -d "$d" ] || return 0
  for f in "$d"/*; do [ -e "$f" ] && echo "${f##*/}"; done | sort
}

# roster_has <state>: 0 when at least one roster file exists
roster_has() { [ -d "$1/roster.d" ] && [ -n "$(ls -A "$1/roster.d" 2>/dev/null)" ]; }

# roster_prune <state> <kept ...>: remove roster files for peers not in the kept set, so the roster mirrors the
# running fleet (fleet-up prunes to the peers it starts; fleet-scale remove prunes to the survivors)
roster_prune() {
  local st=$1; shift
  local d f p keep=" $* "
  d="$st/roster.d"; [ -d "$d" ] || return 0
  for f in "$d"/*; do
    [ -e "$f" ] || continue
    p=${f##*/}; case "$keep" in *" $p "*) ;; *) rm -f "$f" ;; esac
  done
}
