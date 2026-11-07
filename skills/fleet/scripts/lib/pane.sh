# lib/pane.sh: read a peer's tmux pane the same way for Claude Code and Cursor's CLI. Source lib/tmux.sh first.
# Provides: fleet_pane, fleet_pane_cli, fleet_pane_state, fleet_pane_clean, fleet_pane_reply, fleet_busy.
# Patterns use alternation, not bracket expressions, so the box-drawing characters match in any locale.

# fleet_pane <peer> [history]: the visible pane, plus <history> lines of scrollback
fleet_pane() { if [ -n "${2:-}" ]; then tmux capture-pane -p -t "$(fleet_peer_target "$1")" -S "-$2" 2>/dev/null; else tmux capture-pane -p -t "$(fleet_peer_target "$1")" 2>/dev/null; fi; }

# fleet_pane_cli <peer> <pane text>: claude, agent or opencode. Cursor's CLI shows its footer ("Composer 2.5 · 58% · … Run
# Everything") under its input box, and "Add a follow-up" while that box is empty; Claude
# its "⏵⏵" status line; OpenCode its "Ask anything…" box and "ctrl+p commands" hint (via Ori's launcher, but the TUI is
# OpenCode's). With none on screen (a dialog, a review view) the pane's process decides: claude* is Claude, opencode* OpenCode.
# The CLI fleet-up recorded on the session (@fleet-cli) wins over all of these.
fleet_pane_cli() {
  local c; c=$(fleet_peer_cli "$1")
  if [ -n "$c" ]; then echo "$c"
  elif grep -qE 'Add a follow-up|Run Everything' <<<"$2"; then echo agent
  elif grep -qE '⏵⏵|\? for shortcuts' <<<"$2"; then echo claude
  elif grep -qE 'Ask anything…|ctrl\+p commands|esc interrupt' <<<"$2"; then echo opencode
  else case "$(tmux display -p -t "$(fleet_peer_target "$1")" '#{pane_current_command}' 2>/dev/null)" in claude*) echo claude;; opencode*) echo opencode;; *) echo agent;; esac; fi
}

# the bottom lines, where both CLIs print their input box and busy hint; earlier lines can quote the hint
_fleet_pane_bottom() { grep -v '^[[:space:]]*$' <<<"$1" | tail -8; }

# fleet_pane_clean: stdin -> stdout without the CLIs' chrome (input box, borders, status and footer lines, tips). The input
# box's line "❯ …" goes whole: what follows the prompt is never the peer's reply, but Claude Code's grey suggestion
# (ghost text such as "What's next on the board?") or a draft, and capture-pane loses the grey, so it would read as a reply
# ending in a question. OpenCode's right-hand panel (Context, token count, spend, MCP) pads its lines to the pane width and can
# ride on a reply's line, so the sed pass strips a panel token only when it is far-right (6+ spaces of separation).
fleet_pane_clean() {
  sed -E 's/[[:space:]]{6,}([0-9,]+ tokens|[0-9.]+% used|\$[0-9.]+ spent|• [A-Za-z0-9_-]+[[:space:]]+Connected|Context|MCP)[[:space:]]*$//' \
  | grep -vE -e '^[[:space:]]*$' -e '^[[:space:]]*(─|━|▄|▀)+[[:space:]]*$' -e '^[[:space:]]*❯' \
    -e '⏵⏵' -e '\? for shortcuts' -e 'Add a follow-up' -e '[0-9.]+% · ' -e '^[[:space:]]*[0-9]+ tasks?[[:space:]]*$' \
    -e '^[[:space:]]*~/[^ ]+ · [^ ]+[[:space:]]*$' -e 'Tip: ' -e 'display beneath the input box' -e '\(ctrl\+b ctrl\+b' \
    -e '^[[:space:]]*┃' -e '^[[:space:]]*╹' -e 'Ask anything…' -e 'ctrl\+p commands' -e 'shift\+tab agents' \
    -e '^[[:space:]]*⊙' -e 'esc interrupt' -e '[0-9.]+(ms|s) · [0-9.]+ tok/s' -e '\+ Thought' \
    -e '^[[:space:]]+[0-9,]+ tokens[[:space:]]*$' -e '^[[:space:]]+[0-9.]+% used[[:space:]]*$' \
    -e '^[[:space:]]+\$[0-9.]+ spent[[:space:]]*$' -e '^[[:space:]]+• .+ Connected[[:space:]]*$' \
    -e '^[[:space:]]+Context[[:space:]]*$' -e '^[[:space:]]+MCP[[:space:]]*$' || true
}

# fleet_pane_reply: stdin -> stdout, fleet_pane_clean without Claude's turn footer ("✻ Cooked for 8s · done 10:17 AM")
fleet_pane_reply() { fleet_pane_clean | { grep -vE '^(✻|✶|✳|✢|✽|·|\*) [A-Z][a-zé]+ for ' || true; }; }

# fleet_pane_state <pane text>: held (a peer message waits for the user's approval), busy (a turn is running),
# unknown (no input box on screen: a dialog or a review view), asking (idle, and the last reply ends with a question
# someone must answer), else idle. Busy: Claude's "esc to interr…" (cut short in narrow panes) or its spinner line
# "· Composing… (7m 56s", Cursor's "ctrl+c to stop", OpenCode's "esc interrupt".
fleet_pane_state() {
  local last bottom
  if grep -q 'Deliver this message to Claude' <<<"$1"; then echo held; return; fi
  bottom=$(_fleet_pane_bottom "$1")
  if grep -qE 'esc to interr|ctrl\+c to stop|esc interrupt|^(✻|✶|✳|✢|✽|·|\*) [A-Z][a-z]+… \(' <<<"$bottom"; then echo busy; return; fi
  if ! grep -qE '⏵⏵|\? for shortcuts|Add a follow-up|Run Everything|^[[:space:]]*❯|^[[:space:]]*┃|Ask anything…|ctrl\+p commands' <<<"$bottom"; then echo unknown; return; fi
  last=$(fleet_pane_reply <<<"$1" | tail -1)
  if [[ "$last" =~ \?[[:space:]]*$ ]]; then echo asking; else echo idle; fi
}

# fleet_busy <peer>: true while a turn is running in the peer's pane (either CLI)
fleet_busy() { [ "$(fleet_pane_state "$(fleet_pane "$1")")" = busy ]; }
