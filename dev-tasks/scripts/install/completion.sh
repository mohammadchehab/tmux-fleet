#!/usr/bin/env bash
# install/completion.sh: print the shell completion for the `fleet` command (bin/fleet), for bash or zsh. Touches nothing.
# Completes the commands, --profile <profile>, squads and roles for up, running peers (of the profile on the line, else
# FLEET_PROFILE) for attach, send, peek, handoff, clear and scale remove, and the fixed words of install, scale, decision,
# completion and profile. Lists come from `fleet _list …` at completion time, so new squads, profiles and peers show up at once.
# Usage: completion.sh bash|zsh     (zsh: eval "$(fleet completion zsh)" in ~/.zshrc; bash: in ~/.bashrc)
set -euo pipefail
shell=${1:-}
case "$shell" in bash|zsh) ;; *) echo "usage: fleet completion bash|zsh" >&2; exit 2 ;; esac
# zsh: compinit first when the shell has not run it (bashcompinit's complete needs compdef), then bash completion emulation
[ "$shell" = zsh ] && printf '%s\n' '(( $+functions[compdef] )) || { autoload -Uz compinit && compinit; }' 'autoload -U +X bashcompinit && bashcompinit'
cat <<'COMP'
_fleet() {
  local cur=${COMP_WORDS[COMP_CWORD]} prev=${COMP_WORDS[COMP_CWORD-1]} prof=${FLEET_PROFILE-} cmd= sub= i w
  for ((i = 1; i < COMP_CWORD; i++)); do
    w=${COMP_WORDS[i]}
    case "$w" in
      --profile) prof=${COMP_WORDS[i+1]-}; i=$((i + 1)) ;;
      --profile=*) prof=${w#--profile=} ;;
      -*) ;;
      *) if [ -z "$cmd" ]; then cmd=$w; elif [ -z "$sub" ]; then sub=$w; fi ;;
    esac
  done
  _fleet_ls() { FLEET_PROFILE=$prof fleet _list "$1" 2>/dev/null; }
  if [ "$prev" = --profile ]; then COMPREPLY=($(compgen -W "$(_fleet_ls profiles)" -- "$cur")); return; fi
  local words
  case "$cmd" in
    "") words="$(_fleet_ls commands) --profile" ;;
    up) words="$(_fleet_ls squads) $(_fleet_ls roles)" ;;
    attach|send|peek|handoff|clear) words="$(_fleet_ls peers)" ;;
    scale) case "$sub" in "") words="add remove roles" ;; add) words="$(_fleet_ls roles)" ;; remove) words="$(_fleet_ls peers)" ;; esac ;;
    install) words="claude cursor backlog bin" ;;
    wt|worktree) case "$sub" in "") words="ls prune new summary remind list" ;; ls) words="--stale --json --no-size --no-pr" ;;
      prune) words="--idle --nested --yes" ;; new) words="$(_fleet_ls peers)" ;; esac ;;
    decision) [ -n "$sub" ] || words="ask answer list show" ;;
    completion) words="bash zsh" ;;
    profile) [ -n "$sub" ] || words="init" ;;
    board) words="--no-open --iterm --vertical --milestones" ;;
  esac
  COMPREPLY=($(compgen -W "${words-}" -- "$cur"))
}
complete -F _fleet fleet
COMP
