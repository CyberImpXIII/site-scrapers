#!/usr/bin/env bash
# hooks: applies_to=all
# Records who wrote what: one row per written file, in the ledger of the repo
# that holds the file; and when a writer ends, so its rows stop counting as
# live. PostToolUse hook on Write, Edit, MultiEdit, NotebookEdit and Bash;
# SubagentStop and SessionEnd hook; see ../settings.json.
# Tests: bash .claude/hooks/test-write-ledger.sh
#
# Why: a commit can carry its author (git-stamp.sh), an uncommitted change
# cannot. "Whose uncommitted changes are these?" is answered by this ledger and
# `git status` together (PLAN-hard-gates.md §2); primary-guard.sh and
# push-gate.sh read it.
#
# THE LEDGER (location, columns, escaping, liveness) is defined once, in
# ../lib/ledger.sh. This hook writes:
#   a write row per target, via `exact` (Write, Edit, MultiEdit, NotebookEdit
#     name the file) or `bash-heuristic` (a Bash command's targets as
#     ../lib/write-targets.sh reads them: it sees cp, mv, tee, redirections and
#     the like, never a script that writes by itself). A file with no repo
#     above it (a scratchpad, /tmp, the user's home) gets no row.
#   on SubagentStop, a `stop` row for that agent_id, and on SessionEnd a
#     `session-end` row for that session, in EVERY ledger under the project
#     dir ($CLAUDE_PROJECT_DIR, else cwd) that holds a row of theirs. A ledger
#     outside the project dir gets no end row; its rows stop counting by age
#     (ledger.sh's cutoff). On SubagentStop push-gate.sh may refuse the stop;
#     the stop row is written anyway (hooks run in parallel), so for that one
#     extra turn the agent's earlier rows read as ended. Rows it writes during
#     that turn come after the stop row and are live again.
#   tool_use: if the hook is registered twice (user scope and a repo's copy),
#     a call writes its rows twice; a reader counts (tool_use, path) once.
# With ../lib/write-targets.sh absent, Bash calls get no rows; the Write tools
# still do. With ../lib/ledger.sh absent, nothing is written.
#
# INSTALLED INTO EVERY REPO'S .claude/hooks/, because a hook only fires when
# Claude Code's project dir is the one holding it. The source is tools/hooks
# (source/hooks/); `hooks copies` there fails when a copy differs from it.
# Change the source, never a copy.
#
# FAILS OPEN, and never speaks: malformed input, no jq, an unwritable ledger --
# exit 0 with no output. A record keeper must never stop the work it records.

set -o pipefail

input=$(cat 2>/dev/null) || exit 0
command -v jq >/dev/null 2>&1 || exit 0

fields=$(printf '%s' "$input" | jq -r '[(.hook_event_name, .tool_name, .cwd, .agent_type, .agent_id, .session_id, .tool_use_id)
  | strings // ""] | join("\u001f")' 2>/dev/null) || exit 0
IFS=$'\x1f' read -r event tool cwd agent_type agent_id session tool_use <<< "$fields"
[ -n "$cwd" ] || cwd=$PWD

libdir="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)/../lib"
[ -f "$libdir/ledger.sh" ] && . "$libdir/ledger.sh" 2>/dev/null && type ledger_append >/dev/null 2>&1 || exit 0
have_wt=0
[ -f "$libdir/write-targets.sh" ] && . "$libdir/write-targets.sh" 2>/dev/null &&
  type bash_write_targets >/dev/null 2>&1 && have_wt=1

# ---------------------------------------------------------- an end event --
end_rows() {   # $1 via (stop|session-end), $2 column to match (3 agent_id, 4 session), $3 value
  local root=${CLAUDE_PROJECT_DIR:-$cwd} L
  [ -n "$3" ] || return 0
  ledger_esc "$3"; local want=$LEDGER_E
  while IFS= read -r L; do
    [ -n "$L" ] || continue
    LEDGER_WANT=$want awk -F '\t' -v c="$2" 'NR > 1 && $c == ENVIRON["LEDGER_WANT"] && $6 != "stop" && $6 != "session-end" { f = 1; exit } END { exit !f }' "$L" 2>/dev/null || continue
    if [ "$1" = stop ]; then ledger_append "$L" "$agent_type" "$agent_id" "$session" - stop -
    else ledger_append "$L" "$agent_type" - "$session" - session-end -; fi
  done <<< "$(ledger_files "$root")"
}

case "$event" in
  SubagentStop) end_rows stop 3 "$agent_id"; exit 0 ;;
  SessionEnd)   end_rows session-end 4 "$session"; exit 0 ;;
esac

# ------------------------------------------------------------ a write row --
case "$tool" in
  Write|Edit|MultiEdit)
    targets=$(printf '%s' "$input" | jq -r '.tool_input.file_path | strings' 2>/dev/null) || exit 0; via=exact ;;
  NotebookEdit)
    targets=$(printf '%s' "$input" | jq -r '.tool_input.notebook_path | strings' 2>/dev/null) || exit 0; via=exact ;;
  Bash)
    [ $have_wt = 1 ] || exit 0
    cmd=$(printf '%s' "$input" | jq -r '.tool_input.command | strings' 2>/dev/null) || exit 0
    targets=$(bash_write_targets "$cmd" "$cwd" 2>/dev/null); via=bash-heuristic ;;
  *) exit 0 ;;
esac
[ -n "$targets" ] || exit 0

while IFS= read -r p; do
  [ -n "$p" ] || continue
  if [ $have_wt = 1 ]; then p=$(normpath "$p" "$cwd" 2>/dev/null)
  else case "$p" in /*) ;; *) p="$cwd/$p" ;; esac; fi
  ledger_repo_of "$p" || continue
  ledger_append "$LEDGER_REPO/$LEDGER_REL" "$agent_type" "$agent_id" "$session" "$p" "$via" "$tool_use"
done <<< "$targets"
exit 0
