---
name: fleet-cc-send
description: Claude Code only (finds sessions by Claude's peer socket in /tmp/cc-socks). Type a slash command or text into other running Claude Code sessions on this Mac (tmux panes, including the fleet's fleet-<profile>-<peer> sessions, or iTerm2 tabs), e.g. /clear or /compact one session or all of them. Use when asked to clear, compact, reset or send a command to a peer session, or to list the live sessions.
---

# fleet-cc-send: remote keystrokes into peer sessions

Peer messages (SendMessage) cannot run slash commands in another session. This skill types into the session's
terminal instead, found by the TTY of its peer socket `/tmp/cc-socks/<pid>.sock`: a tmux pane on that TTY gets
`tmux send-keys`, otherwise the iTerm2 tab on it gets `write text`. SendMessage and cc-send both reach claude peers
only (Claude's sockets); a peer on another CLI (opencode, Cursor) is reached with `fleet send "<text>" <peer>`
instead — the fleet skill's cross-CLI messaging rule (rule 13).

Script: `~/.claude/skills/fleet-cc-send/scripts/cc-send` (also `~/bin/cc-send`; the command keeps its short name, only the skill is `fleet-cc-send`).

```
cc-send                      # list live sessions: pid, tty, name (tmux status-bar name or iTerm2 tab)
cc-send architect /clear     # exact pid/tty/name wins; else substring ("engineer" = all engineers)
cc-send --all /compact       # every live session
cc-send 74520 "continue with the next task"   # any text, Enter is appended
```

Rules:
- `$ARGUMENTS` is `<match> <text>`; run the script with them as two arguments (quote the text).
- Never send `/clear` or `/compact` to the session you are running in: list first, and skip the row whose tab name is
  this session's own title (iTerm2 shows it in the tab). With `--all`, send to the others one by one instead.
- Report the script's output verbatim: one line per session reached, or the "no session matches" error.
- tmux and iTerm2 sessions are both reachable; a session in another terminal is listed with an empty name and
  cannot be typed into (say so instead of guessing).
- A busy session queues the typed line until its turn ends. To interrupt first, a fleet peer takes
  `~/.claude/skills/fleet/scripts/fleet-send -f "<text>" <peer>`.
