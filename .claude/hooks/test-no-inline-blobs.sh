#!/usr/bin/env bash
# Tests for no-inline-blobs.sh. Run: bash .claude/hooks/test-no-inline-blobs.sh
#
# This file exists because the hook blocked the attempt to test it inline: the
# test command necessarily CONTAINS the strings being blocked, so the hook saw
# its own bait. Which is the rule working as intended -- the cases belong in a
# file, and the file gets run.
#
# Every case is a command the hook will be shown. A false positive here is worse
# than a miss: a hook that blocks ordinary work gets disabled, and then it
# protects nothing.

set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$DIR/no-inline-blobs.sh"
fails=0

check() {
  local want="$1" desc="$2" cmd="$3"
  printf '{"tool_input":{"command":%s}}' "$(printf '%s' "$cmd" | jq -Rs .)" | bash "$HOOK" >/dev/null 2>&1
  local got=$?
  if [ "$got" = "$want" ]; then
    printf '  ok    %-28s (exit %s)\n' "$desc" "$got"
  else
    printf '  FAIL  %-28s expected exit %s, got %s\n' "$desc" "$want" "$got"
    fails=$((fails + 1))
  fi
}

echo "must BLOCK (exit 2):"
check 2 "node -e"             'node -e "console.log(1)"'
check 2 "nodejs -e"           'nodejs -e "x"'
check 2 "python3 -c"          'python3 -c "print(1)"'
check 2 "python -c"           'python -c "print(1)"'
check 2 "perl -e"             'perl -e "print 1"'
# The form actually used in this folder. A word-boundary-only pattern let this
# straight through, which would have made the hook decorative.
check 2 "interpreter by path" '~/.nvm/versions/node/v22.20.0/bin/node -e "x"'
check 2 "absolute path"       '/usr/bin/python3 -c "print(1)"'
check 2 "after &&"            'cd site-scrapers && node -e "x"'
check 2 "after ;"             'ls; node -e "x"'
check 2 "heredoc to node"     'node <<EOF
console.log(1)
EOF'
check 2 "heredoc to python"   'python3 - <<PY
print(1)
PY'

echo "must ALLOW (exit 0):"
check 0 "running a script"    'node lab.js peek nodesk.co'
check 0 "script by path"      '~/.nvm/versions/node/v22.20.0/bin/node audit.js units'
check 0 "node --test"         'node --test test/probes.test.js'
check 0 "python script"       'python3 emailTools/count_unread_senders.py'
check 0 "dev.sh"              './site-scrapers/dev.sh check'
check 0 "short jq"            'node query.js sites | jq -r ".[].hostname"'
check 0 "data heredoc"        'cat > recipe.json <<EOF
{"a":1}
EOF'
check 0 "git"                 'git add -A && git commit -F msg.txt'
check 0 "grep -e"             'grep -e foo file.txt'
check 0 "sed -e"              'sed -e "s/a/b/" file.txt'
check 0 "empty input"         ''

echo
if [ "$fails" = 0 ]; then echo "all cases passed"; else echo "$fails FAILED"; exit 1; fi
