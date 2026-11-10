#!/usr/bin/env bash
# test/profile.sh: the profile loader (skills/fleet/scripts/lib/profile.sh) and the profile lint (lint/profile.sh).
# Loader: parsed not sourced (a command in a value never runs), only FLEET_* keys, empty = unset, trailing comment stripped,
# ~ and $HOME expanded, precedence environment > profile > default, unknown profile fails, FLEET_REPO falls back to the
# main checkout of the repo you are in (also from a linked worktree), no repo and no profile fails, works through a symlink,
# a profile is looked up in the user's folder first and then in the repo (the user's wins; the error names both places).
# Lint: clean passes, a restated whole token fails and prints the AGENTS.md line, a token inside a longer word and tokens
# under 4 characters pass, '# lint: allow <reason>' passes (a reason is required), a missing repo prints "skipped:".
# Touches only a temp directory (removed on exit); no tmux, no network.
# Usage: profile.sh
set -euo pipefail
source "$(dirname "$0")/../lib/env.sh"
cd "$ROOT"
fail=0; pass=0
ok() { pass=$((pass+1)); }
bad() { echo "FAIL: $*"; fail=$((fail+1)); }
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
LIB="$ROOT/skills/fleet/scripts/lib/profile.sh"
mkdir -p "$t/profiles" "$t/home" "$t/none"
export GIT_CEILING_DIRECTORIES="$t"

# ---- loader
cat > "$t/profiles/p.env" <<EOF
# comment
FLEET_REPO=~/target
FLEET_SQUAD=big   # a trailing comment
FLEET_EMPTY=
FLEET_PWN=\$(touch $t/pwned)
FLEET_QUOTED="two words"
NOTFLEET=nope
fleet_lower=nope
EOF
load() { env -i HOME="$t/home" PATH="$PATH" FLEET_PROFILES_DIR="$t/profiles" "$@" bash -c "source '$LIB'; $LOAD_CMD"; }
LOAD_CMD='fleet_load_profile; printf "%s|%s|%s|%s|%s|%s\n" "${FLEET_REPO-unset}" "${FLEET_SQUAD-unset}" "${FLEET_EMPTY-unset}" "${FLEET_QUOTED-unset}" "${NOTFLEET-unset}" "${fleet_lower-unset}"'
out=$(load FLEET_PROFILE=p)
[ "$out" = "$t/home/target|big|unset|two words|unset|unset" ] && ok || bad "loader values: $out"
[ ! -e "$t/pwned" ] && ok || bad "a command in a profile value was executed"
out=$(load FLEET_PROFILE=p FLEET_REPO=/explicit FLEET_SQUAD=mine)
[ "$out" = "/explicit|mine|unset|two words|unset|unset" ] && ok || bad "environment must win: $out"
out=$(load)
[ "$out" = "unset|unset|unset|unset|unset|unset" ] && ok || bad "no profile loads nothing: $out"
LOAD_CMD='fleet_load_profile'; if load FLEET_PROFILE=missing >/dev/null 2>"$t/err"; then bad "unknown profile must fail"; else grep -q "no profile 'missing'" "$t/err" && ok || bad "unknown profile message: $(cat "$t/err")"; fi

# the user's folder (~/.config/fleet/profiles) comes first, then the repo's profiles folder
mkdir -p "$t/home/.config/fleet/profiles"
printf 'FLEET_SQUAD=fromuser\n' > "$t/home/.config/fleet/profiles/u.env"
LOAD_CMD='fleet_load_profile; printf "%s|%s\n" "${FLEET_REPO-unset}" "${FLEET_SQUAD-unset}"'
out=$(load FLEET_PROFILE=u)
[ "$out" = "unset|fromuser" ] && ok || bad "a profile in the user's folder must load: $out"
printf 'FLEET_SQUAD=fromuser\n' > "$t/home/.config/fleet/profiles/p.env"
out=$(load FLEET_PROFILE=p)
[ "$out" = "unset|fromuser" ] && ok || bad "the user's profile must win over the repo's of the same name: $out"
rm -f "$t/home/.config/fleet/profiles/p.env"
out=$(load FLEET_PROFILE=p)
[ "$out" = "$t/home/target|big" ] && ok || bad "with no user profile the repo's must load: $out"
out=$(env -i HOME="$t/home" PATH="$PATH" XDG_CONFIG_HOME="$t/xdg" FLEET_PROFILES_DIR="$t/profiles" FLEET_PROFILE=u bash -c "source '$LIB'; fleet_load_profile" 2>&1) \
  && bad "XDG_CONFIG_HOME must move the user's folder, so u.env is not found there" || { echo "$out" | grep -q "$t/xdg/fleet/profiles/u.env" && ok || bad "the error must name the user path and the repo path: $out"; }
LOAD_CMD='fleet_load_profile'

# FLEET_REPO from the repo you are in: the main checkout, also from a linked worktree
git init -q -b main "$t/repo"; git -C "$t/repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
git -C "$t/repo" worktree add -q --detach "$t/repo/.claude/worktrees/x" main
LOAD_CMD='fleet_resolve_repo && echo "$REPO"'
here() { (cd "$1" && env -i HOME="$t/home" PATH="$PATH" GIT_CEILING_DIRECTORIES="$t" bash -c "source '$LIB'; fleet_resolve_repo && echo \"\$REPO\""); }
[ "$(here "$t/repo")" = "$(cd "$t/repo" && pwd -P)" ] && ok || bad "REPO from the main checkout: $(here "$t/repo")"
[ "$(here "$t/repo/.claude/worktrees/x")" = "$(cd "$t/repo" && pwd -P)" ] && ok || bad "REPO from a linked worktree must be the main checkout: $(here "$t/repo/.claude/worktrees/x")"
if here "$t/none" >/dev/null 2>"$t/err"; then bad "no repo and no profile must fail"; else grep -q 'no target repo' "$t/err" && ok || bad "no-repo message: $(cat "$t/err")"; fi

# reached through a symlink (how ~/.claude/skills reaches it)
ln -s "$ROOT/skills/fleet" "$t/link"
out=$(env -i HOME="$t/home" PATH="$PATH" bash -c "source '$t/link/scripts/lib/profile.sh'; echo \"\$FLEET_ROOT\"")
[ "$out" = "$(cd "$ROOT" && pwd -P)" ] && ok || bad "FLEET_ROOT through a symlink: $out"

# the scripts use it: fleet-worktree needs a repo and names none of its own
out=$(env -i HOME="$t/home" PATH="$PATH" FLEET_PROFILES_DIR="$t/profiles" FLEET_PROFILE=p FLEET_REPO="$t/repo" "$ROOT/skills/fleet/scripts/fleet-worktree" list 2>&1) && ok || bad "fleet-worktree list with a profile failed: $out"
grep -rn "Dev/sn""b" "$ROOT/skills/fleet/scripts" "$ROOT/skills/fleet-scale/scripts" "$ROOT/skills/fleet-pr-queue/scripts" >/dev/null 2>&1 && bad "a script still hard-codes a home path to the target repo" || ok

# ---- lint
rm -rf "$t/home/.config"   # the loader cases above left profiles there; the lint section starts clean
L="$ROOT/dev-tasks/scripts/lint/profile.sh"
mkdir -p "$t/lrepo" "$t/lp"
cat > "$t/lrepo/AGENTS.md" <<'EOF'
# Project
Tracker: **ACME** at https://acme.example.net/boards/1; the table of squads is below.
The squad owns the folder.
EOF
lint() { env HOME="$t/home" FLEET_PROFILES_DIR="$t/lp" "$L"; }
put() { printf 'FLEET_REPO=%s\n%s\n' "${2:-$t/lrepo}" "$1" > "$t/lp/x.env"; }
put 'FLEET_HOST=other-host'; lint >/dev/null && ok || bad "lint: a clean profile must pass"
put 'FLEET_KEY=ACME'; out=$(lint || true); echo "$out" | grep -q "FAIL x.env:2 FLEET_KEY 'ACME'" && echo "$out" | grep -q 'AGENTS.md:2:' && ok || bad "lint: a restated token must fail with the AGENTS.md line: $out"
put 'FLEET_KEY=ACME'; lint >/dev/null 2>&1 && bad "lint: exit status must be non-zero on a hit" || ok
put 'FLEET_HOST=acme.example.net'; out=$(lint || true); echo "$out" | grep -q FAIL && ok || bad "lint: a host inside a URL must be flagged: $out"
put 'FLEET_KEY=tabl'; lint >/dev/null && ok || bad "lint: a token inside a longer word must not be flagged"
put 'FLEET_KEY=squ'; lint >/dev/null && ok || bad "lint: a token under 4 characters must not be flagged"
put 'FLEET_KEY=squad  # lint: allow names a fleet squad file'; out=$(lint) && echo "$out" | grep -q 'allowed x.env:2' && ok || bad "lint: an allowed hit must pass and be listed: $out"
put 'FLEET_KEY=squad  # lint: allow'; lint >/dev/null 2>&1 && bad "lint: allow without a reason must fail" || ok
put 'FLEET_KEY=ACME' "$t/nowhere"; out=$(lint) && echo "$out" | grep -q "skipped: $t/nowhere/AGENTS.md not found" && ok || bad "lint: a missing repo must print 'skipped:': $out"
mkdir -p "$t/home/r2"; cp "$t/lrepo/AGENTS.md" "$t/home/r2/AGENTS.md"
# the user's folder is linted too (real profiles live there)
mkdir -p "$t/home/.config/fleet/profiles"; rm -f "$t/lp/x.env"
printf 'FLEET_REPO=%s\nFLEET_KEY=ACME\n' "$t/lrepo" > "$t/home/.config/fleet/profiles/real.env"
out=$(env HOME="$t/home" XDG_CONFIG_HOME="$t/home/.config" FLEET_PROFILES_DIR="$t/lp" "$L" 2>&1 || true); echo "$out" | grep -q "FAIL real.env:2 FLEET_KEY 'ACME'" && ok || bad "lint: a profile in the user's folder must be checked: $out"
rm -f "$t/home/.config/fleet/profiles/real.env"
# shellcheck disable=SC2088  # the literal ~ is the input: the lint must expand it itself
put 'FLEET_KEY=ACME' '~/r2'; lint >/dev/null 2>&1 && bad "lint: ~ in FLEET_REPO must be expanded (hit expected)" || ok
echo "profile: $pass passed, $fail failed"
[ $fail -eq 0 ]
