#!/usr/bin/env bash
# Tests for write-ledger.sh. Run: bash .claude/hooks/test-write-ledger.sh
#
# Each case feeds one PostToolUse input and reads the ledger file back: which
# repo's ledger got the row, how many rows, and every column. Plus: no row for
# a read, a path outside any repo, or the user's home; a missing ledger is
# created; an unwritable one gets no row but is reported (stderr, and the row
# kept in the fallback marker), still exit 0; end rows on SubagentStop and SessionEnd;
# write-targets.sh absent means no Bash rows, ledger.sh absent no rows; and
# fail-open (exit 0, no output) on malformed input, no jq, a broken git.

set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$DIR/write-ledger.sh"
fails=0
T=$(mktemp -d "${TMPDIR:-/tmp}/write-ledger-test.XXXXXX") || exit 1
T=$(cd "$T" && pwd -P)
trap 'rm -rf "$T"' EXIT
export HOME="$T/home"
export TMPDIR="$T/tmpd"; mkdir -p "$TMPDIR"   # a lost row's fallback marker lands here, never in the real one
mkdir -p "$HOME/.claude"
TAB=$'\t'
HEAD="time${TAB}agent_type${TAB}agent_id${TAB}session${TAB}path${TAB}via${TAB}tool_use"

pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; shift; for l in "$@"; do printf '        %s\n' "$l"; done; fails=$((fails + 1)); }

fresh() {   # a scratch repo at $R, with .claude/ and no ledger yet
  R="$T/repo-$1"; rm -rf "$R"; mkdir -p "$R/.claude" "$R/sub"; echo a > "$R/a"
}

# run <tool> <key> <value> [agent_type] [hook] -> stdout+stderr in OUT, exit in CODE
run() {
  local inp
  inp=$(jq -nc --arg tool "$1" --arg k "$2" --arg v "$3" --arg t "${4:-}" --arg cwd "$R" \
    '{hook_event_name:"PostToolUse",session_id:"sess-1",cwd:$cwd,tool_name:$tool,tool_use_id:"tu-1",
      tool_input:{($k):$v},tool_response:{}} + (if $t == "" then {} else {agent_type:$t, agent_id:"agent-1"} end)')
  OUT=$(printf '%s' "$inp" | bash "${5:-$HOOK}" 2>&1); CODE=$?
}

# rows <ledger>: the data rows (header dropped), or "<no ledger>"
rows() { if [ -f "$1" ]; then tail -n +2 "$1"; else echo "<no ledger>"; fi; }

# expect <desc> <ledger> <want rows, one per line, time column as *>
expect() {
  local desc="$1" ledger="$2" want="$3" got head
  got=$(rows "$ledger" | sed -E "s/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z${TAB}/*${TAB}/")
  head=$(head -1 "$ledger" 2>/dev/null)
  if [ "$CODE" != 0 ] || [ -n "$OUT" ]; then fail "$desc" "exit $CODE, output: ${OUT:0:200}"
  elif [ "$want" != "<no ledger>" ] && [ "$head" != "$HEAD" ]; then fail "$desc" "header: $head"
  elif [ "$got" != "$want" ]; then fail "$desc" "want: $want" "got:  $got"
  else pass "$desc"; fi
}

row() { printf '*\t%s\t%s\tsess-1\t%s\t%s\ttu-1' "$1" "$2" "$3" "$4"; }

echo "exact rows (the tool names the path):"
fresh edit;  run Edit file_path "$R/a" some-agent
expect "Edit: one exact row"            "$R/.claude/state/writes.tsv" "$(row some-agent agent-1 "$R/a" exact)"
fresh write; run Write file_path "$R/sub/new.txt" some-agent
expect "Write"                          "$R/.claude/state/writes.tsv" "$(row some-agent agent-1 "$R/sub/new.txt" exact)"
fresh multi; run MultiEdit file_path "$R/a" some-agent
expect "MultiEdit"                      "$R/.claude/state/writes.tsv" "$(row some-agent agent-1 "$R/a" exact)"
fresh nb;    run NotebookEdit notebook_path "$R/n.ipynb" some-agent
expect "NotebookEdit (notebook_path)"   "$R/.claude/state/writes.tsv" "$(row some-agent agent-1 "$R/n.ipynb" exact)"
fresh main;  run Edit file_path "$R/a"
expect "main thread: agent fields -"    "$R/.claude/state/writes.tsv" "$(row - - "$R/a" exact)"
fresh rel;   run Write file_path "sub/../b" some-agent
expect "relative path, against cwd"     "$R/.claude/state/writes.tsv" "$(row some-agent agent-1 "$R/b" exact)"
fresh two;   run Edit file_path "$R/a" some-agent; run Edit file_path "$R/a" other-agent
expect "appends, one header"            "$R/.claude/state/writes.tsv" "$(row some-agent agent-1 "$R/a" exact)
$(row other-agent agent-1 "$R/a" exact)"
fresh odd;   run Write file_path "$R/a${TAB}b" some-agent
expect "a tab in the path is escaped"   "$R/.claude/state/writes.tsv" "$(row some-agent agent-1 "$R/a\\tb" exact)"

echo "heuristic rows (Bash, through write-targets.sh):"
fresh cp;    run Bash command "cp a b" some-agent
expect "Bash cp: one heuristic row"     "$R/.claude/state/writes.tsv" "$(row some-agent agent-1 "$R/b" bash-heuristic)"
fresh cat;   run Bash command "cat a" some-agent
expect "Bash cat: no row, no ledger"    "$R/.claude/state/writes.tsv" "<no ledger>"
fresh touch; run Bash command "cd sub && touch x y" some-agent
expect "Bash touch two: two rows"       "$R/.claude/state/writes.tsv" "$(row some-agent agent-1 "$R/sub/x" bash-heuristic)
$(row some-agent agent-1 "$R/sub/y" bash-heuristic)"

echo "which ledger:"
fresh nest;  mkdir -p "$R/inner/.claude"; run Edit file_path "$R/inner/f" some-agent
expect "a nested repo gets its own"     "$R/inner/.claude/state/writes.tsv" "$(row some-agent agent-1 "$R/inner/f" exact)"
expect "  and the outer none"           "$R/.claude/state/writes.tsv" "<no ledger>"
fresh out;   mkdir -p "$T/norepo"; run Edit file_path "$T/norepo/f" some-agent
expect "no repo above: no row"          "$T/norepo/.claude/state/writes.tsv" "<no ledger>"
if [ -e "$T/.claude" ]; then fail "  and nothing created above" "$T/.claude exists"; else pass "  and nothing created above"; fi
fresh home;  run Edit file_path "$HOME/notes.txt" some-agent
expect "the user's home is not a repo"  "$HOME/.claude/state/writes.tsv" "<no ledger>"
fresh split; run Bash command "cp a $T/repo-nest/inner/g" some-agent
expect "Bash: the target's repo"        "$T/repo-nest/inner/.claude/state/writes.tsv" "$(row some-agent agent-1 "$T/repo-nest/inner/f" exact)
$(row some-agent agent-1 "$T/repo-nest/inner/g" bash-heuristic)"

echo "a missing or unwritable ledger:"
fresh ro;    printf 'x' > "$R/.claude/state"; run Edit file_path "$R/a" some-agent
if [ "$CODE" = 0 ] && [ "$(cat "$R/.claude/state")" = x ]; then pass "state is a file: no row, still exit 0"
else fail "state is a file: no row, still exit 0" "exit $CODE: ${OUT:0:200}"; fi
case "$OUT" in
  *"a row was not written to $R/.claude/state/writes.tsv"*"kept in $TMPDIR/ledger-append-failed.tsv"*) pass "  and says so on stderr (never silent)" ;;
  *) fail "  and says so on stderr (never silent)" "got: ${OUT:0:300}" ;;
esac
if cut -f2,8 "$TMPDIR/ledger-append-failed.tsv" 2>/dev/null | grep -qxF "$R/.claude/state/writes.tsv${TAB}$R/a"; then
  pass "  the lost row is kept in the fallback marker"
else fail "  the lost row is kept in the fallback marker" "$(cat "$TMPDIR/ledger-append-failed.tsv" 2>&1)"; fi
fresh dirl;  mkdir -p "$R/.claude/state/writes.tsv"; run Edit file_path "$R/a" some-agent   # the append itself fails
if [ "$CODE" = 0 ] && cut -f2,8 "$R/.claude/state/writes.tsv.failed" 2>/dev/null | grep -qxF "$R/.claude/state/writes.tsv${TAB}$R/a" \
   && case "$OUT" in *"kept in $R/.claude/state/writes.tsv.failed"*) true ;; *) false ;; esac; then
  pass "a failed append: exit 0, said on stderr, row kept in writes.tsv.failed"
else fail "a failed append: exit 0, said on stderr, row kept in writes.tsv.failed" "exit $CODE: ${OUT:0:300}"; fi

echo "end rows (SubagentStop, SessionEnd) in every ledger under the project dir holding the writer's rows:"
# end <event> <agent_id or ''> <session> [project dir]
end() {
  local inp
  inp=$(jq -nc --arg e "$1" --arg a "$2" --arg s "$3" --arg cwd "$T" \
    '{hook_event_name:$e,session_id:$s,cwd:$cwd} + (if $a == "" then {} else {agent_type:"some-agent",agent_id:$a} end)')
  OUT=$(printf '%s' "$inp" | CLAUDE_PROJECT_DIR="${4:-$T}" bash "$HOOK" 2>&1); CODE=$?
}
fresh stop1; run Edit file_path "$R/a" some-agent; S1=$R
fresh stop2; run Edit file_path "$R/a" other-agent
end SubagentStop agent-1 sess-1
expect "a stop row where agent-1 wrote" "$S1/.claude/state/writes.tsv" "$(row some-agent agent-1 "$S1/a" exact)
$(printf '*\tsome-agent\tagent-1\tsess-1\t-\tstop\t-')"
fresh stop3; run Edit file_path "$R/a"
end SubagentStop agent-9 sess-1
expect "another agent's stop: no row"   "$R/.claude/state/writes.tsv" "$(row - - "$R/a" exact)"
end SessionEnd "" sess-1
expect "SessionEnd: a session-end row"  "$R/.claude/state/writes.tsv" "$(row - - "$R/a" exact)
$(printf '*\t-\t-\tsess-1\t-\tsession-end\t-')"
fresh stop4; run Edit file_path "$R/a" some-agent
end SubagentStop agent-1 sess-1 "$T/elsewhere"
expect "a ledger outside the project dir: no row" "$R/.claude/state/writes.tsv" "$(row some-agent agent-1 "$R/a" exact)"
end SubagentStop "" sess-1
expect "SubagentStop with no agent_id: no row"    "$R/.claude/state/writes.tsv" "$(row some-agent agent-1 "$R/a" exact)"

echo "a lib absent (a lone copy of the hook):"
mkdir -p "$T/lone/hooks" "$T/lone/lib" "$T/bare/hooks" && cp "$HOOK" "$T/lone/hooks/" && cp "$HOOK" "$T/bare/hooks/"
cp "$DIR/../lib/ledger.sh" "$T/lone/lib/"
fresh lone1; run Bash command "cp a b" some-agent "$T/lone/hooks/write-ledger.sh"
expect "write-targets.sh absent: Bash, no row"    "$R/.claude/state/writes.tsv" "<no ledger>"
fresh lone2; run Edit file_path "$R/a" some-agent "$T/lone/hooks/write-ledger.sh"
expect "write-targets.sh absent: Edit still exact" "$R/.claude/state/writes.tsv" "$(row some-agent agent-1 "$R/a" exact)"
fresh lone3; run Edit file_path "$R/a" some-agent "$T/bare/hooks/write-ledger.sh"
expect "ledger.sh absent: no row at all"           "$R/.claude/state/writes.tsv" "<no ledger>"

echo "fails open (exit 0, no output):"
open() {
  local desc="$1" given="$2" path="${3:-$PATH}" out code
  out=$(cd "$T" && printf '%s' "$given" | PATH="$path" "$BASH" "$HOOK" 2>&1); code=$?
  if [ "$code" = 0 ] && [ -z "$out" ]; then pass "$desc"
  else fail "$desc" "exit $code, output: ${out:0:200}"; fi
}
open "empty input"      ''
open "{}"               '{}'
open "not json"         'not json'
open "truncated input"  '{"tool_name":"Edit","tool_input":{"file_path":"/r/a'
fresh nojq
mkdir -p "$T/nojq"; for b in cat tr date mkdir dirname git; do p=$(command -v "$b") && ln -s "$p" "$T/nojq/$b"; done
open "no jq on PATH"    "$(jq -nc --arg p "$R/a" '{tool_name:"Edit",tool_input:{file_path:$p}}')" "$T/nojq"
mkdir -p "$T/nogit"; printf '#!/bin/sh\nexit 127\n' > "$T/nogit/git"; chmod +x "$T/nogit/git"
fresh nogit
open "a broken git"     "$(jq -nc --arg p "$R/a" --arg c "$R" '{tool_name:"Edit",cwd:$c,tool_input:{file_path:$p}}')" "$T/nogit:$PATH"
if [ "$(rows "$R/.claude/state/writes.tsv" | wc -l | tr -d ' ')" = 1 ]; then pass "  and the row is still written (git is not used)"
else fail "  and the row is still written (git is not used)" "$(rows "$R/.claude/state/writes.tsv")"; fi

echo
if [ "$fails" != 0 ]; then echo "$fails FAILED"; exit 1; fi
echo "all cases passed"
