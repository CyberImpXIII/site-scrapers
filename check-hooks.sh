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
# fresh clone still gets the in-repo guarantees -- and says, by name, which
# declared copies it could NOT check (see DECLARED below).

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLS="$(dirname "$REPO")"
errors=0
notes=0
unchecked=0

# DECLARED: every tool folder (relative to the folder above this repo; `.` is
# the top level) that carries copies of the hooks this repo twins. This repo is
# checked always and is not listed (a clone may not be named site-scrapers).
#
# Why a list when the copies are found by `find`: discovery only sees what is
# there. Delete a whole .claude/hooks -- or a whole sibling repo -- and the
# check used to compare the copies that remained and print "clean", one copy
# fewer each time and nothing said. The list is what is SUPPOSED to be there.
#
# An absent declared location is reported according to where this runs:
#   - WORKSPACE (the top level's dispatcher roster, .claude/agents.manifest.json,
#     is present): absent is an ERROR. In the real workspace a declared copy
#     that is gone is exactly the silent loss this list exists to catch.
#   - STANDALONE (that marker is absent, e.g. a fresh clone of site-scrapers on
#     its own): absent is UNCHECKED -- printed per location and counted in the
#     final line, exit 0. There is nothing to compare against, and failing would
#     make the check unusable outside the workspace; passing silently would
#     claim coverage it does not have.
# And the reverse direction: a location found holding a twinned hook but not
# declared is an ERROR in the workspace (add it here), a note standalone.
#
# A location may be nested (tools/setup is a repo two levels down). Declared
# locations are checked wherever they are, not only as deep as discovery looks:
# see all_locations below.
DECLARED=". addon-bench applications emailTools knowledge-base scripts scriptingTools/chronjobScheduler scriptingTools/data-bridge tools/setup"
WORKSPACE_MARKER=".claude/agents.manifest.json"
if [ -f "$TOOLS/$WORKSPACE_MARKER" ]; then mode=workspace; else mode=standalone; fi

declared_dir() { if [ "$1" = . ]; then printf '%s\n' "$TOOLS/.claude/hooks"; else printf '%s\n' "$TOOLS/$1/.claude/hooks"; fi; }

# Every .claude/hooks directory to check: what `find` discovers (depth 4 reaches
# scriptingTools/chronjobScheduler and tools/setup) UNION every declared
# location that exists, at any depth, UNION this repo. Discovery alone had a
# depth horizon: a declared copy one level deeper than it looked would have
# been reported "ok" by section 0 (the directory exists) and then compared,
# synced and probed by nothing. Used by --sync and by every section below, so
# the set synced is the set checked.
all_locations() {
  { find "$TOOLS" -maxdepth 4 -type d -path "*/.claude/hooks" -not -path "*/node_modules/*" 2>/dev/null
    for loc in $DECLARED; do d="$(declared_dir "$loc")"; [ -d "$d" ] && printf '%s\n' "$d"; done
    [ -d "$REPO/.claude/hooks" ] && printf '%s\n' "$REPO/.claude/hooks"
  } | sort -u
}

# --sync copies this repo's hooks over every other location, because that chore
# recurs on every hook change and was already got wrong once: the find_repo fix
# went into this repo's copies and the tools-folder copies drifted within
# minutes. This repo is the canonical source -- its copies are the committed,
# tested ones. Only the FILES are synced; wiring a hook into a location's
# settings.json is a deliberate act, and the check below reports it if missing.
if [ "${1:-}" = "--sync" ]; then
  synced=0
  for d in $(all_locations); do
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

# Every .claude/hooks directory in the tools folder, this repo included.
locations=$(all_locations)
[ -n "$locations" ] || locations="$REPO/.claude/hooks"

echo "hook locations:"
for d in $locations; do printf '  %s\n' "${d#$TOOLS/}"; done
echo

# --- 0. Declared locations: present, or said out loud ------------------------
echo "declared locations ($mode -- marker $WORKSPACE_MARKER $( [ "$mode" = workspace ] && echo present || echo absent)):"
for loc in $DECLARED; do
  d="$(declared_dir "$loc")"; label="${d#$TOOLS/}"
  if [ -d "$d" ]; then
    ok "$label"
  elif [ "$mode" = workspace ]; then
    err "$label is DECLARED but absent -- its copies of the twinned hooks are gone, and nothing else would say so"
  else
    printf '  UNCHECKED  %s is declared but absent here (standalone run) -- its copies are not compared\n' "$label"
    unchecked=$((unchecked + 1))
  fi
done
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
# The other direction of DECLARED: a copy found but not listed would vanish
# silently later, because only listed locations are missed when absent.
for d in $locations; do
  [ "$d" = "$REPO/.claude/hooks" ] && continue
  if [ "$d" = "$TOOLS/.claude/hooks" ]; then loc=.; else loc="${d#$TOOLS/}"; loc="${loc%/.claude/hooks}"; fi
  printf '%s\n' $DECLARED | grep -qxF "$loc" && continue
  holds=""
  for name in $twinned; do [ -f "$d/$name" ] && holds="$holds $name"; done
  [ -n "$holds" ] || continue
  msg="${d#$TOOLS/} holds twinned hooks ($holds ) but is not in DECLARED (check-hooks.sh) -- if it were deleted, nothing would report it"
  if [ "$mode" = workspace ]; then err "$msg"; else note "$msg"; fi
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

# --- 4. Each copy ENFORCES from where it is installed --------------------------
# Logic-identical copies can still behave differently, because each resolves
# site-scrapers from its OWN location. data-bridge's copy of prefer-recipes.sh
# took data-bridge for site-scrapers (it has dev.sh and engine.js too), found no
# recipes and allowed everything -- identical bytes, clean check, no
# enforcement. So every copy is RUN on a host this repo has a working recipe
# for and must refuse it. The override marker is pointed at a path that cannot
# exist, so an open `./dev.sh browser-ok` window cannot make this pass or fail.
echo "each prefer-recipes.sh copy blocks a covered host from where it is installed:"
NODE_BIN="$HOME/.nvm/versions/node/v22.20.0/bin/node"
[ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node 2>/dev/null || true)"
covered=""
if [ -f "$REPO/query.js" ] && [ -n "$NODE_BIN" ]; then
  covered=$(cd "$REPO" && "$NODE_BIN" query.js sites 2>/dev/null \
    | jq -r 'map(select(.status == "working")) | .[0].hostname // empty' 2>/dev/null)
fi
if [ -z "$covered" ]; then
  printf '  UNCHECKED  enforcement not probed -- no working recipe here to probe with\n'
  unprobed=1
else
  unprobed=0
  for d in $locations; do
    [ -f "$d/prefer-recipes.sh" ] || continue
    rc=0
    printf '{"tool_name":"WebFetch","tool_input":{"url":"https://%s/"}}' "$covered" \
      | SS_BROWSER_OK=/nonexistent/ss-browser-ok bash "$d/prefer-recipes.sh" >/dev/null 2>&1 || rc=$?
    if [ "$rc" = 2 ]; then ok "${d#$TOOLS/}/prefer-recipes.sh blocks $covered"
    else err "${d#$TOOLS/}/prefer-recipes.sh does NOT enforce from there: exit $rc on $covered, which has a working recipe (it resolved some other folder as site-scrapers, or none)"; fi
  done
fi
echo

# The last line is what `./dev.sh check` shows on success, so an UNCHECKED
# location must be counted HERE or a standalone run would read as full coverage.
if [ "$errors" = 0 ]; then
  line="hooks: clean"
  [ "$notes" = 0 ] || line="$line, $notes note$( [ "$notes" = 1 ] || echo s)"
  [ "$unchecked" = 0 ] || line="$line, $unchecked declared location$( [ "$unchecked" = 1 ] || echo s) UNCHECKED (absent; standalone run)"
  [ "$unprobed" = 0 ] || line="$line, enforcement UNCHECKED (no working recipe to probe with)"
  echo "$line"
  exit 0
fi
echo "hooks: $errors ERROR$( [ "$errors" = 1 ] || echo S)"
exit 1
