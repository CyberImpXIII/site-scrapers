#!/usr/bin/env bash
# Tests for git-stamp.sh. Run: bash .claude/hooks/test-git-stamp.sh
#
# Four kinds of case:
#   - the blocks: --no-verify, core.hooksPath, add -A/./--all, commit -a/--all/.
#     (exit 2, nothing rewritten), each beside a look-alike that is not blocked;
#   - the rewrite itself: the exact command the hook hands back;
#   - commands it must leave alone (no output at all): not a commit, a commit
#     that is only text inside quotes or a heredoc, a command it cannot parse;
#   - end to end: the rewritten command run in a scratch repo, then git's own
#     reading of the new commit's trailers. A rewrite that produced a command
#     git rejects, or trailers git does not parse, fails here.
# Plus fail-open: malformed input, missing jq, missing git -> exit 0, no output.

set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$DIR/git-stamp.sh"
fails=0
T=$(mktemp -d "${TMPDIR:-/tmp}/git-stamp-test.XXXXXX") || exit 1
trap 'rm -rf "$T"' EXIT

pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; shift; for l in "$@"; do printf '        %s\n' "$l"; done; fails=$((fails + 1)); }

# input <command> [agent_type] -> a PreToolUse Bash input. No agent_type = the
# main thread (no agent_type, no agent_id in the input).
input() {
  if [ -n "${2:-}" ]; then
    jq -nc --arg c "$1" --arg t "$2" '{hook_event_name:"PreToolUse",session_id:"sess-1",cwd:"/x",tool_name:"Bash",
      tool_input:{command:$c,description:"d"},agent_type:$t,agent_id:"agent-1"}'
  else
    jq -nc --arg c "$1" '{hook_event_name:"PreToolUse",session_id:"sess-1",cwd:"/x",tool_name:"Bash",
      tool_input:{command:$c,description:"d"}}'
  fi
}

# rewritten <command> <want> [agent_type]: the hook returns exactly <want>.
rewritten() {
  local desc="$1" cmd="$2" want="$3" type="${4:-}" out got code
  out=$(input "$cmd" "$type" | bash "$HOOK" 2>/dev/null); code=$?
  got=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.updatedInput.command // "<no rewrite>"' 2>/dev/null)
  if [ "$code" = 0 ] && [ "$got" = "$want" ]; then pass "$desc"
  else fail "$desc" "exit $code" "want: $want" "got:  $got"; fi
}

# unchanged <desc> <command>: exit 0 and no output at all.
unchanged() {
  local desc="$1" cmd="$2" out code
  out=$(input "$cmd" "some-agent" | bash "$HOOK" 2>&1); code=$?
  if [ "$code" = 0 ] && [ -z "$out" ]; then pass "$desc"
  else fail "$desc" "exit $code, output: ${out:0:200}"; fi
}

A="--trailer 'Agent: some-agent' --trailer 'Agent-Id: agent-1'"
M="--trailer 'Agent: dispatcher' --trailer 'Agent-Id: sess-1'"

echo "rewrites (exact command handed back):"
rewritten "a subagent's commit"            'git commit -m x'  "git commit $A -m x"  some-agent
rewritten "the main thread's commit"       'git commit -m x'  "git commit $M -m x"
rewritten "after cd &&, before && push"    'cd sub && git commit -q -m "a b" && git push' \
          "cd sub && git commit $A -q -m \"a b\" && git push"  some-agent
rewritten "git global options"             'git -C ../x -c user.name=y commit -m z' \
          "git -C ../x -c user.name=y commit $A -m z"  some-agent
rewritten "an assignment prefix"           'GIT_EDITOR=true git commit --amend --no-edit' \
          "GIT_EDITOR=true git commit $A --amend --no-edit"  some-agent
rewritten "two commits, both stamped"      'git commit -m a; git commit -m b' \
          "git commit $A -m a; git commit $A -m b"  some-agent
rewritten "git by path"                    '/usr/bin/git commit -m x'  "/usr/bin/git commit $A -m x"  some-agent
HD=$'git commit -m "$(cat <<\'EOF\'\nwe don\'t "git commit" here\n\nCo-Authored-By: x\nEOF\n)"'
rewritten "heredoc message: stamped once"  "$HD"  "git commit $A ${HD#git commit }"  some-agent

# Other tool_input fields survive the rewrite.
out=$(input 'git commit -m x' some-agent | bash "$HOOK" 2>/dev/null)
if [ "$(printf '%s' "$out" | jq -r '.hookSpecificOutput.updatedInput.description')" = d ] &&
   [ "$(printf '%s' "$out" | jq -r '.hookSpecificOutput.hookEventName')" = PreToolUse ] &&
   [ "$(printf '%s' "$out" | jq -r '.hookSpecificOutput | has("permissionDecision")')" = false ]; then
  pass "other fields kept; no permission decision taken"
else fail "other fields kept; no permission decision taken" "${out:0:300}"; fi

echo "left alone (exit 0, no output):"
unchanged "not a commit"                   'git status --short'
unchanged "commit as an argument"          'git log --grep commit'
unchanged "commit only inside quotes"      'echo "git commit -m x"'
unchanged "commit only in single quotes"   "grep 'git commit' notes.txt"
unchanged "commit only in a heredoc body"  $'cat > f <<EOF\ngit commit -m x\nEOF'
unchanged "commit only in a comment"       'ls # then git commit'
unchanged "unterminated quote"             'git commit -m "unterminated'
unchanged "a backtick (not parsed)"        'git commit -m `date`'
unchanged "an empty command"               ''
out=$(input 'git commit -m x' "bad'name" | bash "$HOOK" 2>&1); code=$?
if [ "$code" = 0 ] && [ -z "$out" ]; then pass "an agent name it cannot quote"
else fail "an agent name it cannot quote" "exit $code: ${out:0:200}"; fi

echo "end to end (git reads the trailers back):"
e2e() {
  local desc="$1" cmd="$2" repo="$T/repo-$RANDOM" new got
  # the address is joined at run time: no committed line is email-shaped (tests/test_leak_shapes.py)
  local at=@
  git init -q "$repo" && git -C "$repo" config user.email "t${at}t" && git -C "$repo" config user.name t
  mkdir -p "$repo/sub" && echo 1 > "$repo/f" && git -C "$repo" add f
  new=$(input "$cmd" some-agent | bash "$HOOK" 2>/dev/null | jq -r '.hookSpecificOutput.updatedInput.command // empty')
  if [ -z "$new" ]; then fail "$desc" "no rewrite"; return; fi
  ( cd "$repo" && bash -c "$new" ) >/dev/null 2>&1
  got=$(git -C "$repo" log -1 --format='%(trailers:key=Agent,valueonly,separator=%x2C)|%(trailers:key=Agent-Id,valueonly)' 2>/dev/null)
  if [ "$got" = "some-agent|agent-1" ]; then pass "$desc"
  else fail "$desc" "trailers read back: '$got'" "command run: $new"; fi
}
e2e "plain -m"                 'git commit -q -m "first line"'
# Without the apostrophe: macOS's bash 3.2 itself cannot parse an unbalanced
# quote in a heredoc inside "$( )" (the command fails with or without the hook).
e2e "heredoc message"          "${HD//\'t/ not}"
e2e "cd, -C, then more"        'cd sub && git -C .. commit -q -m x && echo done'

echo "blocked (exit 2, nothing rewritten, the reason named):"
# blocked <desc> <command> <text the message must hold> [agent_type]
blocked() {
  local desc="$1" cmd="$2" want="$3" out err code
  err=$(input "$cmd" "${4:-some-agent}" | bash "$HOOK" 2>&1 >/dev/null); code=$?
  out=$(input "$cmd" "${4:-some-agent}" | bash "$HOOK" 2>/dev/null)
  if [ "$code" != 2 ]; then fail "$desc" "want exit 2, got $code: ${err:0:200}"
  elif [ -n "$out" ]; then fail "$desc" "blocked AND rewrote: ${out:0:200}"
  else case "$err" in *"$want"*) pass "$desc" ;; *) fail "$desc" "message lacks [$want]: ${err:0:300}" ;; esac; fi
}
NV="--no-verify"; HP="core.hooksPath"; AA="git add -A"; CA="git commit -a"
blocked "commit --no-verify"               'git commit --no-verify -m x'           "$NV"
blocked "commit -n"                        'git commit -n -m x'                    "$NV"
blocked "commit -nm (a cluster)"           'git commit -nm x'                      "$NV"
blocked "the main thread too"              'git commit --no-verify -m x'           "$NV" ""
blocked "after cd &&"                      'cd sub && git commit -q --no-verify -m x && git push' "$NV"
blocked "quoted \"--no-verify\""           'git commit "--no-verify" -m x'         "$NV"
blocked "merge --no-verify"                'git merge --no-verify topic'           "$NV"
blocked "-c core.hooksPath for one command" 'git -c core.hooksPath=/dev/null commit -m x' "$HP"
blocked "  any case"                       'git -c CORE.HOOKSPATH=x status'        "$HP"
blocked "git config core.hooksPath x"      'git config core.hooksPath /dev/null'   "$HP"
blocked "git config --unset core.hooksPath" 'git config --unset core.hooksPath'    "$HP"
blocked "git config --global ... "         'git config --global core.hooksPath x'  "$HP"
blocked "git add -A"                       'git add -A'                            "$AA"
blocked "git add --all"                    'git add --all && git commit -m x'      "$AA"
blocked "git add ."                        'git add .'                             "$AA"
blocked "git add -- ."                     'git add -- .'                          "$AA"
blocked "git add :/"                       'git add :/'                            "$AA"
blocked "git add -Av (a cluster)"          'git add -Av'                           "$AA"
blocked "git -C x add -A"                  'git -C ../x add -A'                    "$AA"
blocked "commit -a"                        'git commit -a -m x'                    "$CA"
blocked "commit -am (a cluster)"           'git commit -am x'                      "$CA"
blocked "commit --all"                     'git commit --all -m x'                 "$CA"
blocked "commit ."                         'git commit -m x .'                     "$CA"
blocked "two reasons, both named"          'git add . && git commit --no-verify -m x' "$NV"
blocked "  (the other)"                    'git add . && git commit --no-verify -m x' "$AA"
out=$(input 'git commit -m x' "bad'name" | bash "$HOOK" 2>/dev/null); code=$?
err=$(input 'git commit -n -m x' "bad'name" | bash "$HOOK" 2>&1 >/dev/null); code2=$?
if [ "$code" = 0 ] && [ -z "$out" ] && [ "$code2" = 2 ]; then pass "an unquotable name: no stamp, still blocked"
else fail "an unquotable name: no stamp, still blocked" "stamp exit $code, block exit $code2"; fi

echo "not blocked (the input changes the output):"
rewritten "commit -m with -a as the message"  'git commit -m -a'   "git commit $A -m -a"  some-agent
rewritten "commit -m \"--no-verify\""         'git commit -m "--no-verify"'  "git commit $A -m \"--no-verify\""  some-agent
rewritten "commit -F n (a value, not -n)"     'git commit -F n'    "git commit $A -F n"  some-agent
rewritten "commit -- path"                    'git commit -m x -- a.txt' "git commit $A -m x -- a.txt" some-agent
rewritten "commit -v (not -n)"                'git commit -v -m x' "git commit $A -v -m x" some-agent
unchanged "git add by name"                   'git add -- a.txt b/c.txt'
unchanged "git add -u (not refused)"          'git add -u'
unchanged "git add ./x (a path, not .)"       'git add ./x'
unchanged "git config core.hooksPath (a read)" 'git config core.hooksPath'
unchanged "git config --get core.hooksPath"   'git config --get core.hooksPath'
unchanged "git merge -n (no-stat in merge)"   'git merge -n topic'
unchanged "git push --no-verify (no gate)"    'git push --no-verify'
unchanged "-A in quotes, not git"             'echo "git add -A"'
unchanged "git log --grep hooksPath"          'git log --grep core.hooksPath'
unchanged "git add \$X (not judged)"          'git add $X'

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
open "truncated input"  '{"tool_name":"Bash","tool_input":{"command":"git commit -m x'
mkdir -p "$T/nojq"; for b in cat tr date mkdir dirname git; do p=$(command -v "$b") && ln -s "$p" "$T/nojq/$b"; done
open "no jq on PATH"    "$(input 'git commit -m x' some-agent)" "$T/nojq"
# Missing git: the hook never calls git, so a commit is still stamped; what
# must not happen is a block or an error. A broken git is first on PATH.
mkdir -p "$T/nogit"; printf '#!/bin/sh\nexit 127\n' > "$T/nogit/git"; chmod +x "$T/nogit/git"
out=$(input 'git commit -m x' some-agent | PATH="$T/nogit:$PATH" "$BASH" "$HOOK" 2>/dev/null); code=$?
if [ "$code" = 0 ] && [ "$(printf '%s' "$out" | jq -r '.hookSpecificOutput.updatedInput.command')" = "git commit $A -m x" ]; then
  pass "a broken git: still exit 0, same rewrite"
else fail "a broken git: still exit 0, same rewrite" "exit $code: ${out:0:200}"; fi

echo
if [ "$fails" != 0 ]; then echo "$fails FAILED"; exit 1; fi
echo "all cases passed"
