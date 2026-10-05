#!/usr/bin/env bash
# Tests for ask-first.sh. Run: bash .claude/hooks/test-ask-first.sh
#
# A tool call that speaks for the user to other people is blocked (exit 2), for
# every caller; reading, labelling, drafting and every other tool pass. Plus
# fail-open on malformed input, no jq, a broken git.

set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$DIR/ask-first.sh"
fails=0
T=$(mktemp -d "${TMPDIR:-/tmp}/ask-first-test.XXXXXX") || exit 1
trap 'rm -rf "$T"' EXIT

pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; shift; for l in "$@"; do printf '        %s\n' "$l"; done; fails=$((fails + 1)); }

# The recipient is joined at run time: no committed line is email-shaped
# (tests/test_leak_shapes.py). The hook does not read it; a send just carries one.
input() {
  jq -nc --arg tool "$1" --arg t "${2:-}" --arg to "a@""b.c" \
    '{hook_event_name:"PreToolUse",session_id:"s",cwd:"/x",tool_name:$tool,tool_input:{to:$to,body:"hi"}}
     + (if $t == "" then {} else {agent_type:$t, agent_id:"a1"} end)'
}

want() {   # <exit> <tool> [agent_type]
  local code err desc="$2${3:+ ($3)}"
  err=$(input "$2" "${3:-}" | bash "$HOOK" 2>&1 >/dev/null); code=$?
  if [ "$code" != "$1" ]; then fail "$desc" "want exit $1, got $code: ${err:0:200}"; return; fi
  if [ "$1" = 2 ] && ! printf '%s' "$err" | grep -q "approval"; then
    fail "$desc" "blocked without saying how it gets through: ${err:0:200}"; return
  fi
  if [ "$1" = 0 ] && [ -n "$err" ]; then fail "$desc" "passed but spoke: ${err:0:200}"; return; fi
  pass "$desc"
}

echo "blocked (exit 2), from every caller:"
for role in "" some-agent another-agent; do
  want 2 mcp__claude_ai_Gmail__send_message "$role"
done
want 2 mcp__claude_ai_Gmail__reply
want 2 mcp__claude_ai_Gmail__forward
want 2 mcp__claude_ai_Gmail__send_draft
want 2 mcp__gmail__send_message
want 2 mcp__claude_ai_Google_Drive__share_file
want 2 mcp__claude_ai_Dropbox__create_shared_link
want 2 mcp__claude_ai_Dropbox__create_file_request

echo "passes (exit 0, silent):"
want 0 mcp__claude_ai_Gmail__search_threads some-agent
want 0 mcp__claude_ai_Gmail__get_thread some-agent
want 0 mcp__claude_ai_Gmail__label_thread some-agent
want 0 mcp__claude_ai_Gmail__create_draft some-agent
want 0 mcp__claude_ai_Google_Drive__read_file_content some-agent
want 0 mcp__claude_ai_Dropbox__search some-agent
want 0 mcp__claude-in-chrome__navigate some-agent
want 0 mcp__other__send_message some-agent
want 0 Bash some-agent

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
open "truncated input"  '{"tool_name":"mcp__claude_ai_Gmail__send_mess'
mkdir -p "$T/nojq"; for b in cat tr date mkdir dirname git; do p=$(command -v "$b") && ln -s "$p" "$T/nojq/$b"; done
open "no jq on PATH"    "$(input mcp__claude_ai_Gmail__search_threads)" "$T/nojq"
mkdir -p "$T/nogit"; printf '#!/bin/sh\nexit 127\n' > "$T/nogit/git"; chmod +x "$T/nogit/git"
open "a broken git"     "$(input mcp__claude_ai_Gmail__search_threads)" "$T/nogit:$PATH"

echo
if [ "$fails" != 0 ]; then echo "$fails FAILED"; exit 1; fi
echo "all cases passed"
