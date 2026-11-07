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
# opencode (via Ori) peer: the input box's border lines, the hint and MCP footer lines, the busy hint and the turn
# footer are chrome. Fixtures as captured from a real pane.
oc_box() { printf '┃\n┃  Ask anything… "Fix a TODO in the codebase"\n┃\n┃  Build · Qwen3.8 27B OpenRouter · medium\n╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀\n/tmp/proj  shift+tab agents  ctrl+p commands\n⊙ 1 MCP /mcps'; }
oc_pane() { printf '%s\n' "$1"; oc_box; }
oc_busy_pane() { printf '%s\n' "$1"; printf '┃\n┃\n┃  Build · Qwen3.8 27B OpenRouter · medium\n╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀\n⬝⬝⬝⬝⬝⬝⬝⬝ esc interrupt  20.5K (2%%) · $0.02  ctrl+p commands'; }
is idle   "$(oc_pane 'Done. TASK-5 is in Review.')"      "an opencode finished reply"
is asking "$(oc_pane 'Shall I take TASK-6 next?')"       "an opencode reply that ends with a question"
is busy   "$(oc_busy_pane 'Working…')"                   "an opencode running turn"
is unknown "$(printf '%s\n' 'Select an option:' '  1. Yes' '  2. No')" "an opencode dialog, no input box"
reply=$( { printf 'PONG\nBuild · Qwen3.8 27B · 1.4s · 14.8 tok/s\n'; oc_box; } | fleet_pane_reply | tail -1)
if [ "$reply" = 'PONG' ]; then pass=$((pass+1)); else echo "FAIL: the opencode reply must not include the turn footer: $reply"; fi
# capture-pane pads every line to the pane width, and the right-hand panel (Context, tokens, spend, MCP) rides on the
# reply's line as a far-right suffix: the reply keeps, the suffix goes
reply=$( { printf '%s%*s\n' 'The answer is B.' 100 '28,549 tokens'; printf '%*s%*s\n' 100 '' 50 'Context'; } | fleet_pane_clean)
if [ "$reply" = 'The answer is B.' ]; then pass=$((pass+1)); else echo "FAIL: the padded panel lines must be stripped, not the reply: $(printf '%s' "$reply" | sed 's/ */_/g')"; fi
echo "pane: $pass passed, $fail failed"
[ $fail -eq 0 ]
