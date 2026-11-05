#!/usr/bin/env bash
# test/profile-init.sh: profile/init.sh writes a loadable per-user profile and refuses bad input.
# Cases: writes FLEET_REPO (the main checkout, also when given a linked worktree, ~ shown for $HOME), FLEET_SQUAD and
# FLEET_USER (the repo's git user.name), the
# loader reads it back, the default squad is squad, an existing profile is never overwritten, and a bad name, a non-repo
# path, an unknown squad and missing arguments fail. Touches only a temp directory (removed on exit); no tmux, no network.
# Usage: profile-init.sh
set -euo pipefail
source "$(dirname "$0")/../lib/env.sh"
fail=0; pass=0
ok() { pass=$((pass+1)); }
bad() { echo "FAIL: $*"; fail=$((fail+1)); }
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
I="$ROOT/dev-tasks/scripts/profile/init.sh"
mkdir -p "$t/home"
export GIT_CEILING_DIRECTORIES="$t"
git init -q -b main "$t/home/repo"; git -C "$t/home/repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
git -C "$t/home/repo" worktree add -q --detach "$t/home/repo/.claude/worktrees/w" main
run() { env -i HOME="$t/home" PATH="$PATH" GIT_CEILING_DIRECTORIES="$t" "$I" "$@"; }
P="$t/home/.config/fleet/profiles"

out=$(run demo "$t/home/repo" spec 2>&1) && ok || bad "init must succeed: $(run demo2 "$t/home/repo" spec 2>&1)"
grep -qx 'start with: fleet --profile demo up \[squad\]' <<<"$out" && ok || bad "init must say how to start it with the fleet command: $out"
grep -qx 'FLEET_REPO=~/repo' "$P/demo.env" && ok || bad "FLEET_REPO must be ~/repo: $(grep FLEET_REPO "$P/demo.env")"
grep -q '^FLEET_SQUAD=spec' "$P/demo.env" && ok || bad "FLEET_SQUAD must be spec: $(grep FLEET_SQUAD "$P/demo.env")"
out=$(env -i HOME="$t/home" PATH="$PATH" FLEET_PROFILE=demo bash -c "source '$ROOT/skills/fleet/scripts/lib/profile.sh'; fleet_load_profile; echo \"\$FLEET_REPO|\$FLEET_SQUAD\"")
[ "$out" = "$t/home/repo|spec" ] && ok || bad "the loader must read it back: $out"

run wt "$t/home/repo/.claude/worktrees/w" >/dev/null 2>&1 && grep -qx 'FLEET_REPO=~/repo' "$P/wt.env" && ok || bad "a linked worktree must resolve to the main checkout"
grep -q '^FLEET_SQUAD=squad' "$P/wt.env" && ok || bad "the default squad must be squad"

# FLEET_USER comes from the target repo's git user.name and the loader reads it back
git -C "$t/home/repo" config user.name "Ada Lovelace"
run who "$t/home/repo" >/dev/null 2>&1 && ok || bad "init with a git user must succeed: $(run who2 "$t/home/repo" 2>&1)"
out=$(env -i HOME="$t/home" PATH="$PATH" FLEET_PROFILE=who bash -c "source '$ROOT/skills/fleet/scripts/lib/profile.sh'; fleet_load_profile; echo \"\$FLEET_USER\"")
[ "$out" = "Ada Lovelace" ] && ok || bad "FLEET_USER must be the repo's git user.name: $out"
git -C "$t/home/repo" config --unset user.name
cp "$P/demo.env" "$t/before"
run demo "$t/home/repo" >/dev/null 2>&1 && bad "an existing profile must not be overwritten" || ok
cmp -s "$P/demo.env" "$t/before" && ok || bad "the existing profile changed"

run Bad_Name "$t/home/repo" >/dev/null 2>&1 && bad "a bad name must fail" || ok
mkdir -p "$t/home/plain"
run plain "$t/home/plain" >/dev/null 2>&1 && bad "a non-repo path must fail" || ok
[ ! -e "$P/plain.env" ] && ok || bad "a failed init must write nothing"
run sq "$t/home/repo" nosuchsquad >/dev/null 2>&1 && bad "an unknown squad must fail" || ok
run onlyname >/dev/null 2>&1 && bad "missing arguments must fail" || ok

echo "profile-init: $pass passed, $fail failed"
[ $fail -eq 0 ]
