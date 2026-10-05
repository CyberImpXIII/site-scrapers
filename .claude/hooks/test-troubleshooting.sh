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

# 20000 lines (~300KB) of harmless filler for the long-command cases: more than
# a pipe buffer holds (64KB), or printf finishes before grep exits.
FILLER="$(printf '\n: filler %s' $(seq 1 20000))"
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
if [ -z "$sites" ] && [ "$REPO" != /nonexistent ]; then
  echo "  FAIL  query.js sites returned NOTHING from $REPO -- the hook cannot read recipes either"
  fails=$((fails + 1))
fi
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
  # A long command: under pipefail, `printf | grep -q` read a MATCH on a large
  # input as no match (grep exits early, printf takes SIGPIPE, status 141), so
  # the run below went through. Found 2026-10-04 in no-inline-blobs.sh.
  check 2 "blocked run early in a long command"   "./scrape.sh $attn '{}'$FILLER"
else
  skip "blocked-attn cases" "no blocked-attn recipe in this DB"
fi

echo "must ALLOW (exit 0):"
if [ -n "$attn" ]; then
  # The sanctioned next step for this state. Blocking it would leave the recipe
  # permanently stuck, since nothing else can move it.
  check 0 "verify.js --attended is the way OUT"   "node verify.js $attn '{}' --attended"
  check 0 "--attended early in a long command"    "node verify.js $attn '{}' --attended$FILLER"
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

# The block message's statement of the CLI's rule. Fixture-free, so it runs in
# a lone clone too: a copy of the hook in a scratch tree beside a stand-in
# site-scrapers whose `dev.sh known` reports one recipe as blocked-attn. The
# message once said engine.js refuses "only when allowUnverified is absent";
# since site-scrapers c6e4243 (blocked-guard) the CLI refuses a blocked-attn
# recipe unless the run is attended, whatever allowUnverified says. A message
# that tells an agent the wrong way through is a wrong answer, so its wording
# is pinned here: the old sentence fails the first check below.
echo "the block message states the CLI's rule (stand-in site-scrapers):"
SCRATCH="$(mktemp -d)" || SCRATCH=""
if [ -z "$SCRATCH" ]; then
  echo "  FAIL  mktemp -d failed: the message cases did not run"
  fails=$((fails + 1))
else
  trap 'rm -rf "$SCRATCH"' EXIT
  mkdir -p "$SCRATCH/site-scrapers" "$SCRATCH/.claude/hooks"
  printf '{ "name": "site-scrapers" }\n' > "$SCRATCH/site-scrapers/package.json"
  printf 'attn-fixture.example#listing:default\tblocked-attn\n' > "$SCRATCH/site-scrapers/known.tsv"
  printf '%s\n' '#!/usr/bin/env bash' \
    '[ "$1" = known ] && cat "$(dirname "$0")/known.tsv"' 'exit 0' > "$SCRATCH/site-scrapers/dev.sh"
  chmod +x "$SCRATCH/site-scrapers/dev.sh"
  cp "$HOOK" "$SCRATCH/.claude/hooks/troubleshooting.sh"
  stand_in() {  # $1 command; prints "<exit>\t<stderr on one line>"
    local err got
    err=$(printf '{"tool_name":"Bash","tool_input":{"command":%s}}' "$(printf '%s' "$1" | jq -Rs .)" \
      | bash "$SCRATCH/.claude/hooks/troubleshooting.sh" 2>&1 >/dev/null)
    got=$?
    printf '%s\t%s' "$got" "$(printf '%s' "$err" | tr '\n' ' ')"
  }
  msg_check() {  # $1 desc, $2 want present (1) or absent (0), $3 fixed phrase, $4 output
    local present=0
    grep -qF -- "$3" <<< "$4" && present=1
    if [ "$present" = "$2" ]; then
      printf '  ok    %-40s\n' "$1"
    else
      printf '  FAIL  %-40s %s: "%s"\n' "$1" "$([ "$2" = 1 ] && echo missing || echo still present)" "$3"
      fails=$((fails + 1))
    fi
  }
  out=$(stand_in "./scrape.sh attn-fixture.example '{}'")
  if [ "${out%%$'\t'*}" != 2 ]; then
    echo "  FAIL  stand-in blocked-attn run                 expected exit 2, got ${out%%$'\t'*}"
    fails=$((fails + 1))
  else
    printf '  ok    %-40s (exit 2)\n' "stand-in blocked-attn run"
  fi
  msg_check "says the CLI refuses unless --attended"   1 "refuses a blocked-attn recipe unless --attended is given" "$out"
  msg_check "says allowUnverified does not open it"   1 "allowUnverified does not open it" "$out"
  msg_check "drops the old allowUnverified claim"     0 "only when allowUnverified is absent" "$out"
  out=$(stand_in "./scrape.sh attn-fixture.example '{}' --attended")
  if [ "$out" != "0"$'\t' ]; then
    echo "  FAIL  stand-in --attended run                   expected exit 0 and silence, got: $out"
    fails=$((fails + 1))
  else
    printf '  ok    %-40s (exit 0, silent)\n' "stand-in --attended run"
  fi
fi

echo
[ "$skips" = 0 ] || echo "$skips skipped (fixtures absent, not failures)"
if [ "$fails" != 0 ]; then echo "$fails FAILED"; exit 1; fi
if [ -n "$unchecked" ]; then echo "UNCHECKED: $unchecked"; exit 3; fi
echo "all cases passed"
