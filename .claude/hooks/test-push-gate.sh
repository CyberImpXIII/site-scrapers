#!/usr/bin/env bash
# Tests for push-gate.sh. Run: bash .claude/hooks/test-push-gate.sh
#
# A scratch clone of a bare origin, with a ledger written by hand, then one
# Stop/SubagentStop input. Blocked once (decision "block", naming the repo and
# `git -C <repo> push`): the stopping writer's own stamped commits ahead of
# origin; its own written paths left uncommitted. The same state with
# stop_hook_active gives a systemMessage and no block. Let through: after the
# push; someone else's commits or files; unstamped commits; no upstream (for
# commits); an ignored path; a project dir holding no ledger; another event.
# The same state flips with the caller alone (the input changes the output).
# Plus fail-open: malformed input, no jq, no git, a broken git, ledger.sh absent.

set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$DIR/push-gate.sh"
fails=0
T=$(mktemp -d "${TMPDIR:-/tmp}/push-gate-test.XXXXXX") || exit 1
T=$(cd "$T" && pwd -P)
trap 'rm -rf "$T"' EXIT
export HOME="$T/home"; mkdir -p "$HOME"     # no global git config, no global hooks
export GIT_CONFIG_NOSYSTEM=1
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# The committer address is joined at run time: no committed line is email-shaped
# (every installed copy is read by its repo's leak audit; tests/test_leak_shapes.py).
AT=@; MAIL="t${AT}example.invalid"
G() { git -C "$R" -c user.name=t -c user.email="$MAIL" -c core.hooksPath=/dev/null "$@" >/dev/null 2>&1; }

pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; shift; for l in "$@"; do printf '        %s\n' "$l"; done; fails=$((fails + 1)); }

# fresh <name>: $R a clone of a bare origin with one pushed commit, .claude/ and an empty ledger,
# alone in its own project dir ($P), so no other case's ledger is in view.
fresh() {
  P=$T/$1; R=$P/r; O=$P/o.git; mkdir -p "$P"
  git init -q --bare "$O" && git clone -q "$O" "$R" 2>/dev/null
  mkdir -p "$R/.claude/state"; echo base > "$R/base"; printf 'ignored/\n' > "$R/.gitignore"
  G add base .gitignore && G commit -qm base && G push -q origin HEAD
  L=$R/.claude/state/writes.tsv
  printf 'time\tagent_type\tagent_id\tsession\tpath\tvia\ttool_use\n' > "$L"
}
w() { printf '%s\t%s\t%s\t%s\t%s\texact\ttu\n' "$NOW" "$1" "$2" "$3" "$4" >> "$L"; }   # type id session path
commit_as() {   # <Agent-Id or ''> <file>: a commit of that file, stamped or not
  echo "$RANDOM" >> "$R/$2"; G add -- "$2"
  if [ -n "$1" ]; then G commit -qm "change" -m "Agent: x
Agent-Id: $1"; else G commit -qm "unstamped"; fi
}

# run <event> <agent_id or ''> <session> [stop_hook_active] [hook] [project dir] [PATH]
run() {
  local inp
  inp=$(jq -nc --arg e "$1" --arg a "$2" --arg s "$3" --arg act "${4:-false}" --arg cwd "$R" \
    '{hook_event_name:$e,session_id:$s,cwd:$cwd,stop_hook_active:($act == "true")}
     + (if $a == "" then {} else {agent_type:"some-agent", agent_id:$a} end)')
  OUT=$(printf '%s' "$inp" | CLAUDE_PROJECT_DIR="${6:-$P}" PATH="${7:-$PATH}" "$BASH" "${5:-$HOOK}" 2>&1); CODE=$?
}

blocks() {   # <desc> <text the reason must hold>...
  local desc=$1 d r; shift
  d=$(printf '%s' "$OUT" | jq -r '.decision // empty' 2>/dev/null); r=$(printf '%s' "$OUT" | jq -r '.reason // empty' 2>/dev/null)
  if [ "$CODE" != 0 ] || [ "$d" != block ]; then fail "$desc" "want a block, got exit $CODE: ${OUT:0:300}"; return; fi
  for t in "$@"; do case "$r" in *"$t"*) ;; *) fail "$desc" "reason lacks [$t]: ${r:0:400}"; return ;; esac; done
  pass "$desc"
}
lets() {     # <desc>: exit 0, no output
  if [ "$CODE" = 0 ] && [ -z "$OUT" ]; then pass "$1"; else fail "$1" "exit $CODE, output: ${OUT:0:300}"; fi
}

echo "blocked once: the stopping writer's own unpushed work:"
fresh ahead; w a A s1 "$R/f"; commit_as A f
run SubagentStop A s1
blocks "its stamped commit is ahead of origin" "1 commit(s) of yours" "git -C '$R' push" "[$R]"
run SubagentStop B s1
lets   "  the same state, another agent stops (the input changes the output)"
G push -q origin HEAD
run SubagentStop A s1
lets   "  after the push: let through"

fresh dirty; w a A s1 "$R/new.txt"; echo x > "$R/new.txt"; w a A s1 "$R/base"; echo y >> "$R/base"
run SubagentStop A s1
blocks "its written files left uncommitted" "2 file(s) you wrote are uncommitted" "new.txt" "base" "add -- <path>"
run SubagentStop A s1 true
r=$(printf '%s' "$OUT" | jq -r '(.decision // "none") + "|" + (.systemMessage // "")' 2>/dev/null)
case "$r" in "none|push-gate:"*"already asked once"*new.txt*) pass "stop_hook_active: a systemMessage, no block" ;;
  *) fail "stop_hook_active: a systemMessage, no block" "got: ${OUT:0:300}" ;; esac

fresh main; w - - s1 "$R/f"; commit_as s1 f
run Stop "" s1
blocks "a main thread: its session-stamped commit" "the main thread" "git -C '$R' push"
run Stop "" s2
lets   "  another session's main thread: let through"

fresh two; R1=$R; w a A s1 "$R/f"; commit_as A f
R=$P/r2; git clone -q "$O" "$R" 2>/dev/null; mkdir -p "$R/.claude/state"; L=$R/.claude/state/writes.tsv
printf 'time\tagent_type\tagent_id\tsession\tpath\tvia\ttool_use\n' > "$L"; w a A s1 "$R/g"; echo x > "$R/g"
run SubagentStop A s1
blocks "two repos in the project dir: each named" "[$R1] 1 commit(s)" "[$R] 1 file(s)"

echo "let through:"
fresh other; w b B s1 "$R/f"; echo x > "$R/f"; commit_as B g
run SubagentStop A s1
lets   "another agent's files and commits"
fresh mixed; w a A s1 "$R/f"; echo x > "$R/f"; w b B s1 "$R/f"
run SubagentStop A s1
lets   "a file whose LAST writer is another agent"
fresh unst; w a A s1 "$R/f"; commit_as "" f
run SubagentStop A s1
lets   "an unstamped commit (not attributable)"
fresh clean; w a A s1 "$R/f"; commit_as A f; G push -q origin HEAD
run SubagentStop A s1
lets   "written, committed and pushed"
fresh ign; mkdir -p "$R/ignored"; echo x > "$R/ignored/f"; w a A s1 "$R/ignored/f"
run SubagentStop A s1
lets   "an ignored path"
fresh noup; w a A s1 "$R/f"; G checkout -qb side; commit_as A f
run SubagentStop A s1
lets   "no upstream, no origin/<branch>: commits not judged"
echo z > "$R/f"
run SubagentStop A s1
blocks "  but its uncommitted file still is" "1 file(s) you wrote are uncommitted"
fresh far; w a A s1 "$R/f"; commit_as A f
run SubagentStop A s1 false "" "$T/elsewhere"
lets   "a project dir holding no ledger"
run SubagentStart A s1
lets   "another event"
run PostToolUse A s1
lets   "  (PostToolUse)"

echo "a lib absent (a lone copy of the hook):"
mkdir -p "$T/bare/hooks"; cp "$HOOK" "$T/bare/hooks/"
fresh lone; w a A s1 "$R/f"; commit_as A f
run SubagentStop A s1 false "$T/bare/hooks/push-gate.sh"
lets   "ledger.sh absent: let through"

echo "fails open (exit 0, no output):"
open() {
  local desc="$1" given="$2" path="${3:-$PATH}" out code
  out=$(cd "$T" && printf '%s' "$given" | CLAUDE_PROJECT_DIR="$P" PATH="$path" "$BASH" "$HOOK" 2>&1); code=$?
  if [ "$code" = 0 ] && [ -z "$out" ]; then pass "$desc"
  else fail "$desc" "exit $code, output: ${out:0:200}"; fi
}
open "empty input"      ''
open "{}"               '{}'
open "not json"         'not json'
open "truncated input"  '{"hook_event_name":"SubagentStop","agent_id":"A","session_id":"s1'
STATE=$(jq -nc --arg c "$R" '{hook_event_name:"SubagentStop",session_id:"s1",agent_id:"A",cwd:$c}')
mkdir -p "$T/nojq"; for b in cat tr date mkdir dirname awk git find sort grep head cut wc; do p=$(command -v "$b") && ln -s "$p" "$T/nojq/$b"; done
open "no jq on PATH"    "$STATE" "$T/nojq"
mkdir -p "$T/nogitp"; for b in cat tr date mkdir dirname awk jq find sort grep head cut wc; do p=$(command -v "$b") && ln -s "$p" "$T/nogitp/$b"; done
open "no git on PATH"   "$STATE" "$T/nogitp"
mkdir -p "$T/badgit"; printf '#!/bin/sh\nexit 127\n' > "$T/badgit/git"; chmod +x "$T/badgit/git"
open "a broken git"     "$STATE" "$T/badgit:$PATH"
# the counterfactual for the three above: the same state, a working PATH, blocks.
run SubagentStop A s1
blocks "  (and the same state with jq and git: blocks)" "git -C '$R' push"

echo
if [ "$fails" != 0 ]; then echo "$fails FAILED"; exit 1; fi
echo "all cases passed"
