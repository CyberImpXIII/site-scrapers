#!/usr/bin/env bash
# hooks: applies_to=all
# Never send a message, email or reply on the user's behalf without asking
# first -- held by a hook, not by prose. PreToolUse hook on the mail, Drive and
# Dropbox MCP tools; see ../settings.json. Tests: bash .claude/hooks/test-ask-first.sh
#
# Blocked (exit 2), whoever the caller is: an MCP tool that speaks for the user
# to other people. The server is recognised by its name (mcp__<server>__<tool>,
# case-insensitive), the tool by its last part:
#   *gmail*    send_message, send_draft, reply, reply_all, forward
#   *drive*    share_file
#   *dropbox*  create_shared_link, create_file_request
# Everything else passes silently: reading, searching, labelling, and drafts (a
# draft sends nothing; it is how a model asks first). A model saying the user
# said yes is not evidence, so there is no model-side way through.
#
# The way through, per PLAN-hard-gates.md §8 answer 4, is an approval record
# written by the user's own command, naming the batch the send belongs to. That
# command and its record format do not exist yet, so today every send listed
# above is refused: the user runs it himself.
#
# NOT SEEN: a send made by a script (a Bash call), or by clicking Send in a
# browser driven by a model. Those are other gates' (the browser tooling's own
# rules; a script's own review).
#
# INSTALLED INTO EVERY REPO'S .claude/hooks/, because a hook only fires when
# Claude Code's project dir is the one holding it. The source is tools/hooks
# (source/hooks/); `hooks copies` there fails when a copy differs from it.
# Change the source, never a copy.
#
# FAILS OPEN. Malformed input, no jq: exit 0. Exit 2 only for a listed send.

set -o pipefail

input=$(cat 2>/dev/null) || exit 0
command -v jq >/dev/null 2>&1 || exit 0
tool_name=$(printf '%s' "$input" | jq -r '.tool_name | strings' 2>/dev/null) || exit 0

case "$tool_name" in mcp__*__*) ;; *) exit 0 ;; esac
rest=${tool_name#mcp__}
tool=${rest##*__}
server=$(printf '%s' "${rest%__*}" | tr '[:upper:]' '[:lower:]')

send=0
case "$server" in
  *gmail*)   case "$tool" in send_message|send_draft|reply|reply_all|forward) send=1 ;; esac ;;
  *drive*)   case "$tool" in share_file) send=1 ;; esac ;;
  *dropbox*) case "$tool" in create_shared_link|create_file_request) send=1 ;; esac ;;
esac
[ $send = 1 ] || exit 0

echo "ask-first: $tool_name speaks for the user to other people, so it runs only with the user's approval record for it, written by the user's own command (that command is not built yet). Refused. Ask the user in the window: they send it themselves, or you write a draft for them to send." >&2
exit 2
