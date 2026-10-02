#!/usr/bin/env bash
# Verifies the hook layer ACROSS every tool folder. Run directly, or via
# `./dev.sh hooks`, which `./dev.sh check` calls.
#
# WHY THIS EXISTS. The hooks are the only thing enforcing three rules that
# prose failed to enforce, and the hook layer itself had none of the guarantees
# it provides. Four things were true at once and nothing reported any of them:
#
#   1. FOUR copies of no-inline-blobs.sh existed (this repo, the tools folder,
#      emailTools, scriptingTools/chronjobScheduler) and "keep them in step" was
#      a comment. Their logic did agree -- by diligence, not by check.
#   2. prefer-recipes.sh and troubleshooting.sh existed in only 2 of those 4
#      locations, so "prefer the recipe over a browser" was enforced from some
#      working directories and silently not from others.
#   3. Both new hooks resolved site-scrapers as "../..", which is correct only
#      from those same 2 locations. Installed anywhere else they exited 0 and
#      enforced nothing while still looking installed.
#   4. Nothing tested that a hook FAILS OPEN, which is the property the entire
#      design rests on -- every header promises it and no check confirmed it.
#
# A guard that is present, reports no error, and does not run is the worst
# outcome available, because you stop looking. So the hook layer gets the same
# treatment as everything else here: checked by something that fails loudly.
#
# Drift is compared on LOGIC ONLY (comments stripped). Each copy's header
# legitimately describes its own location, so byte-equality is the wrong test --
# it would fail forever and get switched off.
#
# Works standalone: with no sibling tool folders it checks this repo alone, so a
# fresh clone still gets the in-repo guarantees.

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLS="$(dirname "$REPO")"
errors=0
notes=0

# --sync copies this repo's hooks over every other location, because that chore
# recurs on every hook change and was already got wrong once: the find_repo fix
# went into this repo's copies and the tools-folder copies drifted within
# minutes. This repo is the canonical source -- its copies are the committed,
# tested ones. Only the FILES are synced; wiring a hook into a location's
# settings.json is a deliberate act, and the check below reports it if missing.
if [ "${1:-}" = "--sync" ]; then
  synced=0
  for d in $(find "$TOOLS" -maxdepth 4 -type d -path "*/.claude/hooks" -not -path "*/node_modules/*" 2>/dev/null | sort); do
    [ "$d" = "$REPO/.claude/hooks" ] && continue
    for f in "$REPO"/.claude/hooks/*.sh; do
      name="$(basename "$f")"
      if ! cmp -s "$f" "$d/$name"; then
        cp "$f" "$d/$name" && chmod +x "$d/$name" && printf '  synced %s -> %s\n' "$name" "${d#$TOOLS/}"
        synced=$((synced + 1))
      fi
    done
  done
  [ "$synced" = 0 ] && echo "  already in step"
  echo
fi

err()  { printf '  ERROR  %s\n' "$*"; errors=$((errors + 1)); }
note() { printf '  note   %s\n' "$*"; notes=$((notes + 1)); }
ok()   { printf '  ok     %s\n' "$*"; }

# Comments and blank lines removed: what the shell will actually execute.
logic_hash() { grep -vE '^[[:space:]]*#' "$1" 2>/dev/null | grep -vE '^[[:space:]]*$' | shasum -a256 | cut -c1-16; }

# The hook SCRIPTS a settings.json registers, one per line, across EVERY event
# (PreToolUse, PostToolUse, SessionStart, SubagentStop, ...), not just
# PreToolUse. The script is the first word after `.claude/hooks/`; anything after
# it is an argument. This used to take everything after the last `/` and let the
# shell word-split it, so `agent-watch.sh prespawn` became two "hooks", and the
# check reported a missing hook called `prespawn` that would refuse every call.
# A command that names no .claude/hooks/ script is not a hook file and is skipped.
wired_scripts() {
  jq -r '[.hooks // {} | .[]?[]?.hooks[]?.command // empty] | .[]' "$1" 2>/dev/null \
    | sed -n 's#.*\.claude/hooks/\([^[:space:]]*\).*#\1#p' | sort -u
}

# Every .claude/hooks directory in the tools folder, this repo included. Depth 3
# covers a nested repo such as scriptingTools/chronjobScheduler.
locations=$(find "$TOOLS" -maxdepth 4 -type d -path "*/.claude/hooks" -not -path "*/node_modules/*" 2>/dev/null | sort)
[ -n "$locations" ] || locations="$REPO/.claude/hooks"

echo "hook locations:"
for d in $locations; do printf '  %s\n' "${d#$TOOLS/}"; done
echo

# --- 1. Logic drift between copies of the same hook ---------------------------
echo "logic identical across copies:"
names=$(for d in $locations; do ls "$d"/*.sh 2>/dev/null; done | xargs -n1 basename 2>/dev/null | sort -u)
for name in $names; do
  hashes=""
  for d in $locations; do
    [ -f "$d/$name" ] || continue
    hashes="$hashes$(logic_hash "$d/$name") ${d#$TOOLS/}/$name"$'\n'
  done
  distinct=$(printf '%s' "$hashes" | awk 'NF {print $1}' | sort -u | wc -l | tr -d ' ')
  copies=$(printf '%s' "$hashes" | awk 'NF' | wc -l | tr -d ' ')
  if [ "$distinct" -le 1 ]; then
    ok "$name ($copies cop$( [ "$copies" = 1 ] && echo y || echo ies))"
  else
    err "$name has DRIFTED — $distinct different implementations across $copies copies:"
    printf '%s' "$hashes" | awk 'NF {printf "           %s  %s\n", $1, $2}'
  fi
done
echo

# --- 2. Uneven coverage -------------------------------------------------------
# A hook present in one location and absent from another means the rule it
# enforces depends on which directory the session happened to start in.
#
# Only for the hooks THIS repo twins, though. Since 2026-10-01 the top level
# also holds hooks that exist there alone by design (the claudeTest dispatcher's
# delegation layer, which only exists at the top level), and requiring every
# hook everywhere turned each of them into a false ERROR. The twinned set is
# derived, never listed: what this repo's settings.json registers plus the hook
# scripts in this repo's .claude/hooks/. A new top-level-only hook therefore
# needs no exception here, and a twin deleted from EITHER side still fails --
# from the top level as "missing from .claude/hooks", from this repo as
# "settings.json names X but it does not exist" (section 3) and as missing here.
twinned=$( { wired_scripts "$REPO/.claude/settings.json"
             for f in "$REPO"/.claude/hooks/*.sh; do [ -f "$f" ] && basename "$f"; done
           } | grep -v '^test-' | sort -u)
echo "coverage (hooks this repo twins: $(printf '%s' "$twinned" | tr '\n' ' '| sed 's/ $//')):"
[ -n "$twinned" ] || err "this repo registers and holds no hooks at all -- the twinned set is empty, so nothing below is checked"
# Over every file found AND every twinned name: a twin registered here but
# present nowhere has no file to be found by, and must still be reported.
for name in $(printf '%s\n%s\n' "$names" "$twinned" | awk 'NF' | sort -u); do
  case "$name" in test-*) continue ;; esac
  if ! printf '%s\n' "$twinned" | grep -qxF "$name"; then
    here=""
    for d in $locations; do [ -f "$d/$name" ] && here="$here ${d#$TOOLS/}"; done
    ok "$name is local to:$here (not a hook this repo twins)"
    continue
  fi
  missing=""
  for d in $locations; do [ -f "$d/$name" ] || missing="$missing ${d#$TOOLS/}"; done
  if [ -n "$missing" ]; then
    err "$name is missing from:$missing (the rule it enforces is not in effect there)"
  else
    ok "$name is installed everywhere"
  fi
done
echo

# --- 3. Per-location wiring, syntax, and fail-open ----------------------------
echo "each hook is wired, parses, and fails open:"
for d in $locations; do
  loc="${d#$TOOLS/}"
  settings="$(dirname "$d")/settings.json"

  if [ ! -f "$settings" ]; then
    err "$loc has hooks but no settings.json — none of them run"
    continue
  fi
  if ! jq -e . "$settings" >/dev/null 2>&1; then
    err "$loc settings.json is not valid JSON — Claude Code silently ignores the whole file"
    continue
  fi

  wired=$(wired_scripts "$settings")
  for name in $wired; do
    f="$d/$name"
    if [ ! -f "$f" ]; then
      # The dangerous direction: Claude Code reads a non-zero exit as a block,
      # so a named-but-absent hook command refuses every matching tool call.
      err "$(dirname "$loc")/settings.json names $name but it does not exist — every matching tool call will be REFUSED"
      continue
    fi
    [ -x "$f" ] || err "$loc/$name is not executable (chmod +x it, or it cannot run)"
    bash -n "$f" 2>/dev/null || err "$loc/$name is not valid bash"

    # Fail-open, on the three inputs a hook can actually be handed badly.
    # Run WITHOUT the registered arguments, deliberately: a mode such as
    # `agent-watch.sh spawn` records into its owner's ledger, and this check
    # must not write into another tool's state. Each mode's own behaviour is
    # its owner's test-<hook>.sh to cover, not this cross-folder check.
    for payload in '' '{}' 'not json at all'; do
      rc=0
      printf '%s' "$payload" | bash "$f" >/dev/null 2>&1 || rc=$?
      [ "$rc" = 0 ] || err "$loc/$name does not fail open: exit $rc on input [${payload:-<empty>}]"
    done
  done

  # A hook file sitting there that nothing wires is not enforcing anything.
  for f in "$d"/*.sh; do
    [ -f "$f" ] || continue
    name="$(basename "$f")"
    case "$name" in test-*) continue ;; esac
    printf '%s\n' "$wired" | grep -qx "$name" || note "$loc/$name is present but not wired in settings.json"
  done

  # Every hook needs a test beside it, and every test needs its hook.
  for f in "$d"/*.sh; do
    [ -f "$f" ] || continue
    name="$(basename "$f")"
    case "$name" in test-*) continue ;; esac
    [ -f "$d/test-$name" ] || note "$loc/$name has no test-$name beside it"
  done
done
echo

if [ "$errors" = 0 ]; then
  if [ "$notes" = 0 ]; then echo "hooks: clean"
  else echo "hooks: clean, $notes note$( [ "$notes" = 1 ] || echo s)"; fi
  exit 0
fi
echo "hooks: $errors ERROR$( [ "$errors" = 1 ] || echo S)"
exit 1
