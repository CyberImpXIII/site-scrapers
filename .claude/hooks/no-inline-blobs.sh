#!/usr/bin/env bash
# Blocks inline script blobs in Bash commands. PreToolUse hook; see
# ../settings.json. Tests: bash .claude/hooks/test-no-inline-blobs.sh
#
# A SECOND COPY lives at claudeTest/.claude/hooks/, because a hook only fires
# when Claude Code's project dir is the one holding it -- this copy covers
# sessions inside the repo and travels with a fresh clone, that one covers
# sessions started from the parent folder. Copies rather than a symlink: a hook
# whose command is missing exits non-zero, which would block EVERY Bash call,
# so a dangling link would be far worse than the duplication. Keep them in step.
#
# WHY THIS IS A HOOK AND NOT A RULE: it was already a rule. CLAUDE.md rule 4
# says "Never write an inline script blob", and the session that WROTE that rule
# went on to hand-author the same ~100-character jq filter four times in a row
# while migrating four recipes. A rule you have read and agreed with is not a
# constraint; it is an intention. This project's whole design is to make the
# wrong thing impossible rather than discouraged -- the write guard, the
# validation gate, the read-only generated export -- and this is the same idea
# applied to the shell.
#
# What it costs when it is not enforced:
#   - the blob is re-authored from scratch every time, at full token price
#   - each rewrite is a fresh chance to break shell quoting, which has already
#     cost this project a silent no-op (lab.js set) and a mangled commit message
#   - nothing accumulates: the tenth rewrite is no better than the first, and
#     the next session starts from zero
#
# The alternative is always the same and always cheap: add a subcommand to
# dev.sh, or write a real script and call it. dev.sh exists precisely for this
# and its own header says so.
#
# FAILS OPEN. A hook that breaks every Bash call would be far worse than the
# problem it solves, so anything unexpected here allows the command.

set -uo pipefail

input=$(cat 2>/dev/null) || exit 0
command=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[ -n "$command" ] || exit 0

# Interpreter one-liners. The `-e`/`-c` flag is the whole signature: it means
# the program is being typed rather than stored.
# The `([^[:space:]]*/)?` matters: in this project the interpreter is almost
# always reached by path (~/.nvm/versions/node/v22.20.0/bin/node), and a
# word-boundary-only pattern let exactly the form actually used walk straight
# through.
if printf '%s' "$command" | grep -qE '(^|[;&|[:space:]])([^[:space:]]*/)?(node|nodejs|python|python3|perl|ruby|php)[[:space:]]+(-[a-zA-Z]*[ec])([[:space:]]|$)'; then
  cat >&2 <<'MSG'
BLOCKED: inline script blob (CLAUDE.md rule 4).

You are typing a program instead of storing one. Write it down instead:

  - a recurring read or check  ->  add a subcommand to ./dev.sh
  - anything touching the DB   ->  the CLIs (lab.js / register.js / verify.js /
                                   failures.js), never raw SQL or node -e
  - a genuine one-off          ->  write the script to a file and run the file

This is blocked rather than discouraged because it was already a rule, and
being a rule did not stop it. Re-authoring a blob costs full tokens every time,
risks a new quoting bug every time, and leaves nothing behind for the next
session.
MSG
  exit 2
fi

# Heredocs feeding an interpreter. Same thing wearing a different hat.
if printf '%s' "$command" | grep -qE '<<[-]?[[:space:]]*.?(EOF|EOS|PY|JS|SQL|END)' \
   && printf '%s' "$command" | grep -qE '(^|[;&|[:space:]])([^[:space:]]*/)?(node|nodejs|python|python3|perl|ruby|php|sqlite3)([[:space:]]|$)'; then
  cat >&2 <<'MSG'
BLOCKED: heredoc feeding an interpreter (CLAUDE.md rule 4).

Same as an inline blob -- the program is being typed, not stored. Put it in a
file and run the file, or add a ./dev.sh subcommand.

(A heredoc writing a DATA file, e.g. `cat > recipe.json <<'EOF'`, is fine and
is not what this matches.)
MSG
  exit 2
fi

# Long jq programs. Short filters are ordinary shell; a 120-character one is a
# program, and in this project it has always been a dev.sh subcommand that was
# never written. Warns rather than blocks: jq is the sanctioned way to read
# these CLIs' JSON, and drawing the line by length is a judgement, not a fact.
jq_prog=$(printf '%s' "$command" | grep -oE "jq[[:space:]]+(-[a-zA-Z]+[[:space:]]+)*'[^']{120,}'" 2>/dev/null | head -1)
if [ -n "$jq_prog" ]; then
  cat >&2 <<'MSG'
NOTE: that is a long jq program, not a filter.

If you are about to run it more than once, it belongs in ./dev.sh as a
subcommand -- the same shape as `dev.sh inside`, which exists because the same
filter was hand-written four times. Proceeding; this is a warning, not a block.
MSG
fi

exit 0
