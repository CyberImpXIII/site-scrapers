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
fails=0
skips=0
# site-scrapers is found by the SAME rule the hook uses: walking up, and
# identified by its package.json name. Two looser rules already failed here:
# "a folder with a dev.sh" took knowledge-base, and "dev.sh AND engine.js" took
# scriptingTools/data-bridge. Either way this queried a folder with no recipes,
# skipped every block case, and printed "all cases passed".
#
# So a resolution fault is a FAILURE, never a skip: not finding site-scrapers,
# or its query.js answering nothing at all. (An empty DB answers `[]`, which is
# a genuine absence of fixtures and still skips.)
is_ss() { [ -f "$1/dev.sh" ] && grep -qE '"name"[[:space:]]*:[[:space:]]*"site-scrapers"' "$1/package.json" 2>/dev/null; }
find_repo() {
  local d="$DIR"
  while [ "$d" != "/" ] && [ -n "$d" ]; do
    if is_ss "$d/site-scrapers"; then printf '%s\n' "$d/site-scrapers"; return 0; fi
    if is_ss "$d"; then printf '%s\n' "$d"; return 0; fi
    d="$(dirname "$d")"
  done
  return 1
}
# Not finding it at all is a different thing: a lone clone (this test run from
# tools/hooks/source with no workspace around it) has no recipes to test
# against. That is UNCHECKED, exit 3, said out loud: neither "all cases passed"
# nor a failure of the hook. The fixture-free cases below still run, and still
# fail the run if they fail. `hooks tests` treats UNCHECKED as red inside a
# workspace, where site-scrapers should be found.
unchecked=""
REPO="$(find_repo)" || REPO=""
if [ -z "$REPO" ]; then
  unchecked="site-scrapers not found above $DIR: the recipe cases did not run"
  echo "  UNCHECKED  $unchecked"
  REPO="/nonexistent"
else
  echo "recipes from: $REPO"
fi
# The override marker is PRIVATE to this run. The live one is shared: parallel
# runs raced over it (one wrote, another deleted, the first then failed), and
# every run deleted any real override the owner had opened.
SS_BROWSER_OK="$(mktemp "${TMPDIR:-/tmp}/ss-browser-ok.XXXXXX")" && rm -f "$SS_BROWSER_OK"
export SS_BROWSER_OK
trap 'rm -f "$SS_BROWSER_OK"' EXIT

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
    # Says whether the fixture still holds NOW, so a reader can tell the live
    # DB moving under the test from the hook being wrong. Still a failure.
    local host
    host=$(printf '%s' "$url" | sed -nE 's#^https?://(www\.)?([^/?#:]+).*#\2#p')
    if [ -n "$host" ] && [ "$REPO" != /nonexistent ]; then
      printf '        now: %s working of %s recipe(s) for %s in the live DB\n' \
        "$("$REPO/dev.sh" known "$host" 2>/dev/null | awk -F'\t' '$2 == "working"' | wc -l | tr -d ' ')" \
        "$("$REPO/dev.sh" known "$host" 2>/dev/null | wc -l | tr -d ' ')" "$host"
    fi
    fails=$((fails + 1))
  fi
}
skip() { printf '  SKIP  %-34s %s\n' "$1" "$2"; skips=$((skips + 1)); }

# A hostname whose recipe is `working`, and one that is registered but NOT
# working -- the two sides of the only decision this hook makes. Read through
# the documented CLI so this test needs no knowledge of the schema.
NODE_BIN="$HOME/.nvm/versions/node/v22.20.0/bin/node"
sites=$(cd "$REPO" && "$NODE_BIN" query.js sites 2>/dev/null)
if [ -z "$sites" ] && [ "$REPO" != /nonexistent ]; then
  echo "  FAIL  query.js sites returned NOTHING from $REPO -- the hook cannot read recipes either"
  fails=$((fails + 1))
fi
# Fixtures come only from STABLE hosts: a real domain, never test scaffolding.
# site-scrapers' own suite writes fixture recipes into the same live DB and
# deletes them when it ends, all on 127.0.0.1, a bare label, or a reserved name
# (.test .invalid .example .internal .localhost). The first `working` host
# sorts as 127.0.0.1, so this test used to pick a host whose working recipes
# could vanish between the `query.js sites` snapshot and the hook's own
# `dev.sh known` -- the hook then (correctly) allowed, and a block case FAILED
# (2026-10-03 in site-scrapers, 2026-10-05 in knowledge-base, never alone).
# The other way round too: a test flipping a fixture to `broken` made
# 127.0.0.1 look "registered but not working" while its other fixtures kept
# it covered. Not a clock race: the expired-marker case writes epoch 0.
# The filters are jq defs so the self-check below runs them on a planted list.
PICK_DEFS='
  def stable: (.hostname // "") as $h
    | ($h | contains("."))
      and ($h | test("^[0-9.]+$") | not)
      and ($h | test("[:\\[\\]]") | not)
      and ($h | test("(^|\\.)(test|invalid|example|internal|localhost|local)$"; "i") | not);
  def working_hosts: map(select(.status == "working") | .hostname);
  def covers($w; $h): $h == $w or ($h | endswith("." + $w));
'
# A working recipe on a stable host.
PICK_COVERED="$PICK_DEFS"' map(select(.status == "working" and stable)) | .[0].hostname // empty'
# A stable host with a non-working recipe and NO working recipe covering it
# (itself or a parent), or the hook would block it for that recipe instead.
PICK_NOTWORKING="$PICK_DEFS"' working_hosts as $w
  | map(select(.status != "working" and stable)
        | select(.hostname as $h | [$w[] | select(covers(.; $h))] | length == 0))
  | .[0].hostname // empty'
# A working recipe on a stable multi-label host (its parent is the ALLOW case).
PICK_SUB="$PICK_DEFS"' map(select(.status == "working" and stable and ((.hostname | split(".") | length) > 2))) | .[0].hostname // empty'
pick() { printf '%s' "$sites" | jq -r "$1" 2>/dev/null; }

# Self-check of the pickers on a planted list (fixture-free: runs in a lone
# clone too). Scaffolding first, as the live DB sorts it; each line is a host
# the old `.[0]` pick took and lost to the suite's churn.
planted='[
  {"hostname":"127.0.0.1","status":"working"},
  {"hostname":"127.0.0.1","status":"broken"},
  {"hostname":"x","status":"working"},
  {"hostname":"cycle.test","status":"needs-review"},
  {"hostname":"bandcamp-release.internal","status":"working"},
  {"hostname":"jobs.subdomain-cover.internal","status":"working"},
  {"hostname":"cli-test.invalid","status":"working"},
  {"hostname":"matchtest.example","status":"working"},
  {"hostname":"linkedin.com","status":"needs-review"},
  {"hostname":"linkedin.com","status":"working"},
  {"hostname":"careers.linkedin.com","status":"blocked"},
  {"hostname":"indeed.com","status":"blocked-attn"},
  {"hostname":"jobs.lever.co","status":"working"}
]'
selfcheck() {
  local desc="$1" filter="$2" want="$3" got
  got=$(printf '%s' "$planted" | jq -r "$filter" 2>&1)
  if [ "$got" = "$want" ]; then
    printf '  ok    %-34s (%s)\n' "$desc" "$got"
  else
    printf '  FAIL  %-34s expected %s, got %s\n' "$desc" "$want" "${got:-nothing}"
    fails=$((fails + 1))
  fi
}
echo "the fixture pickers skip test scaffolding (planted list):"
selfcheck "covered host is a real domain"   "$PICK_COVERED"    "linkedin.com"
selfcheck "not-working host has no cover"   "$PICK_NOTWORKING" "indeed.com"
selfcheck "subdomain host is a real domain" "$PICK_SUB"        "jobs.lever.co"

# The hook's host match, on planted `known` lines (fixture-free, so it runs in a
# lone clone too): a copy of the hook in a scratch tree beside a stand-in
# site-scrapers whose `dev.sh known` prints known.tsv whatever it is asked --
# the hook does the matching, which is what is under test. `known` prints the
# hostname AS STORED; db.js upsertSite stores what it is given, so `www.` and
# capitals can reach the hook. Compared raw, a recipe stored as www.<host> was
# listed and never blocked (the first two cases fail on the old awk).
echo "the host match (stand-in site-scrapers, planted recipes):"
SCRATCH="$(mktemp -d)" || SCRATCH=""
if [ -z "$SCRATCH" ]; then
  echo "  FAIL  mktemp -d failed: the host-match cases did not run"
  fails=$((fails + 1))
else
  trap 'rm -f "$SS_BROWSER_OK"; rm -rf "$SCRATCH"' EXIT
  mkdir -p "$SCRATCH/site-scrapers" "$SCRATCH/.claude/hooks"
  printf '{ "name": "site-scrapers" }\n' > "$SCRATCH/site-scrapers/package.json"
  printf '%s\t%s\n' \
    'www.stored-www.example#listing:default' working \
    'Stored-Caps.example#listing:default'    working \
    'jobs.parent-fixture.example#listing:default' working \
    'broken-fixture.example#listing:default' broken \
    > "$SCRATCH/site-scrapers/known.tsv"
  printf '%s\n' '#!/usr/bin/env bash' \
    '[ "$1" = known ] && cat "$(dirname "$0")/known.tsv"' 'exit 0' > "$SCRATCH/site-scrapers/dev.sh"
  chmod +x "$SCRATCH/site-scrapers/dev.sh"
  cp "$HOOK" "$SCRATCH/.claude/hooks/prefer-recipes.sh"
  standin() {  # $1 want, $2 desc, $3 url
    local got
    printf '{"tool_name":"WebFetch","tool_input":{"url":%s}}' "$(printf '%s' "$3" | jq -Rs .)" \
      | bash "$SCRATCH/.claude/hooks/prefer-recipes.sh" >/dev/null 2>&1
    got=$?
    if [ "$got" = "$1" ]; then
      printf '  ok    %-34s (exit %s)\n' "$2" "$got"
    else
      printf '  FAIL  %-34s expected exit %s, got %s\n' "$2" "$1" "$got"
      fails=$((fails + 1))
    fi
  }
  standin 2 "recipe stored with www., bare url"   'https://stored-www.example/jobs'
  standin 2 "recipe stored with capitals"         'https://stored-caps.example/jobs'
  standin 2 "recipe stored with www., www url"    'https://www.stored-www.example/jobs'
  standin 2 "subdomain of a www. recipe"          'https://jobs.stored-www.example/x'
  standin 0 "a subdomain's recipe, parent url"    'https://parent-fixture.example/about'
  standin 0 "registered but not working"          'https://broken-fixture.example/jobs'
  standin 0 "suffix that is not a subdomain"      'https://notstored-www.example/jobs'
fi

covered=$(pick "$PICK_COVERED")
notworking=$(pick "$PICK_NOTWORKING")
echo "fixtures: covered=${covered:-none} not-working=${notworking:-none}"

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
sub=$(pick "$PICK_SUB")
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
  # Through the real `dev.sh browser-ok`, so its write and the hook's read are
  # proven to agree on SS_BROWSER_OK.
  ( cd "$REPO" && ./dev.sh browser-ok 15 >/dev/null 2>&1 )
  check 0 "allowed while browser-ok is fresh" 'WebFetch' "https://$covered/x"
  rm -f "$SS_BROWSER_OK"
  check 2 "blocks again once removed"         'WebFetch' "https://$covered/x"
  # An expired marker must not keep the door open. Epoch 0 is long past.
  printf '0\n1\n' > "$SS_BROWSER_OK"
  check 2 "an expired marker does not count"  'WebFetch' "https://$covered/x"
  rm -f "$SS_BROWSER_OK"
else
  skip "override cases" "no working recipe in this DB"
fi

echo
[ "$skips" = 0 ] || echo "$skips skipped (fixtures absent, not failures)"
if [ "$fails" != 0 ]; then echo "$fails FAILED"; exit 1; fi
if [ -n "$unchecked" ]; then echo "UNCHECKED: $unchecked"; exit 3; fi
echo "all cases passed"
