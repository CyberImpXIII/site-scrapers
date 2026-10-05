#!/usr/bin/env bash
# hooks: applies_to=all
# Don't edit in parallel with a live primary context -- held by a hook, not by
# prose. PreToolUse hook on Write, Edit, MultiEdit, NotebookEdit and Bash; see
# ../settings.json. Tests: bash .claude/hooks/test-primary-guard.sh
#
# Blocked (exit 2): a write to a path whose LAST write row in the ledger
# (../lib/ledger.sh) belongs to a different writer that is still LIVE: no
# `stop` row for its agent_id and no `session-end` row for its session after
# that write, and the write is newer than MAX_AGE_HOURS. The block names the
# writer and says to queue the change with it. Why it exists:
# PLAN-hard-gates.md §3 row 2 ("Check for a primary context before changing
# anything that exists").
#
# WHO IS WHO. A subagent is its agent_id. A main thread (no agent_id in its
# hook input; `-` in the ledger) is its session: the dispatcher and a planner
# window are different sessions, so each is a different writer to the other.
# A main thread and its own subagents are different writers too: an agent is
# held off a file its dispatcher wrote while that session lives, and the
# dispatcher off a file its live agent wrote. The writer itself is never blocked by its own rows. A main thread counts as
# live until its SessionEnd is recorded (or MAX_AGE_HOURS pass); a session
# killed without one stays live for that long.
#
# NOT SEEN: a write the ledger never recorded (a script that writes by itself,
# a write by the user in his own terminal, a file outside every repo, a write
# from a session whose write-ledger.sh is not registered); a Bash write that
# ../lib/write-targets.sh does not read (it is HEURISTIC: cp, mv, tee,
# redirections and the like). Paths are compared as normalized text, so two
# spellings of one file through a symlink are two paths.
#
# INSTALLED INTO EVERY REPO'S .claude/hooks/, because a hook only fires when
# Claude Code's project dir is the one holding it. The source is tools/hooks
# (source/hooks/); `hooks copies` there fails when a copy differs from it.
# Change the source, never a copy.
#
# FAILS OPEN. Malformed input, no jq, no ledger, ../lib/ledger.sh absent, no
# date that can compute the cutoff: exit 0, no output. git is never called.
# With ../lib/write-targets.sh absent, Bash is let through.

set -o pipefail

# A write row older than this no longer counts: a session killed without a
# SessionEnd records no end, and its rows must not hold a path forever.
MAX_AGE_HOURS=12

input=$(cat 2>/dev/null) || exit 0
command -v jq >/dev/null 2>&1 || exit 0
fields=$(printf '%s' "$input" | jq -r '[(.tool_name, .cwd, .agent_id, .session_id) | strings // ""] | join("\u001f")' 2>/dev/null) || exit 0
IFS=$'\x1f' read -r tool cwd agent_id session <<< "$fields"
[ -n "$cwd" ] || cwd=$PWD

libdir="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)/../lib"
[ -f "$libdir/ledger.sh" ] && . "$libdir/ledger.sh" 2>/dev/null && type ledger_last >/dev/null 2>&1 || exit 0
have_wt=0
[ -f "$libdir/write-targets.sh" ] && . "$libdir/write-targets.sh" 2>/dev/null &&
  type bash_write_targets >/dev/null 2>&1 && have_wt=1

case "$tool" in
  Write|Edit|MultiEdit)
    targets=$(printf '%s' "$input" | jq -r '.tool_input.file_path | strings' 2>/dev/null) || exit 0 ;;
  NotebookEdit)
    targets=$(printf '%s' "$input" | jq -r '.tool_input.notebook_path | strings' 2>/dev/null) || exit 0 ;;
  Bash)
    [ $have_wt = 1 ] || exit 0
    cmd=$(printf '%s' "$input" | jq -r '.tool_input.command | strings' 2>/dev/null) || exit 0
    targets=$(bash_write_targets "$cmd" "$cwd" 2>/dev/null) ;;
  *) exit 0 ;;
esac
[ -n "$targets" ] || exit 0

cutoff=$(ledger_cutoff "$MAX_AGE_HOURS")
[ -n "$cutoff" ] || exit 0

while IFS= read -r p; do
  [ -n "$p" ] || continue
  if [ $have_wt = 1 ]; then p=$(normpath "$p" "$cwd" 2>/dev/null)
  else case "$p" in /*) ;; *) p="$cwd/$p" ;; esac; fi
  ledger_repo_of "$p" || continue
  ledger="$LEDGER_REPO/$LEDGER_REL"
  [ -f "$ledger" ] || continue
  ledger_esc "$p"
  line=$(ledger_last "$ledger" "$cutoff" "$LEDGER_E")
  [ -n "$line" ] || continue
  IFS=$'\t' read -r _ w_type w_id w_session w_time w_live <<< "$line"
  [ "$w_live" = 1 ] || continue
  if [ -n "$agent_id" ]; then [ "$w_id" = "$agent_id" ] && continue
  else [ "$w_id" = - ] && [ "$w_session" = "$session" ] && continue; fi
  if [ "$w_id" = - ]; then who="the main thread of session $w_session"
  else who="agent $w_type (agent_id $w_id, session $w_session)"; fi
  echo "primary-guard: $p was last written at $w_time by $who, which is still working: no stop is recorded for it in $ledger. Do not edit in parallel. Queue the change with that writer instead: say which file, what should differ and why (in your report, or to the dispatcher), and let that writer apply it. The path frees itself when that writer stops or after ${MAX_AGE_HOURS}h." >&2
  exit 2
done <<< "$targets"
exit 0
