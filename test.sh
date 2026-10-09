#!/usr/bin/env bash
# Runs the suite. Wrapper so callers don't need to remember the Node 22 nvm path
# (the system default `node` in PATH is v16, too old for node:sqlite).
#
#   ./test.sh                      # quiet: failures in full, then the summary
#   ./test.sh --verbose            # the whole TAP stream
#   ./test.sh test/probes.test.js  # just these files (quiet unless --verbose)
#
# QUIET BY DEFAULT because the output is read far more often by a model than by
# a person, and 279 lines of "ok 143 - ..." is 279 lines of nothing happening.
# A passing run should cost almost nothing to read; a failing one should cost
# whatever it takes. So failures print in full -- the `not ok` line AND the YAML
# block under it with the assertion, the diff and the file:line -- and passes
# collapse to the three-line summary.
#
# The summary lines are kept verbatim rather than prettied up, because
# lib/gate.js parses this output (`# pass N`, `# fail N`, `not ok N - name`) to
# decide whether a gated change broke the suite. If a filter here dropped one of
# those, the gate would read "0 failed" and wave a broken change through --
# silently, which is the worst way for a guard to fail. test/hooks.test.js
# asserts that round trip, on a run that really fails.

set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="$HOME/.nvm/versions/node/v22.20.0/bin/node"

# Node's test runner sets NODE_TEST_CONTEXT=child-v8 for processes it spawns,
# and a runner that sees it switches from TAP to a V8-serialized reporter. So
# test.sh invoked from INSIDE a test run emitted no TAP at all: no `# pass`, no
# `not ok`, nothing for the filter below or for lib/gate.js's parser to read --
# which parses as "0 passed, 0 failed", i.e. a silent all-clear from a run that
# never reported. Cleared here rather than at each call site so every caller
# gets deterministic TAP, including gate paths that may one day run under test.
unset NODE_TEST_CONTEXT

verbose=false
files=()
for a in "$@"; do
  case "$a" in
    --verbose|--tap) verbose=true ;;
    *) files+=("$a") ;;
  esac
done
[ ${#files[@]} -gt 0 ] || files=("$DIR"/test/*.test.js)

# THE SUITE RUNS ON COPIES OF THE STORES, never the live files (TODO 0k: tests
# left 127.0.0.1 fixtures in the live recipe store). devtools/snapshot-stores.js
# copies whatever this process is pointed at -- the live stores, or the
# caller's copies when test.sh runs inside a suite (lib/gate.js) -- and SS_DB /
# SS_FAILURES_DB send every test and every child it spawns there (db.js and
# failuresDb.js read them at load). A store that does not exist yet is not
# copied; openDb creates a fresh one at the override path.
#
# Then the live stores are fingerprinted before and after
# (devtools/db-fingerprint.js) and any difference fails the run: a path that
# still opens the live file shows up here instead of as a stray fixture weeks
# later. Another session writing the live store during the run also differs;
# the message says so. test/db-isolation.test.js asserts this wiring.
tmp="$(mktemp -d "${TMPDIR:-/tmp}/ss-suite-XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
if ! "$NODE_BIN" --no-warnings "$DIR/devtools/snapshot-stores.js" "$tmp" >/dev/null; then
  echo "not ok 0 - could not snapshot the stores (devtools/snapshot-stores.js); refusing to run the suite against the live ones"
  echo "# fail 1"
  exit 1
fi
export SS_DB="$tmp/recipes.sqlite"
export SS_FAILURES_DB="$tmp/failures.sqlite"
"$NODE_BIN" --no-warnings "$DIR/devtools/db-fingerprint.js" > "$tmp/live-before.json" 2>/dev/null

if [ "$verbose" = true ]; then
  "$NODE_BIN" --test "${files[@]}"
  rc=$?
else
  # Keep: every `not ok` and the YAML diagnostic block under it, plus the counts.
  # Drop: the `ok` lines and their blocks, which is the bulk of the stream.
  "$NODE_BIN" --test "${files[@]}" 2>&1 | awk '
    /^[[:space:]]*not ok / { infail = 1; print; next }
    infail && /^[[:space:]]*\.\.\.[[:space:]]*$/ { infail = 0; print; next }
    infail { print; next }
    /^# (tests|pass|fail) / { print; next }
    /^# (cancelled|skipped|todo) / { if ($3 != "0") print; next }
  '
  rc="${PIPESTATUS[0]}"
fi

"$NODE_BIN" --no-warnings "$DIR/devtools/db-fingerprint.js" > "$tmp/live-after.json" 2>/dev/null
if ! changed="$("$NODE_BIN" --no-warnings "$DIR/devtools/db-fingerprint.js" --diff "$tmp/live-before.json" "$tmp/live-after.json" 2>&1)"; then
  # A top-level `not ok` line: lib/gate.js's parseTap counts it as a failure.
  echo "not ok 0 - the LIVE store changed during the suite (devtools/db-fingerprint.js; rerun if another session was writing it)"
  printf '%s\n' "$changed" | sed 's/^/  # /'
  [ "$rc" -ne 0 ] || rc=1
fi
exit "$rc"
