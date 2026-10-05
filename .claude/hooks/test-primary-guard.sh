#!/usr/bin/env bash
# Tests for primary-guard.sh. Run: bash .claude/hooks/test-primary-guard.sh
#
# A ledger is written by hand in a scratch repo, then one PreToolUse input is
# fed. Blocked: a path whose last write is another live writer's (another
# agent, another session's main thread), through every write tool and Bash.
# Not blocked: the writer's own rows; a writer whose stop or session-end is
# recorded; a row older than the cutoff; a path nobody wrote; a read. The same
# path flips with the caller alone (the input changes the output). Plus: the
# libs absent (ledger.sh: everything passes; write-targets.sh: Bash passes,
# Edit still blocks) and fail-open on malformed input, no jq, a broken git.

set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$DIR/primary-guard.sh"
fails=0
T=$(mktemp -d "${TMPDIR:-/tmp}/primary-guard-test.XXXXXX") || exit 1
T=$(cd "$T" && pwd -P)
trap 'rm -rf "$T"' EXIT
export HOME="$T/home"; mkdir -p "$HOME/.claude"
R=$T/repo; mkdir -p "$R/.claude/state" "$R/sub"
L=$R/.claude/state/writes.tsv
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
OLD=$(date -u -v-13H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '-13 hours' +%Y-%m-%dT%H:%M:%SZ)

pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; shift; for l in "$@"; do printf '        %s\n' "$l"; done; fails=$((fails + 1)); }

# ledger rows: w <type> <id> <session> <path> [time]; stop <id>; send <session>
put()  { printf 'time\tagent_type\tagent_id\tsession\tpath\tvia\ttool_use\n' > "$L"; local r; for r in "$@"; do printf '%s\n' "$r" >> "$L"; done; }
w()    { printf '%s\t%s\t%s\t%s\t%s\texact\ttu' "${5:-$NOW}" "$1" "$2" "$3" "$4"; }
stop() { printf '%s\tx\t%s\tsx\t-\tstop\t-' "$NOW" "$1"; }
send() { printf '%s\t-\t-\t%s\t-\tsession-end\t-' "$NOW" "$1"; }

# input <tool> <path-or-command> <agent_id or ''> <session>
input() {
  local key=file_path
  case "$1" in Bash) key=command ;; NotebookEdit) key=notebook_path ;; esac
  jq -nc --arg tool "$1" --arg k "$key" --arg v "$2" --arg a "$3" --arg s "$4" --arg cwd "$R" \
    '{hook_event_name:"PreToolUse",session_id:$s,cwd:$cwd,tool_name:$tool,tool_input:{($k):$v}}
     + (if $a == "" then {} else {agent_type:"caller-agent", agent_id:$a} end)'
}

# want <exit> <desc> <tool> <path-or-command> <agent_id> <session> [hook] [message must hold]
want() {
  local code err
  err=$(input "$3" "$4" "$5" "$6" | bash "${7:-$HOOK}" 2>&1 >/dev/null); code=$?
  if [ "$code" != "$1" ]; then fail "$2" "want exit $1, got $code: ${err:0:300}"; return; fi
  if [ "$1" = 0 ] && [ -n "$err" ]; then fail "$2" "passed but spoke: ${err:0:200}"; return; fi
  if [ "$1" = 2 ]; then
    case "$err" in *Queue*) ;; *) fail "$2" "blocked without saying to queue: ${err:0:200}"; return ;; esac
    if [ -n "${8:-}" ]; then case "$err" in *"$8"*) ;; *) fail "$2" "message lacks [$8]: ${err:0:300}"; return ;; esac; fi
  fi
  pass "$2"
}

echo "blocked (exit 2): the last writer is someone else, still live:"
put "$(w writer-agent A s1 "$R/f")"
want 2 "Write over a live agent's file"      Write        "$R/f" B s1 "" "agent writer-agent (agent_id A"
want 2 "Edit"                                Edit         "$R/f" B s1
want 2 "MultiEdit"                           MultiEdit    "$R/f" B s1
want 2 "relative path, against cwd"          Write        "sub/../f" B s1
want 2 "Bash cp onto it"                     Bash         "cp x f" B s1
want 2 "Bash redirect into it"               Bash         "echo x > $R/f" B s1
want 2 "the main thread over a live agent"   Edit         "$R/f" "" s1
put "$(w - - s1 "$R/n.ipynb")"
want 2 "NotebookEdit over another session's main thread" NotebookEdit "$R/n.ipynb" "" s2 "" "main thread of session s1"
want 2 "  and an agent of another session"   NotebookEdit "$R/n.ipynb" B s2
put "$(w a A s1 "$R/f")" "$(stop A)" "$(w a A s1 "$R/f")"
want 2 "a write after its stop is live again" Edit        "$R/f" B s1

echo "passes (exit 0):"
put "$(w writer-agent A s1 "$R/f")"
want 0 "the same path, the writer itself"    Edit "$R/f" A s1
want 0 "  (the input changes the output)"    Edit "$R/f" A s9
put "$(w - - s1 "$R/f")"
want 0 "a main thread over its own rows"     Edit "$R/f" "" s1
put "$(w a A s1 "$R/f")" "$(stop A)"
want 0 "the writer's stop is recorded"       Edit "$R/f" B s1
put "$(w a A s1 "$R/f")" "$(stop C)"
want 2 "  (another agent's stop is not)"     Edit "$R/f" B s1
put "$(w - - s1 "$R/f")" "$(send s1)"
want 0 "the writer's session ended"          Edit "$R/f" "" s2
put "$(w a A s1 "$R/f" "$OLD")"
want 0 "older than the cutoff"               Edit "$R/f" B s1
put "$(w a A s1 "$R/f")" "$(w b B s1 "$R/f")"
want 0 "the last writer is the caller"       Edit "$R/f" B s1
put "$(w a A s1 "$R/f")"
want 0 "a path nobody wrote"                 Edit "$R/g" B s1
want 0 "a read is not a write"               Read "$R/f" B s1
want 0 "Bash reading it"                     Bash "cat f" B s1
mkdir -p "$T/norepo"
want 0 "a file in no repo"                   Edit "$T/norepo/f" B s1
rm -f "$L"
want 0 "no ledger"                           Edit "$R/f" B s1

echo "a lib absent (a lone copy of the hook):"
put "$(w a A s1 "$R/f")"
mkdir -p "$T/lone/hooks" "$T/lone/lib" "$T/bare/hooks"
cp "$HOOK" "$T/lone/hooks/"; cp "$HOOK" "$T/bare/hooks/"; cp "$DIR/../lib/ledger.sh" "$T/lone/lib/"
want 2 "write-targets.sh absent: Edit still blocked" Edit "$R/f"    B s1 "$T/lone/hooks/primary-guard.sh"
want 0 "write-targets.sh absent: Bash passes"        Bash "cp x f" B s1 "$T/lone/hooks/primary-guard.sh"
want 0 "ledger.sh absent: passes"                    Edit "$R/f"    B s1 "$T/bare/hooks/primary-guard.sh"

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
open "truncated input"  "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$R/f"
mkdir -p "$T/nojq"; for b in cat tr date mkdir dirname awk git; do p=$(command -v "$b") && ln -s "$p" "$T/nojq/$b"; done
open "no jq on PATH"    "$(input Edit "$R/f" B s1)" "$T/nojq"
mkdir -p "$T/nogit"; printf '#!/bin/sh\nexit 127\n' > "$T/nogit/git"; chmod +x "$T/nogit/git"
out=$(input Edit "$R/f" B s1 | PATH="$T/nogit:$PATH" bash "$HOOK" 2>&1 >/dev/null); code=$?
if [ "$code" = 2 ]; then pass "a broken git: still blocks (git is not used)"; else fail "a broken git: still blocks (git is not used)" "exit $code"; fi
mkdir -p "$T/nodate"; for b in cat tr mkdir dirname awk jq; do p=$(command -v "$b") && ln -s "$p" "$T/nodate/$b"; done
printf '#!/bin/sh\nexit 1\n' > "$T/nodate/date"; chmod +x "$T/nodate/date"
open "no date to compute the cutoff" "$(input Edit "$R/f" B s1)" "$T/nodate"

echo
if [ "$fails" != 0 ]; then echo "$fails FAILED"; exit 1; fi
echo "all cases passed"
