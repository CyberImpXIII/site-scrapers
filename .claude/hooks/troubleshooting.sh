#!/usr/bin/env bash
# Enforces the troubleshooting order: don't retry what is already known to need
# a person, and don't re-derive a recipe without reading what broke last time.
# PreToolUse hook on Bash; see ../settings.json.
# Tests: bash .claude/hooks/test-troubleshooting.sh
#
# COPIED INTO EVERY TOOL FOLDER'S .claude/hooks/, because a hook only fires when
# Claude Code's project dir is the one holding it. site-scrapers holds the
# canonical copy; `./check-hooks.sh --sync` pushes it everywhere and
# `./check-hooks.sh` fails on drift or a missing install. Copies rather than
# symlinks: a missing hook command exits non-zero, which is read as a block, so a
# dangling link would refuse every Bash call.
#
# WHY THIS IS A HOOK AND NOT A RULE. Two documented rules that nothing enforced:
#
#   1. CLAUDE.md rule 3 on `blocked-attn`: "you are stuck; the next step needs
#      the user. Do NOT retry, that already failed." engine.js DOES refuse a
#      non-working recipe -- but only when `allowUnverified` is absent, and
#      lab.js passes `allowUnverified: true` on every run by design, because
#      that is how a candidate gets exercised at all. So the one documented
#      "never do this" was reachable through the tool an agent troubleshooting a
#      recipe reaches for first. That is the gap this closes.
#
#   2. docs/diagnosing.md opens with "Check what has broken before, first" --
#      `node failures.js match <hostname>`. A second database exists purely to
#      answer that, and consulting it is a step that has to be remembered
#      BEFORE the expensive thing, which is the shape every rule here has lost
#      to so far.
#
# The two get different treatment on purpose. Retrying `blocked-attn` is
# blocked, because the answer is already known and a retry cannot produce a new
# one. Re-deriving without reading the failure history is not blocked -- a
# hook cannot tell whether it was read -- so the relevant history is PRINTED
# instead, which removes the reason to skip it.
#
# FAILS OPEN. A hook that breaks every Bash call would be far worse than the
# problem it solves, so anything unexpected here allows the command.

set -uo pipefail

# Walk UP to find site-scrapers rather than assuming a depth -- see the same
# block in prefer-recipes.sh for why: a fixed "../.." resolved to nothing when
# the hook was installed in another tool folder, so it exited 0 and enforced
# nothing while still looking installed.
find_repo() {
  local d
  d="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  while [ "$d" != "/" ] && [ -n "$d" ]; do
    if [ -f "$d/site-scrapers/dev.sh" ] && [ -f "$d/site-scrapers/engine.js" ]; then
      printf '%s\n' "$d/site-scrapers"; return 0
    fi
    if [ -f "$d/dev.sh" ] && [ -f "$d/engine.js" ]; then
      printf '%s\n' "$d"; return 0
    fi
    d="$(dirname "$d")"
  done
  return 1
}
REPO="$(find_repo)" || exit 0
[ -n "$REPO" ] || exit 0

input=$(cat 2>/dev/null) || exit 0
command=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[ -n "$command" ] || exit 0

# Only commands that RUN a recipe, or CHANGE one. Anything else is ordinary
# shell and none of this hook's business.
runs=false
edits=false
printf '%s' "$command" | grep -qE '(scrape\.sh|engine\.js|verify\.js)([[:space:]]|$)' && runs=true
printf '%s' "$command" | grep -qE 'lab\.js[[:space:]]+(peek|raw|match|params)([[:space:]]|$)' && runs=true
printf '%s' "$command" | grep -qE '(lab\.js[[:space:]]+set|register\.js)([[:space:]]|$)' && edits=true
[ "$runs" = true ] || [ "$edits" = true ] || exit 0

# The target: a hostname-shaped token, optionally #page_type:recipe_name. Taken
# from the whole command rather than by position, because it arrives quoted, as
# `@file`, and after varying flags. Conservative on purpose -- no match means
# this hook stays out of the way.
#
# The filename filter is not optional: `lab.js`, `engine.js` and `scrape.sh` all
# match a hostname shape (name, dot, 2+ letters), and they appear EARLIER in the
# command than the target does. Without it, `node lab.js peek indeed.com` looked
# up a host called "lab.js", found nothing, and the hook allowed a retry of a
# blocked-attn recipe -- silently doing nothing, which is the worst way for a
# guard to fail.
target=$(printf '%s' "$command" \
  | tr " '\"" '\n\n\n' \
  | grep -E '^[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}(#[a-z]+(:[A-Za-z0-9_-]+)?)?$' \
  | grep -viE '\.(js|sh|json|py|ts|md|txt|log|db|html|css)(#|$)' \
  | head -1)
[ -n "$target" ] || exit 0
host="${target%%#*}"

# Fill in the documented defaults, the way parseSiteArg does: both suffixes are
# optional, page_type defaults to `listing` and recipe_name to `default`. So
# `indeed.com`, `indeed.com#listing` and `indeed.com#listing:default` are three
# spellings of one recipe, and a lookup that only understood the third silently
# allowed the other two.
case "$target" in
  *:*) full="$target" ;;
  *\#*) full="$target:default" ;;
  *) full="$target#listing:default" ;;
esac

known=$("$REPO/dev.sh" known "$host" 2>/dev/null) || exit 0
[ -n "$known" ] || exit 0

status=$(printf '%s' "$known" | awk -F'\t' -v t="$full" '$1 == t { print $2 }' | head -1)

# --- 1. Retrying blocked-attn -------------------------------------------------
# An attended run is the SANCTIONED next step for this state, so it is the one
# thing that must not be blocked.
if [ "$runs" = true ] && [ "$status" = "blocked-attn" ] \
   && ! printf '%s' "$command" | grep -q -- '--attended'; then
  {
    echo "BLOCKED: ${target} is status=\"blocked-attn\" — this was already tried and failed."
    echo
    echo "blocked-attn does not mean the site is hostile. It means troubleshooting"
    echo "STALLED pending the user: whoever set it concluded the next step cannot be"
    echo "determined without them. Retrying is what produced this state."
    echo
    echo "Read what they need to supply:"
    echo "  node query.js site ${target}   # the notes say what is needed"
    echo "  ./dev.sh blocked   # everything waiting on the user"
    echo
    echo "The sanctioned next step, which this hook allows, is an ATTENDED run —"
    echo "it opens a real window so a person can clear whatever is in the way:"
    echo "  node verify.js ${target} '<params>' --attended"
    echo
    echo "Otherwise surface it to the user and move on to other work."
    echo
    echo "engine.js refuses a non-working recipe on its own, but only when"
    echo "allowUnverified is absent — and lab.js sets it on every run, which is how"
    echo "this state stayed reachable."
  } >&2
  exit 2
fi

# --- 2. Running something already known to be broken -------------------------
if [ "$runs" = true ] && [ "$status" = "broken" ]; then
  {
    echo "NOTE: ${target} is status=\"broken\" — an understood fault, not a mystery."
    echo "Read the diagnosis before re-deriving it: node query.js site ${target}"
    echo "Proceeding; this is a warning, not a block."
  } >&2
fi

# --- 3. About to change a recipe: print what broke here before ----------------
# The step docs/diagnosing.md asks for first. Printed rather than demanded,
# because whether it was read is not something a hook can know -- and a hit on
# a DIFFERENT site with the same shape is often the useful one, which is why
# failures.js scores matches instead of filtering them.
if [ "$edits" = true ]; then
  hits=$(cd "$REPO" && ./dev.sh failures "$host" 2>/dev/null | head -5)
  if [ -n "$hits" ]; then
    {
      echo "Before changing ${host} — this has broken here before:"
      printf '%s\n' "$hits"
      echo
      echo "Full detail: node failures.js match ${host}"
      echo "Record what you find: node failures.js record '<json>' (a repeat bumps occurrences)"
      echo "Proceeding; this is context, not a block."
    } >&2
  fi
fi

exit 0
