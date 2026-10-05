#!/usr/bin/env bash
# hooks: applies_to=all dest=.claude/lib
# SOURCED, not executed. The ONE definition of the write ledger: where it is,
# its columns, how a row is written and how it is read. write-ledger.sh writes
# it; primary-guard.sh and push-gate.sh read it (all three source this copy
# beside them, ../lib/). Its source is tools/hooks (source/lib/); `hooks copies`
# there fails when a copy differs from it. Change the source, never a copy.
# Tests: bash tools/hooks/source/tests/test-ledger.sh
#
# THE LEDGER is <repo>/.claude/state/writes.tsv, where <repo> is the nearest
# directory above a written file that holds a `.claude/` directory (never the
# user's home: its .claude is user configuration). Tab-separated, one header:
#   time        UTC, 2026-10-05T12:00:00Z (sorts as text)
#   agent_type  `-` for a main thread
#   agent_id    `-` for a main thread
#   session     session_id
#   path        absolute, normalized; a tab, newline, CR or backslash in it is
#               escaped (\t \n \r \\), so compare escaped forms (ledger_esc)
#   via         exact | bash-heuristic   a write
#               stop                     SubagentStop of agent_id (path `-`)
#               session-end              SessionEnd of session (path `-`)
#   tool_use    the tool call's id (`-` on an end row)
#
# LIVENESS. A write row's writer is LIVE while all of these hold: its time is
# at or after the cutoff the caller passes (ledger_cutoff: older rows belong
# to a session that is presumed gone, since a killed session records no end);
# no `stop` row for its agent_id comes AFTER it (a main thread has no stop
# row); no `session-end` row for its session comes after it. "After" is row
# order, so a resumed session (same session_id) writing again is live again.
#
#   ledger_repo_of <abs path>   -> LEDGER_REPO, or return 1 when no repo is above
#   ledger_esc <text>           -> LEDGER_E, the escaped field (`-` when empty)
#   ledger_append <ledger> <agent_type> <agent_id> <session> <path> <via> <tool_use>
#                               one row, stamped now; creates the file and its
#                               header when missing; return 1 when not written
#   ledger_cutoff <hours>       prints the UTC time <hours> ago; empty when
#                               neither BSD nor GNU date can say
#   ledger_last <ledger> [cutoff] [escaped path]
#                               the LAST write row per path, one line each:
#                               path agent_type agent_id session time live(1|0),
#                               tab-separated, path still escaped. With a path,
#                               only that path's line (or nothing)
#   ledger_files <root>         every ledger under <root> (depth 7: a repo up to
#                               4 deep, plus .claude/state/writes.tsv; .git and
#                               node_modules pruned), one per line
#
# Every function only prints or sets a variable, and never exits: each caller
# fails OPEN.

LEDGER_REL=.claude/state/writes.tsv
LEDGER_HEADER=$'time\tagent_type\tagent_id\tsession\tpath\tvia\ttool_use'

ledger_repo_of() {
  local d=${1%/*}
  LEDGER_REPO=""
  while [ -n "$d" ] && [ "$d" != "/" ]; do
    [ "$d" = "$HOME" ] && return 1
    [ -d "$d/.claude" ] && { LEDGER_REPO=$d; return 0; }
    d=${d%/*}
  done
  return 1
}

ledger_esc() {
  LEDGER_E=${1//\\/\\\\}; LEDGER_E=${LEDGER_E//$'\t'/\\t}
  LEDGER_E=${LEDGER_E//$'\n'/\\n}; LEDGER_E=${LEDGER_E//$'\r'/\\r}
  [ -n "$LEDGER_E" ] || LEDGER_E=-
}

ledger_append() {
  local ledger=$1 now row f
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null) || return 1
  row=$now
  shift
  for f in "$@"; do ledger_esc "$f"; row+=$'\t'"$LEDGER_E"; done
  mkdir -p "${ledger%/*}" 2>/dev/null || return 1
  if [ ! -e "$ledger" ]; then
    ( set -C; printf '%s\n' "$LEDGER_HEADER" > "$ledger" ) 2>/dev/null
  fi
  # One write per row, so concurrent agents do not interleave within a row.
  printf '%s\n' "$row" >> "$ledger" 2>/dev/null
}

ledger_cutoff() {
  date -u -v-"$1"H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null ||
    date -u -d "-$1 hours" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null
}

ledger_last() {
  [ -f "$1" ] || return 0
  # The path goes through the environment: awk -v would read its backslashes
  # as escapes, and an escaped path is full of them.
  LEDGER_WANT="${3:-}" awk -F "\t" -v OFS="\t" -v cutoff="${2:-}" '
    BEGIN { want = ENVIRON["LEDGER_WANT"] }
    NR == 1 && $1 == "time" { next }
    NF < 6 { next }
    $6 == "stop"        { stopped[$3] = NR; next }
    $6 == "session-end" { ended[$4] = NR; next }
    want != "" && $5 != want { next }
    { at[$5] = NR; t[$5] = $1; ty[$5] = $2; id[$5] = $3; se[$5] = $4 }
    END {
      for (p in at) {
        n = at[p]
        live = (t[p] >= cutoff)
        if (id[p] != "-" && stopped[id[p]] > n) live = 0
        if (ended[se[p]] > n) live = 0
        print p, ty[p], id[p], se[p], t[p], live
      }
    }' "$1" 2>/dev/null
}

ledger_files() {
  [ -d "$1" ] || return 0
  find "$1" -maxdepth 7 \( -type d \( -name .git -o -name node_modules \) -prune \) \
    -o -type f -path "*/$LEDGER_REL" -print 2>/dev/null
}
