#!/usr/bin/env bash
# lint/skills.sh: every skills/<folder>/SKILL.md has frontmatter with a `name` equal to the folder name and a `description`.
# It also fails on a hard-coded Jira key: anything shaped like ABC-123 (except the ordinary non-Jira prefixes listed, and TASK-<n>, a board card id,
# below) and the project keys this repo used to hardcode (bare, too), in skills/, README.md, profiles/ and dev-tasks/. The project, board and site
# come from the target repo's AGENTS.md; write <KEY>-<n>. A justified line carries `lint: allow <reason>`.
# Touches nothing (read-only).
# Usage: skills.sh
set -euo pipefail
source "$(dirname "$0")/../lib/env.sh"
cd "$ROOT"
bad=0; n=0
for d in skills/*/; do
  n=$((n+1)); f="${d}SKILL.md"; folder=$(basename "$d"); want=$folder
  [ -f "$f" ] || { echo "FAIL $folder: no SKILL.md"; bad=1; continue; }
  fm=$(awk 'NR==1 && $0!="---" {exit} NR>1 && $0=="---" {exit} NR>1 {print}' "$f")
  name=$(printf '%s\n' "$fm" | sed -n 's/^name:[[:space:]]*//p' | head -1)
  printf '%s\n' "$fm" | grep -q '^description:' || { echo "FAIL $folder: frontmatter has no description"; bad=1; }
  [ "$name" = "$want" ] || { echo "FAIL $folder: name is '$name', want '$want'"; bad=1; }
done
# no hard-coded Jira keys, boards or sites (the old keys are built from hex so this file does not contain them)
OLD_KEYS=$(printf '\\b(\x4d\x45\x53\x49|\x53\x4e\x42\x44\x47)\\b')
NOT_JIRA='EXAMPLE|TASK|ADR|UTF|SHA|PID|ISO|RFC|TLS|CVE|CWE|HTTP|IPV|AES|RSA|HS|RS|ES'
hits=$(grep -rnE --exclude-dir=.git --exclude=skills.sh --exclude-dir=test "$OLD_KEYS|\b[A-Z][A-Z0-9]+-[0-9]+\b" skills README.md profiles dev-tasks Taskfile.yaml 2>/dev/null | grep -v 'lint: allow' || true)
while IFS= read -r line; do
  [ -n "$line" ] || continue
  text=${line#*:*:}
  if printf '%s\n' "$text" | grep -qE "$OLD_KEYS"; then echo "FAIL jira key: $line"; bad=1; continue; fi
  printf '%s\n' "$text" | grep -oE '\b[A-Z][A-Z0-9]+-[0-9]+\b' | grep -vE "^($NOT_JIRA)-" >/dev/null && { echo "FAIL jira key: $line"; bad=1; }
done <<< "$hits"
[ $bad -eq 0 ] && echo "skills: $n frontmatters ok"
exit $bad
