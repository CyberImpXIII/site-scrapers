#!/usr/bin/env bash
# Blocks an interactive browser call against a site that already has a working
# recipe. PreToolUse hook on the Claude-in-Chrome tools and WebFetch; see
# ../settings.json. Tests: bash .claude/hooks/test-prefer-recipes.sh
#
# A SECOND COPY lives at claudeTest/.claude/hooks/, for the same reason
# no-inline-blobs.sh has one: a hook only fires when Claude Code's project dir
# is the one holding it, so this copy covers sessions inside the repo and
# travels with a fresh clone, that one covers sessions started from the parent
# folder. Copies rather than a symlink -- a hook whose command is missing exits
# non-zero, which would block every matching call, so a dangling link would be
# far worse than the duplication. Keep them in step.
#
# WHY THIS IS A HOOK AND NOT A RULE: it was already a rule, in two files.
# claudeTest/CLAUDE.md opens with "Before reaching for a generic approach
# (interactive browser tools, one-off scripts, manual steps), check whether a
# tool in this folder already does the job", and site-scrapers/CLAUDE.md rule 1
# is "Check before assuming: node query.js site <target>". The whole README
# section "Why this saves tokens" measures the gap: a known site is one Bash
# call returning one JSON object, where the interactive path is a
# tabs_context_mcp call, a navigate, one or more screenshots (the single most
# expensive line item), a read_page accessibility dump that can run to tens of
# thousands of characters, and several chunked javascript_tool extractions --
# 8+ round trips for the same data.
#
# The failure mode is not ignorance, it is habit: opening a browser is the
# obvious move, and the check that would have avoided it is one the agent has
# to remember to make FIRST, before the expensive thing. That is exactly the
# shape rule 4 already lost to, which is why that one became a hook too.
#
# It blocks rather than warns because on a `working` recipe the alternative is
# strictly better and always available. When a browser is genuinely needed --
# building a second recipe for the same host, confirming a wall, an attended
# handoff -- `./dev.sh browser-ok` opens a short window. That is a conscious
# act, which is the point; a block with no way past it would be worse than the
# habit it corrects.
#
# FAILS OPEN. A hook that breaks every browser call would be far worse than the
# problem it solves, so anything unexpected here allows the call.

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# The repo is the parent of .claude/ for the in-repo copy, but the copy in the
# parent folder sits beside site-scrapers/ rather than inside it.
[ -f "$REPO/dev.sh" ] || REPO="$REPO/site-scrapers"
[ -f "$REPO/dev.sh" ] || exit 0

input=$(cat 2>/dev/null) || exit 0
tool=$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null) || exit 0
[ -n "$tool" ] || exit 0

# Only the tools that FETCH a page. tabs_context_mcp, read_console_messages and
# the rest carry no URL and say nothing about which site is being visited.
case "$tool" in
  WebFetch|mcp__claude-in-chrome__navigate|mcp__claude-in-chrome__tabs_create_mcp) ;;
  *) exit 0 ;;
esac

url=$(printf '%s' "$input" | jq -r '.tool_input.url // .tool_input.prompt // empty' 2>/dev/null) || exit 0
[ -n "$url" ] || exit 0

# Host only, lowercased, www stripped. Anything that is not an http(s) URL --
# about:blank, a file path, a bare search term -- has no host and is allowed.
host=$(printf '%s' "$url" | sed -nE 's#^[Hh][Tt][Tt][Pp][Ss]?://([^/?#]+).*#\1#p' | sed -E 's/^www\.//; s/:[0-9]+$//' | tr '[:upper:]' '[:lower:]')
[ -n "$host" ] || exit 0

# A deliberate, time-limited override from `./dev.sh browser-ok`.
marker="$REPO/data/.browser-ok"
if [ -f "$marker" ]; then
  started=$(sed -n 1p "$marker" 2>/dev/null)
  mins=$(sed -n 2p "$marker" 2>/dev/null)
  case "$started$mins" in
    ''|*[!0-9]*) : ;;
    *)
      if [ $(( $(date +%s) - started )) -lt $(( mins * 60 )) ]; then exit 0; fi
      ;;
  esac
fi

known=$("$REPO/dev.sh" known "$host" 2>/dev/null) || exit 0
[ -n "$known" ] || exit 0

# Only a `working` recipe is a reason to refuse. A broken, blocked or
# needs-review one means the browser may well be the right tool right now --
# blocking there would strand the one path left.
working=$(printf '%s' "$known" | awk -F'\t' '$2 == "working" { print $1 }')
[ -n "$working" ] || exit 0

{
  echo "BLOCKED: site-scrapers already has a working recipe for ${host}."
  echo
  echo "Use it instead of a browser — one Bash call, one JSON object, no"
  echo "screenshots and no DOM dump:"
  echo
  printf '%s\n' "$working" | sed 's#^#  ./scrape.sh #; s#$# '"'"'{...params}'"'"'#'
  echo
  echo "  node query.js site <target>     # the recipe, its params and its notes"
  echo "  node lab.js peek <target> '{}'  # run it and show samples + null counts"
  echo
  echo "Check the JSON's \"success\" field, not the exit code. A success:false run"
  echo "can still carry records when partialResults is true."
  echo
  echo "This is blocked rather than discouraged because it was already a rule in"
  echo "two CLAUDE.md files, and the interactive path costs 8+ round trips for"
  echo "data one call returns."
  echo
  echo "If you genuinely need the browser here — building another recipe for this"
  echo "host, confirming a wall, an attended handoff — open a window first:"
  echo
  echo "  ./dev.sh browser-ok        # 15 minutes, or pass minutes"
} >&2
exit 2
