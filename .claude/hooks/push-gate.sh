#!/usr/bin/env bash
# hooks: applies_to=all
# Push code changes to git right away -- held by a hook, not by prose. Stop and
# SubagentStop hook; see ../settings.json. Tests: bash .claude/hooks/test-push-gate.sh
#
# Refuses the stop ONCE ({"decision":"block"}, exit 0) when the stopping
# writer leaves, in a git repo it wrote in:
#   - commits ahead of the upstream (else origin/<branch>) whose `Agent-Id:`
#     trailer is its own (git-stamp.sh writes it: agent_id, or a main
#     thread's session_id). Someone else's unpushed commits are not its own;
#   - files whose last ledger write (../lib/ledger.sh) is its own and that
#     `git status` still shows as uncommitted.
# The reason names each repo and the exact command (`git -C <repo> push`;
# the paths to stage by name). Why it exists: PLAN-hard-gates.md §3 row 5, and
# §8 answer 3: one block per stop, never a loop -- when Claude Code says the
# stop is already a continuation (`stop_hook_active`), the hook lets it stop
# and puts the same findings in a `systemMessage` instead.
#
# WHICH REPOS: those holding a ledger under the project dir
# ($CLAUDE_PROJECT_DIR, else cwd) with a write row of the writer's. The
# remote is never contacted: "ahead" is against the remote-tracking ref as of
# the last fetch or push. A repo with no upstream and no origin/<branch>, or
# where git fails, says nothing (cannot tell).
#
# NOT SEEN: a repo the writer changed without a ledger row (a script, a repo
# outside the project dir); an unstamped commit (the commit-msg git hook
# refuses those, PLAN-hard-gates.md §7 phase 2).
#
# INSTALLED INTO EVERY REPO'S .claude/hooks/, because a hook only fires when
# Claude Code's project dir is the one holding it. The source is tools/hooks
# (source/hooks/); `hooks copies` there fails when a copy differs from it.
# Change the source, never a copy.
#
# FAILS OPEN. Malformed input, no jq, no git, no ledger, ../lib/ledger.sh
# absent: exit 0, no output. Exit 2 is never used.

set -o pipefail

# At most this many paths are named per repo; the rest are counted.
MAX_PATHS=10

input=$(cat 2>/dev/null) || exit 0
command -v jq >/dev/null 2>&1 || exit 0
command -v git >/dev/null 2>&1 || exit 0
fields=$(printf '%s' "$input" | jq -r '[(.hook_event_name, .cwd, .agent_type, .agent_id, .session_id) | strings // ""]
  + [(.stop_hook_active == true | tostring)] | join("\u001f")' 2>/dev/null) || exit 0
IFS=$'\x1f' read -r event cwd agent_type agent_id session active <<< "$fields"
case "$event" in Stop|SubagentStop) ;; *) exit 0 ;; esac
[ -n "$session" ] || exit 0
[ -n "$cwd" ] || cwd=$PWD
root=${CLAUDE_PROJECT_DIR:-$cwd}

libdir="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)/../lib"
[ -f "$libdir/ledger.sh" ] && . "$libdir/ledger.sh" 2>/dev/null && type ledger_last >/dev/null 2>&1 || exit 0

stamp=${agent_id:-$session}
if [ -n "$agent_id" ]; then who="agent ${agent_type:-?} ($agent_id)"; else who="the main thread"; fi

q() { printf "'%s'" "${1//\'/\'\\\'\'}"; }   # shell-quote one word

# The writer's own last writes, every ledger, each paired with the git repo it
# sits in (git's toplevel is a resolved path, the ledger's a lexical one, so
# they are paired by asking git, never by prefix). A path holding a newline is
# skipped: it cannot be one line here.
P_TOP=(); P_PATH=(); TOPS=$'\n'
while IFS= read -r L; do
  [ -n "$L" ] || continue
  while IFS=$'\t' read -r p _ w_id w_session _ _; do
    [ -n "$p" ] || continue
    if [ -n "$agent_id" ]; then [ "$w_id" = "$agent_id" ] || continue
    else [ "$w_id" = - ] && [ "$w_session" = "$session" ] || continue; fi
    case "$p" in *'\n'*|*'\r'*) continue ;; esac
    f=$(printf '%b' "$p")
    d=${f%/*}; while [ -n "$d" ] && [ ! -d "$d" ]; do d=${d%/*}; done
    top=$(git -C "${d:-/}" rev-parse --show-toplevel 2>/dev/null) || continue
    [ -n "$top" ] || continue
    P_TOP+=("$top"); P_PATH+=("$f")
    case "$TOPS" in *$'\n'"$top"$'\n'*) ;; *) TOPS+="$top"$'\n' ;; esac
  done <<< "$(ledger_last "$L")"
done <<< "$(ledger_files "$root")"

report=""
while IFS= read -r top; do
    [ -n "$top" ] || continue
    paths=()
    for ((k = 0; k < ${#P_TOP[@]}; k++)); do
      [ "${P_TOP[k]}" = "$top" ] && paths+=("${P_PATH[k]}")
    done
    finding=""

    upstream=$(git -C "$top" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)
    if [ -z "$upstream" ]; then
      br=$(git -C "$top" symbolic-ref --short -q HEAD 2>/dev/null)
      [ -n "$br" ] && git -C "$top" rev-parse -q --verify "refs/remotes/origin/$br" >/dev/null 2>&1 && upstream="origin/$br"
    fi
    if [ -n "$upstream" ]; then
      ids=$(git -C "$top" log --format='%(trailers:key=Agent-Id,valueonly)' "$upstream..HEAD" 2>/dev/null) && {
        n=$(printf '%s\n' "$ids" | grep -cxF -- "$stamp")
        [ "$n" -gt 0 ] && finding+=" $n commit(s) of yours not on $upstream: run git -C $(q "$top") push."
      }
    fi

    if [ ${#paths[@]} -gt 0 ]; then
      dirty=$(git -C "$top" status --porcelain=v1 --untracked-files=all -- "${paths[@]}" 2>/dev/null) && [ -n "$dirty" ] && {
        count=$(printf '%s\n' "$dirty" | wc -l | tr -d ' ')
        names=$(printf '%s\n' "$dirty" | head -n "$MAX_PATHS" | cut -c4- | tr '\n' ' ')
        [ "$count" -gt "$MAX_PATHS" ] && names+="and $((count - MAX_PATHS)) more "
        finding+=" $count file(s) you wrote are uncommitted: ${names}-- stage them by name (git -C $(q "$top") add -- <path>...), commit, push; or say in your report why they stay uncommitted."
      }
    fi
    [ -n "$finding" ] && report+=" [$top]$finding"
done <<< "$TOPS"

[ -n "$report" ] || exit 0
if [ "$active" = true ]; then
  jq -nc --arg m "push-gate: $who stopped with unpushed work (already asked once, so not held again):$report" '{systemMessage: $m}'
else
  jq -nc --arg r "push-gate: $who has unpushed work. Push it before stopping (asked once; the next stop is let through):$report" '{decision: "block", reason: $r}'
fi
exit 0
