#!/usr/bin/env bash
# test/pane.sh: how skills/fleet/scripts/lib/pane.sh reads a peer's pane, on fixture panes (no tmux): idle, asking, busy, held,
# unknown, and Claude Code's grey suggestion in the input box (ghost text such as "What's next on the board?"), which is not a
# reply and must read idle, not asking. Touches nothing. Usage: pane.sh
set -euo pipefail
source "$(dirname "$0")/../lib/env.sh"
fail=0; pass=0
source "$ROOT/skills/fleet/scripts/lib/pane.sh"
is() { local got; got=$(fleet_pane_state "$2"); if [ "$got" = "$1" ]; then pass=$((pass+1)); else echo "FAIL: $3: want $1, got $got"; fail=$((fail+1)); fi; }
rule='────────────────────────────────────────'
foot='  ⏵⏵ bypass permissions on (shift+tab to cycle)'
pane() { printf '%s\n' "$@" "$rule" "${PROMPT_LINE:-❯ }" "$rule" "$foot"; }
is idle   "$(pane '⏺ Done. TASK-3 is in Review.')"                                      "a finished reply"
is asking "$(pane '⏺ Shall I take TASK-4 next?')"                                         "a reply that ends with a question"
is idle   "$(PROMPT_LINE="❯ What's next on the board?" pane '⏺ Done. TASK-3 is in Review.')" "a grey suggestion ending in ?"
is idle   "$(PROMPT_LINE='❯ B, remove engineer-2' pane '⏺ Removed engineer-3 as asked.')"  "a grey suggestion (the PM's row)"
is asking "$(PROMPT_LINE="❯ What's next on the board?" pane '⏺ Which option, A or B?')"    "a real question under a suggestion"
is busy   "$(pane '⏺ Reading files' '✻ Composing… (12s · esc to interrupt)')"            "a running turn"
is held   "$(pane '⏺ Done.' 'Deliver this message to Claude?')"                           "a held peer message"
is unknown "$(printf '%s\n' 'Select an option:' '  1. Yes' '  2. No')"                    "a dialog, no input box"
reply=$(PROMPT_LINE="❯ What's next on the board?" pane '⏺ Done. TASK-3 is in Review.' | fleet_pane_reply | tail -1)
if [ "$reply" = '⏺ Done. TASK-3 is in Review.' ]; then pass=$((pass+1)); else echo "FAIL: the reply shown must not be the suggestion: $reply"; fail=$((fail+1)); fi
echo "pane: $pass passed, $fail failed"
[ $fail -eq 0 ]
