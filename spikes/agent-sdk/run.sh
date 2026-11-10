#!/usr/bin/env bash
# Runs every probe for one provider; captures the raw SDK stream and the PROBE_RESULT evidence line.
set -uo pipefail
cd "$(dirname "$0")"
provider="${1:?usage: run.sh <claude|deepinfra>}"
mkdir -p results
for p in events usage question permission interrupt model compaction switch structured; do
  printf '%-34s' "$provider/$p"
  PROBE_WATCHDOG_MS=90000 node probe.mjs "$p" "$provider" > "results/${provider}-${p}.log" 2>&1
  echo "exit=$?"
done
PROBE_WATCHDOG_MS=90000 node probe.mjs resume-write "$provider" > "results/${provider}-resume-write.log" 2>&1
echo "$provider/resume-write exit=$?"
PROBE_WATCHDOG_MS=90000 node probe.mjs resume-read  "$provider" > "results/${provider}-resume-read.log" 2>&1
echo "$provider/resume-read exit=$?"
grep -h '^PROBE_RESULT' results/${provider}-*.log | sed 's/^PROBE_RESULT //' > "results/${provider}-evidence.jsonl"
echo "evidence -> results/${provider}-evidence.jsonl"
