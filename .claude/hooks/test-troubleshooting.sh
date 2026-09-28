#!/usr/bin/env bash
# Tests for troubleshooting.sh. Run: bash .claude/hooks/test-troubleshooting.sh
#
# The ALLOW cases are the important half: this hook sees EVERY Bash command, so
# a false positive would block ordinary work and the hook would be switched off.
#
# Fixtures come from the live recipe DB, because recipes are not committed and a
# fresh clone has none. A case whose fixture is missing SKIPS loudly rather than
# passing -- a test that passes because its fixture is absent proves nothing.
#
# One case here earns its place by having caught a real bug: `lab.js`, `engine.js`
# and `scrape.sh` all match a hostname shape and appear BEFORE the target in the
# command, so the first version looked up a host called "lab.js", found nothing,
# and allowed a retry of a blocked-attn recipe. The guard did nothing and said
# nothing, which is the worst way for one to fail.

set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$DIR/troubleshooting.sh"
REPO="$(cd "$DIR/../.." && pwd)"
[ -f "$REPO/dev.sh" ] || REPO="$REPO/site-scrapers"
fails=0
skips=0

check() {
  local want="$1" desc="$2" cmd="$3"
  printf '{"tool_name":"Bash","tool_input":{"command":%s}}' "$(printf '%s' "$cmd" | jq -Rs .)" \
    | bash "$HOOK" >/dev/null 2>&1
  local got=$?
  if [ "$got" = "$want" ]; then
    printf '  ok    %-40s (exit %s)\n' "$desc" "$got"
  else
    printf '  FAIL  %-40s expected exit %s, got %s\n' "$desc" "$want" "$got"
    fails=$((fails + 1))
  fi
}
skip() { printf '  SKIP  %-40s %s\n' "$1" "$2"; skips=$((skips + 1)); }

NODE_BIN="$HOME/.nvm/versions/node/v22.20.0/bin/node"
sites=$(cd "$REPO" && "$NODE_BIN" query.js sites 2>/dev/null)
pick() { printf '%s' "$sites" | jq -r "$1" 2>/dev/null; }
attn=$(pick 'map(select(.status == "blocked-attn")) | .[0].hostname // empty')
working=$(pick 'map(select(.status == "working")) | .[0].hostname // empty')

echo "must BLOCK (exit 2) — retrying what already needs a person:"
if [ -n "$attn" ]; then
  check 2 "lab.js peek on a blocked-attn recipe"  "node lab.js peek $attn '{\"keyword\":\"x\"}'"
  check 2 "scrape.sh on a blocked-attn recipe"    "./scrape.sh $attn '{}'"
  check 2 "verify.js without --attended"          "node verify.js $attn '{}'"
  check 2 "engine.js directly"                    "node engine.js $attn '{\"allowUnverified\":true}'"
  check 2 "qualified target"                      "node lab.js peek $attn#listing '{}'"
else
  skip "blocked-attn cases" "no blocked-attn recipe in this DB"
fi

echo "must ALLOW (exit 0):"
if [ -n "$attn" ]; then
  # The sanctioned next step for this state. Blocking it would leave the recipe
  # permanently stuck, since nothing else can move it.
  check 0 "verify.js --attended is the way OUT"   "node verify.js $attn '{}' --attended"
  # Reading about it must never be blocked.
  check 0 "query.js site on the same recipe"      "node query.js site $attn"
  check 0 "dev.sh blocked"                        './dev.sh blocked'
else
  skip "blocked-attn allow cases" "no blocked-attn recipe in this DB"
fi
if [ -n "$working" ]; then
  check 0 "running a working recipe"              "./scrape.sh $working '{}'"
fi
check 0 "an unrelated command"                    'git status --short'
check 0 "the test suite"                          './test.sh'
check 0 "a command with no target at all"         'node query.js sites'
check 0 "an unregistered host"                    "node lab.js peek example.invalid '{}'"
check 0 "empty command"                           ''

echo
[ "$skips" = 0 ] || echo "$skips skipped (fixtures absent, not failures)"
if [ "$fails" = 0 ]; then echo "all cases passed"; else echo "$fails FAILED"; exit 1; fi
