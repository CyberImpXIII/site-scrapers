#!/usr/bin/env bash
# Tests for prefer-recipes.sh. Run: bash .claude/hooks/test-prefer-recipes.sh
#
# A false positive here is worse than a miss: a hook that blocks legitimate
# browsing gets switched off, and then it protects nothing. So the ALLOW cases
# below are the important half.
#
# The fixtures come from the live recipe DB rather than being hardcoded, because
# recipes are not committed -- a fresh clone has none. A case whose fixture is
# missing SKIPS loudly instead of passing, since a test that passes because its
# fixture is absent is the failure mode docs/lessons.md records under "tests
# that pass for the wrong reason".

set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$DIR/prefer-recipes.sh"
REPO="$(cd "$DIR/../.." && pwd)"
[ -f "$REPO/dev.sh" ] || REPO="$REPO/site-scrapers"
fails=0
skips=0

check() {
  local want="$1" desc="$2" tool="$3" url="$4"
  printf '{"tool_name":%s,"tool_input":{"url":%s}}' \
    "$(printf '%s' "$tool" | jq -Rs .)" "$(printf '%s' "$url" | jq -Rs .)" \
    | bash "$HOOK" >/dev/null 2>&1
  local got=$?
  if [ "$got" = "$want" ]; then
    printf '  ok    %-34s (exit %s)\n' "$desc" "$got"
  else
    printf '  FAIL  %-34s expected exit %s, got %s\n' "$desc" "$want" "$got"
    fails=$((fails + 1))
  fi
}
skip() { printf '  SKIP  %-34s %s\n' "$1" "$2"; skips=$((skips + 1)); }

# A hostname whose recipe is `working`, and one that is registered but NOT
# working -- the two sides of the only decision this hook makes. Read through
# the documented CLI so this test needs no knowledge of the schema.
NODE_BIN="$HOME/.nvm/versions/node/v22.20.0/bin/node"
sites=$(cd "$REPO" && "$NODE_BIN" query.js sites 2>/dev/null)
pick() { printf '%s' "$sites" | jq -r "$1" 2>/dev/null; }
covered=$(pick 'map(select(.status == "working")) | .[0].hostname // empty')
# Excludes the lab prober, which is internal scaffolding rather than a site.
notworking=$(pick 'map(select(.status != "working" and (.hostname | test("internal$") | not))) | .[0].hostname // empty')

echo "must BLOCK (exit 2) — a working recipe already covers the site:"
if [ -n "$covered" ]; then
  check 2 "WebFetch on a covered host"   'WebFetch'                              "https://$covered/search?q=x"
  check 2 "navigate on a covered host"   'mcp__claude-in-chrome__navigate'       "https://www.$covered/jobs"
  check 2 "tabs_create on a covered host" 'mcp__claude-in-chrome__tabs_create_mcp' "http://$covered/"
else
  skip "covered-host cases" "no working recipe in this DB"
fi

echo "must ALLOW (exit 0):"
# A recipe on a SUBDOMAIN must not block its parent. jobs.lever.co having a
# recipe made this refuse lever.co/about -- Lever's marketing site, nothing to
# do with the job board. A false positive in a blocking hook is worse than a
# miss, because it gets the hook switched off.
sub=$(pick 'map(select(.status == "working" and (.hostname | contains(".") and (split(".") | length) > 2))) | .[0].hostname // empty')
if [ -n "$sub" ]; then
  parent="${sub#*.}"
  # Only meaningful if the parent has no recipe of its own.
  if [ -z "$("$REPO/dev.sh" known "$parent" 2>/dev/null | awk -F'\t' -v p="$parent" '$1 ~ "^" p "#"')" ]; then
    check 0 "a subdomain's recipe does not cover its parent" 'WebFetch' "https://$parent/about"
  else
    skip "subdomain/parent case" "$parent has its own recipe"
  fi
else
  skip "subdomain/parent case" "no multi-label working hostname in this DB"
fi
check 0 "unknown host"                 'WebFetch'                        'https://example.invalid/page'
check 0 "not an http url"              'WebFetch'                        'about:blank'
check 0 "no url at all"                'WebFetch'                        ''
check 0 "a tool that fetches nothing"  'mcp__claude-in-chrome__read_page' 'https://anything/'
check 0 "an unrelated tool"            'Read'                            'https://anything/'
if [ -n "$notworking" ]; then
  # The case that matters most: a recipe that is blocked, broken or
  # needs-review is exactly when the browser IS the right tool. Blocking here
  # would strand the only path left.
  check 0 "registered but not working"   'WebFetch' "https://$notworking/jobs"
else
  skip "not-working host case" "every recipe in this DB is working"
fi

echo "the override window:"
if [ -n "$covered" ]; then
  ( cd "$REPO" && ./dev.sh browser-ok 15 >/dev/null 2>&1 )
  check 0 "allowed while browser-ok is fresh" 'WebFetch' "https://$covered/x"
  rm -f "$REPO/data/.browser-ok"
  check 2 "blocks again once removed"         'WebFetch' "https://$covered/x"
  # An expired marker must not keep the door open. Epoch 0 is long past.
  printf '0\n1\n' > "$REPO/data/.browser-ok"
  check 2 "an expired marker does not count"  'WebFetch' "https://$covered/x"
  rm -f "$REPO/data/.browser-ok"
else
  skip "override cases" "no working recipe in this DB"
fi

echo
[ "$skips" = 0 ] || echo "$skips skipped (fixtures absent, not failures)"
if [ "$fails" = 0 ]; then echo "all cases passed"; else echo "$fails FAILED"; exit 1; fi
