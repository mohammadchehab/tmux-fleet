#!/usr/bin/env bash
# lint/shell.sh: shellcheck every shell script in the repo (files with a bash/sh shebang under skills/, dev-tasks/ and bin/).
# Touches nothing (read-only).
# Usage: shell.sh
set -euo pipefail
source "$(dirname "$0")/../lib/env.sh"
need shellcheck
cd "$ROOT"
files=()
while IFS= read -r f; do
  head -1 "$f" | grep -qE '^#!.*\b(ba)?sh\b' && files+=("$f")
done < <(find skills dev-tasks bin -type f ! -name '*.md')
[ ${#files[@]} -gt 0 ] || { echo "lint: no shell scripts found" >&2; exit 1; }
# SC2207 excluded: the fleet scripts split tmux/squad output into arrays and must run on macOS bash 3.2 (no mapfile).
shellcheck -x -S warning --exclude=SC2207 "${files[@]}"
echo "shellcheck: ${#files[@]} scripts clean"
