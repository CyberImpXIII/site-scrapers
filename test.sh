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

if [ "$verbose" = true ]; then
  exec "$NODE_BIN" --test "${files[@]}"
fi

# Keep: every `not ok` and the YAML diagnostic block under it, plus the counts.
# Drop: the `ok` lines and their blocks, which is the bulk of the stream.
"$NODE_BIN" --test "${files[@]}" 2>&1 | awk '
  /^[[:space:]]*not ok / { infail = 1; print; next }
  infail && /^[[:space:]]*\.\.\.[[:space:]]*$/ { infail = 0; print; next }
  infail { print; next }
  /^# (tests|pass|fail) / { print; next }
  /^# (cancelled|skipped|todo) / { if ($3 != "0") print; next }
'
exit "${PIPESTATUS[0]}"
