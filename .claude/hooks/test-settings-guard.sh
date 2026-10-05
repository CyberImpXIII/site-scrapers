#!/usr/bin/env bash
# Tests for settings-guard.sh. Run: bash .claude/hooks/test-settings-guard.sh
#
# A model write to a `.claude/settings.json` is blocked (exit 2) whoever makes
# it; `.claude/settings.proposed.json` and other files called settings.json
# pass. Bash writes are read through ../lib/write-targets.sh (heuristic); with
# that lib absent the hook still blocks the Write/Edit tools and lets Bash
# through (fails open). Plus fail-open on malformed input and no jq.

set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$DIR/settings-guard.sh"
fails=0
T=$(mktemp -d "${TMPDIR:-/tmp}/settings-guard-test.XXXXXX") || exit 1
trap 'rm -rf "$T"' EXIT
R=$T/repo

pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; shift; for l in "$@"; do printf '        %s\n' "$l"; done; fails=$((fails + 1)); }

# input <tool> <path-or-command> [agent_type]
input() {
  local key=file_path
  [ "$1" = Bash ] && key=command
  jq -nc --arg tool "$1" --arg k "$key" --arg v "$2" --arg t "${3:-}" --arg cwd "$R" \
    '{hook_event_name:"PreToolUse",session_id:"s",cwd:$cwd,tool_name:$tool,tool_input:{($k):$v}}
     + (if $t == "" then {} else {agent_type:$t, agent_id:"a1"} end)'
}

# want <exit> <desc> <tool> <path-or-command> [agent_type] [hook]
want() {
  local code err
  err=$(input "$3" "$4" "${5:-}" | bash "${6:-$HOOK}" 2>&1 >/dev/null); code=$?
  if [ "$code" != "$1" ]; then fail "$2" "want exit $1, got $code: ${err:0:200}"; return; fi
  if [ "$1" = 2 ] && ! printf '%s' "$err" | grep -q 'settings.proposed.json'; then
    fail "$2" "blocked without naming settings.proposed.json: ${err:0:200}"; return
  fi
  pass "$2"
}

echo "blocked (exit 2), from every role:"
for role in "" some-agent another-agent; do
  who=${role:-main thread}
  want 2 "Write, $who"             Write "$R/.claude/settings.json" "$role"
done
want 2 "Edit"                       Edit      "$R/.claude/settings.json" some-agent
want 2 "MultiEdit"                  MultiEdit "$R/.claude/settings.json" some-agent
want 2 "relative path, against cwd" Write     ".claude/settings.json"
want 2 "a .. in the path"           Write     "$R/x/../.claude/settings.json"
want 2 "the user-scope settings"    Write     "$T/home/.claude/settings.json"
want 2 "Bash cp onto it"            Bash      "cp .claude/settings.proposed.json .claude/settings.json"
want 2 "Bash redirect into it"      Bash      "jq . x > $R/.claude/settings.json"

echo "passes (exit 0):"
want 0 "settings.proposed.json"     Write "$R/.claude/settings.proposed.json" some-agent
want 0 "a settings.json elsewhere"  Write "$R/.vscode/settings.json" some-agent
want 0 "a file named like it"       Write "$R/.claude/settings.json.md" some-agent
want 0 "Bash reading it"            Bash  "jq . .claude/settings.json" some-agent
want 0 "Bash writing the proposal"  Bash  "jq . .claude/settings.json > .claude/settings.proposed.json" some-agent
want 0 "Read is not a write"        Read  "$R/.claude/settings.json" some-agent

echo "the lib absent (a lone copy of the hook):"
mkdir -p "$T/lone/hooks" && cp "$HOOK" "$T/lone/hooks/"
want 2 "Write still blocked"        Write "$R/.claude/settings.json" some-agent "$T/lone/hooks/settings-guard.sh"
want 0 "Bash passes (fails open)"   Bash  "cp x .claude/settings.json" some-agent "$T/lone/hooks/settings-guard.sh"

echo "fails open (exit 0, no output):"
open() {
  local desc="$1" given="$2" path="${3:-$PATH}" out code
  out=$(printf '%s' "$given" | PATH="$path" "$BASH" "$HOOK" 2>&1); code=$?
  if [ "$code" = 0 ] && [ -z "$out" ]; then pass "$desc"
  else fail "$desc" "exit $code, output: ${out:0:200}"; fi
}
open "empty input"      ''
open "{}"               '{}'
open "not json"         'not json'
open "truncated input"  '{"tool_name":"Write","tool_input":{"file_path":"/r/.claude/settings.json'
mkdir -p "$T/nojq"; for b in cat tr date mkdir dirname git; do p=$(command -v "$b") && ln -s "$p" "$T/nojq/$b"; done
open "no jq on PATH"    "$(input Write "$R/.claude/settings.proposed.json")" "$T/nojq"
mkdir -p "$T/nogit"; printf '#!/bin/sh\nexit 127\n' > "$T/nogit/git"; chmod +x "$T/nogit/git"
open "a broken git"     "$(input Write "$R/.claude/settings.proposed.json")" "$T/nogit:$PATH"

echo
if [ "$fails" != 0 ]; then echo "$fails FAILED"; exit 1; fi
echo "all cases passed"
