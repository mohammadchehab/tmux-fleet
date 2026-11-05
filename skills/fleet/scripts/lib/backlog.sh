# lib/backlog.sh: the fleet's board (Backlog.md) — which CLI, where its files live, which port, which tmux session. Sourced
# after lib/tmux.sh, never run. Touches nothing until a function is called.
# The board lives in $FLEET_STATE/backlog/ (one per profile, filesystem only, no git). Every peer gets BACKLOG_CWD=$FLEET_STATE,
# so `backlog …` and `backlog mcp start` reach the same board from any worktree. Its page runs in its own tmux session
# fleet-<profile>-board (fleet-board with no profile), tagged @fleet-profile and given no @fleet-role, so it is never a peer.
# Provides: FLEET_BACKLOG_VERSION (the pinned CLI; `task install:backlog` installs it), fleet_backlog (the CLI's path, empty if
# none), fleet_backlog_check (warn when the CLI is missing or not the pinned version), fleet_board_session, fleet_board_port,
# fleet_board_url, fleet_backlog_init <state dir>, fleet_board_start <state dir>, fleet_backlog_mcp_config <state dir>.
source "$(dirname "${BASH_SOURCE[0]}")/lock.sh"
FLEET_BACKLOG_VERSION=1.55.3
FLEET_BOARD_STATUSES='["Backlog", "Next", "In Progress", "Review", "Done"]'   # the sprint board's five columns

fleet_backlog() { command -v "${FLEET_BACKLOG_BIN:-backlog}" 2>/dev/null || true; }
# fleet_backlog_check: 0 when a CLI is on PATH (a version other than the pin is only warned about), 1 when there is none
fleet_backlog_check() {
  local b v; b=$(fleet_backlog)
  [ -n "$b" ] || { echo "board: no backlog CLI on PATH; install it with task install:backlog (Backlog.md $FLEET_BACKLOG_VERSION)" >&2; return 1; }
  v=$("$b" --version 2>/dev/null || true)
  [ "$v" = "$FLEET_BACKLOG_VERSION" ] || echo "board: backlog is ${v:-unknown}, the fleet pins $FLEET_BACKLOG_VERSION; run task install:backlog" >&2
  return 0
}
fleet_board_session() { echo "$FLEET_SESSION-board"; }
# fleet_board_port: FLEET_BOARD_PORT (environment or profile), else 6420 with no profile, else 6421-6920 derived from the
# profile name, so each profile keeps one bookmarkable URL and two profiles do not clash
fleet_board_port() {
  if [ -n "${FLEET_BOARD_PORT:-}" ]; then echo "$FLEET_BOARD_PORT"
  elif [ -z "$FLEET_SESSION_PROFILE" ]; then echo 6420
  else echo $((6421 + $(printf '%s' "$FLEET_SESSION_PROFILE" | cksum | cut -d' ' -f1) % 500)); fi
}
fleet_board_url() { echo "http://127.0.0.1:$(fleet_board_port)"; }
# fleet_backlog_init <state>: create <state>/backlog (no git, no agent files, no browser tab) with the five columns; a board
# that exists is left as it is
fleet_backlog_init() {
  local st=$1 b; b=$(fleet_backlog)
  [ ! -f "$st/backlog/config.yml" ] || return 0
  [ -n "$b" ] || return 1
  mkdir -p "$st"
  (cd "$st" && "$b" init "${FLEET_SESSION_PROFILE:-fleet}" --no-git --integration-mode none --auto-open-browser false \
    --check-branches false --include-remote false --defaults </dev/null >/dev/null) || return 1
  sed -i.bak -e "s/^statuses: .*/statuses: $FLEET_BOARD_STATUSES/" -e 's/^default_status: .*/default_status: "Backlog"/' \
    "$st/backlog/config.yml" && rm -f "$st/backlog/config.yml.bak"
}
# fleet_board_start <state>: start the page in fleet-<profile>-board unless that session runs already (then it is left alone);
# under the board-page lock, so two callers at once start it once
fleet_board_start() {
  local st=$1 s b rc=0; s=$(fleet_board_session); b=$(fleet_backlog)
  tmux has-session -t "$(fleet_target "$s")" 2>/dev/null && return 0
  [ -n "$b" ] && fleet_backlog_init "$st" || return 1
  fleet_lock "$st" board-page 15 || return 1
  if ! tmux has-session -t "$(fleet_target "$s")" 2>/dev/null; then
    tmux new-session -d -s "$s" -x 200 -y 50 -c "$st" "env -u FLEET_LOCKS $(printf '%q' "$b") browser --port $(fleet_board_port) --no-open" \
      && fleet_tag_session "$s" || rc=1
  fi
  fleet_unlock "$st" board-page; return $rc
}
# fleet_backlog_mcp_config <state>: write <state>/backlog-mcp.json (the stdio `backlog` MCP server on this board) and print its
# path, for `claude --mcp-config`; nothing in the target repo or the user's MCP settings changes
fleet_backlog_mcp_config() {
  local st=$1 b f; b=$(fleet_backlog); f="$1/backlog-mcp.json"
  [ -n "$b" ] || return 1
  jq -n --arg c "$b" --arg d "$st" '{mcpServers: {backlog: {command: $c, args: ["mcp", "start", "--cwd", $d]}}}' > "$f" || return 1
  echo "$f"
}
