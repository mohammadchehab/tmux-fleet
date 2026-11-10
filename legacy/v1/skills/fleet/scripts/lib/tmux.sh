# lib/tmux.sh: the one place the fleet scripts decide which tmux server they talk to. Sourced, never run. Touches nothing.
# Resolved once: FLEET_TMUX set -> private socket name (tmux -L); else inside tmux ($TMUX) -> that same server
# (tmux -S <path>), so a peer of a private fleet never reaches the live one; else tmux's default server.
# Provides: tmux (function), FLEET_TMUX_FLAGS (the same flags as a quoted string, for commands tmux runs itself),
# fleet_tmux_env (-e FLEET_TMUX=... for new-session), fleet_own_session, fleet_kill_session, fleet_peer_role, fleet_peer_cli, fleet_refuse_in_peer,
# FLEET_SESSION (this fleet's session name, the view), FLEET_SESSION_PROFILE (its profile, empty for none),
# fleet_session <peer> (a peer's session), fleet_peers (running peer names), fleet_state_dir (where this fleet's state lives).
# Session names carry the profile: fleet-<FLEET_PROFILE> (the view) and fleet-<FLEET_PROFILE>-<peer>; with no profile fleet and
# fleet-<peer>, so fleets of several profiles share one tmux server. Because fleet-<peer> and fleet-<profile>-<peer> share a
# prefix, every session fleet-up and fleet-view start is tagged @fleet-profile, and fleet_peers keeps only this fleet's tag.
# FLEET_PROFILE comes from the environment only (a profile file cannot set it).
if [ -n "${FLEET_TMUX:-}" ]; then _fleet_tmux_args=(-L "$FLEET_TMUX")
elif [ -n "${TMUX:-}" ]; then _fleet_tmux_args=(-S "${TMUX%%,*}")
else _fleet_tmux_args=(); fi
FLEET_TMUX_FLAGS=""; for _a in ${_fleet_tmux_args[@]+"${_fleet_tmux_args[@]}"}; do FLEET_TMUX_FLAGS+=" $(printf '%q' "$_a")"; done
tmux() { command tmux ${_fleet_tmux_args[@]+"${_fleet_tmux_args[@]}"} "$@"; }
# -e FLEET_TMUX=<socket> for tmux new-session (tmux >= 3.2), so every peer resolves to the same private socket
fleet_tmux_env() { [ -z "${FLEET_TMUX:-}" ] || printf '%s\n' -e "FLEET_TMUX=$FLEET_TMUX"; }
# the session the caller runs in, if that session is on the server we talk to; empty otherwise
fleet_own_session() {
  [ -n "${TMUX:-}" ] && [ -n "${TMUX_PANE:-}" ] || return 0
  local mine target
  mine=$(command tmux -S "${TMUX%%,*}" display -p -t "$TMUX_PANE" '#{session_name}' 2>/dev/null) || return 0
  target=$(tmux display -p '#{socket_path}' 2>/dev/null || true)
  # unknown target (no server yet) or the same socket: protect the name
  if [ -z "$target" ] || [ "$target" = "${TMUX%%,*}" ]; then echo "$mine"; fi
}
# fleet_target <session> [window]: the -t target that names exactly that session (=<session>:[window]), for every tmux command
# (session, window and pane commands alike). A plain -t fleet-engineer falls back to a prefix match when that session is gone,
# so a message, a kill or a capture would hit fleet-engineer-2, or the board when the view is down. Never pass a bare name.
fleet_target() { echo "=$1:${2:-}"; }
# fleet_peer_target <peer>: fleet_target of that peer's session in this fleet
fleet_peer_target() { fleet_target "$(fleet_session "$1")"; }
# kill a session unless it is the one the caller runs in; say what was skipped
fleet_kill_session() {
  local own; own=$(fleet_own_session)
  if [ -n "$own" ] && [ "$own" = "$1" ]; then echo "skipped $1 (the session this command runs in)"; return 1; fi
  tmux kill-session -t "$(fleet_target "$1")" 2>/dev/null
}
# this fleet's profile: FLEET_PROFILE; else the @fleet-profile tag of the caller's own session (a peer or the user's view), so
# a script run inside a fleet's session targets that fleet; else none
_fleet_session_profile() {
  if [ -n "${FLEET_PROFILE:-}" ]; then echo "$FLEET_PROFILE"; return; fi
  local own; own=$(fleet_own_session)
  case "$own" in fleet|fleet-*) tmux show-options -qv -t "$(fleet_target "$own")" @fleet-profile 2>/dev/null || true ;; esac
}
FLEET_SESSION_PROFILE=$(_fleet_session_profile)
FLEET_SESSION=fleet${FLEET_SESSION_PROFILE:+-$FLEET_SESSION_PROFILE}
# fleet_session <peer>: the tmux session of that peer in this fleet
fleet_session() { echo "$FLEET_SESSION-$1"; }
# fleet_tag_session <session>: mark a session this fleet started with its profile (read by fleet_peers and _fleet_session_profile)
fleet_tag_session() { tmux set-option -t "$(fleet_target "$1")" @fleet-profile "$FLEET_SESSION_PROFILE"; }
# fleet_peers: the names of this fleet's running peers ($FLEET_SESSION-<peer> tagged with this fleet's profile), one per line.
# The tag keeps fleet-isnadi-bot-engineer out of fleet isnadi, and fleet-isnadi-engineer out of the unprofiled fleet.
# The board's session ($FLEET_SESSION-board, lib/backlog.sh) is not a peer and is never listed.
fleet_peers() {
  local s tag
  while IFS='|' read -r s tag; do
    case "$s" in "$FLEET_SESSION"-board) continue ;; "$FLEET_SESSION"-?*) ;; *) continue ;; esac
    [ "$tag" = "$FLEET_SESSION_PROFILE" ] || continue
    echo "${s#"$FLEET_SESSION"-}"
  done < <(tmux ls -F '#{session_name}|#{@fleet-profile}' 2>/dev/null || true)
}
# fleet_state_dir: where this fleet's state lives (fleet-context.md, scratchpad.md, handoff.md, <peer>-state.md):
# FLEET_STATE, else ~/.fleet-state/<profile>, else ~/.fleet-state with no profile. Read at call time, so a profile's
# FLEET_STATE (loaded after this file) still wins.
fleet_state_dir() { echo "${FLEET_STATE:-$HOME/.fleet-state${FLEET_SESSION_PROFILE:+/$FLEET_SESSION_PROFILE}}"; }
# fleet_peer_role <peer>: the role fleet-up recorded on the peer's session (@fleet-role), else the peer name minus -N
fleet_peer_role() { local r; r=$(tmux show-options -qv -t "$(fleet_peer_target "$1")" @fleet-role 2>/dev/null || true); echo "${r:-${1%-[0-9]*}}"; }
# fleet_peer_cli <peer>: the CLI fleet-up recorded on the peer's session (@fleet-cli: claude or agent); empty if none was
fleet_peer_cli() { tmux show-options -qv -t "$(fleet_peer_target "$1")" @fleet-cli 2>/dev/null || true; }
# fleet_refuse_in_peer <script>: exit unless the caller is outside every peer session (one fleet-up tagged @fleet-role)
# of the server it targets. The views (fleet, fleet-<profile>) carry no role, so the user can run it from there.
# Starting or stopping the fleet is the user's call, from their own shell; a peer that runs fleet-up kills its team.
# FLEET_ALLOW_IN_PEER=1 overrides it (the user, on purpose).
fleet_refuse_in_peer() {
  local own; own=$(fleet_own_session)
  [ -n "$own" ] && [ -n "$(tmux show-options -qv -t "$(fleet_target "$own")" @fleet-role 2>/dev/null || true)" ] \
    && [ "${FLEET_ALLOW_IN_PEER:-}" != 1 ] || return 0
  echo "$1: refused: this runs inside peer session $own. Starting or stopping the fleet is the user's call; ask them to run it from their own shell." >&2
  exit 1
}
