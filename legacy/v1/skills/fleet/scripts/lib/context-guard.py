#!/usr/bin/env python3
"""context-guard.py <peer> <state file> <state dir> <limit tokens> <fleet-handoff>: the Stop-hook half of
fleet-context-guard (see that script). Reads the hook's JSON on stdin. Prints nothing and exits 0, except to block the stop
once, with a {"decision":"block","reason":...} line asking the peer for its state file. Never raises into the peer.

Tokens are counted like skills/fleet-clear/scripts/peer-tokens: input + cache read + cache creation of the last assistant
message with usage in the transcript. A state file is fresh when it was written after the transcript's last real user
message (a tool result is not one), so a state left over from an earlier turn never counts.
"""
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone


def tokens_and_last_user(path):
    usage, last_user = None, 0.0
    with open(path, errors="replace") as f:
        for line in f:
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            message = entry.get("message")
            if not isinstance(message, dict):
                continue
            if message.get("usage"):
                usage = message["usage"]
            if entry.get("type") == "user" and not entry.get("isMeta") and real_user_text(message.get("content")):
                try:
                    last_user = datetime.fromisoformat(entry["timestamp"].replace("Z", "+00:00")).timestamp()
                except (KeyError, ValueError, AttributeError):
                    pass
    n = None if usage is None else sum(usage.get(k, 0) or 0 for k in ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"))
    return n, last_user


def real_user_text(content):
    if isinstance(content, str):
        return bool(content.strip())
    return isinstance(content, list) and any(isinstance(b, dict) and b.get("type") == "text" for b in content)


def log(state_dir, text):
    with open(os.path.join(state_dir, "context-guard.log"), "a") as f:
        f.write(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()) + " " + text + "\n")


def main():
    peer, state, state_dir, limit, handoff = sys.argv[1:6]
    hook = json.load(sys.stdin)
    path = hook.get("transcript_path") or ""
    if not path or not os.path.exists(path):
        return
    tokens, last_user = tokens_and_last_user(path)
    limit = int(limit)
    if tokens is None or tokens <= limit:
        return
    k = lambda n: f"{n // 1000}k"
    fresh = os.path.isfile(state) and os.path.getsize(state) > 0 and os.path.getmtime(state) >= last_user
    if fresh:
        r = subprocess.run([handoff, peer], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                           text=True, timeout=30)
        log(state_dir, f"{peer} {k(tokens)} tokens (limit {k(limit)}): handoff " + ("started" if r.returncode == 0 else f"FAILED: {r.stdout.strip()[:200]}"))
    elif hook.get("stop_hook_active"):
        log(state_dir, f"{peer} {k(tokens)} tokens (limit {k(limit)}): MISS, no fresh {state}, stop let through")
    else:
        print(json.dumps({"decision": "block", "reason":
            f"Context is {k(tokens)} tokens (limit {k(limit)}). Write your state to {state}: card, branch, PR, what is done, "
            "the next step. Then end your turn; a fresh copy of you picks it up."}, separators=(",", ":")))


try:
    main()
except Exception:
    pass
