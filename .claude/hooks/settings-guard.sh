#!/usr/bin/env bash
# hooks: applies_to=all
# A model never writes a `.claude/settings.json`: it is the user's. PreToolUse
# hook on Write, Edit, MultiEdit and Bash; see ../settings.json.
# Tests: bash .claude/hooks/test-settings-guard.sh
#
# Blocked (exit 2), whoever the caller is: any path whose last two parts are
# `.claude/settings.json` -- a repo's, the workspace top's, the user scope's.
# The way through is `.claude/settings.proposed.json` beside it, which the user
# reads and applies himself (a `!` command skips this hook). Other files named
# settings.json (.vscode/, a package's config) are not touched. Why it exists:
# PLAN-hard-gates.md §3 row 9; until now only the top-level guard held this,
# and only for one caller.
#
# Write/Edit/MultiEdit give the path exactly. A Bash command's write targets
# come from ../lib/write-targets.sh, which is HEURISTIC: it sees `cp`, `mv`,
# `tee`, redirections and the like, not a script that writes the file itself.
# With that lib absent, Bash is let through (the Write tools are still held).
#
# INSTALLED INTO EVERY REPO'S .claude/hooks/, because a hook only fires when
# Claude Code's project dir is the one holding it. The source is tools/hooks
# (source/hooks/); `hooks copies` there fails when a copy differs from it.
# Change the source, never a copy.
#
# FAILS OPEN. Malformed input, no jq, anything unexpected: exit 0. Exit 2 only
# for a write to a settings.json.

set -o pipefail

input=$(cat 2>/dev/null) || exit 0
case "$input" in *settings.json*) ;; *) exit 0 ;; esac
command -v jq >/dev/null 2>&1 || exit 0

tool=$(printf '%s' "$input" | jq -r '.tool_name | strings' 2>/dev/null) || exit 0
cwd=$(printf '%s' "$input" | jq -r '.cwd | strings' 2>/dev/null) || exit 0
[ -n "$cwd" ] || cwd=$PWD

lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)/../lib/write-targets.sh"
have_lib=0
[ -f "$lib" ] && . "$lib" 2>/dev/null && type bash_write_targets >/dev/null 2>&1 && have_lib=1

case "$tool" in
  Write|Edit|MultiEdit)
    targets=$(printf '%s' "$input" | jq -r '.tool_input.file_path | strings' 2>/dev/null) || exit 0
    how="this $tool" ;;
  Bash)
    [ $have_lib = 1 ] || exit 0
    cmd=$(printf '%s' "$input" | jq -r '.tool_input.command | strings' 2>/dev/null) || exit 0
    targets=$(bash_write_targets "$cmd" "$cwd" 2>/dev/null)
    how="this command (as write-targets.sh reads it)" ;;
  *) exit 0 ;;
esac

while IFS= read -r p; do
  [ -n "$p" ] || continue
  if [ $have_lib = 1 ]; then p=$(normpath "$p" "$cwd" 2>/dev/null)
  else case "$p" in /*) ;; *) p="$cwd/$p" ;; esac; fi
  case "/$p" in
    */.claude/settings.json)
      echo "settings-guard: $how writes $p. A .claude/settings.json is the user's to change, never a model's: write the change to .claude/settings.proposed.json beside it and say so; the user applies it." >&2
      exit 2 ;;
  esac
done <<< "$targets"
exit 0
