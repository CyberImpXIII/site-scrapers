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
# The heredoc's OWN command decides, wherever it sits in the command.
check 2 "heredoc piped to python" "cat <<'EOF' | python3 -
print(1)
EOF"
check 2 "heredoc to sqlite3"  'sqlite3 data.db <<SQL
select 1;
SQL'
check 2 "any delimiter word"  'node <<X
console.log(1)
X'
check 2 "via env, by path"    '/usr/bin/env python3 <<EOF
print(1)
EOF'
check 2 "via sudo, after &&"  'cd x && sudo python3 <<EOF
print(1)
EOF'
check 2 "redirect before verb" '<<EOF node
console.log(1)
EOF'
check 2 "inside \$( )"        "x=\$(python3 <<'PY'
print(1)
PY
)"
check 2 "<<- with tab indent" "node <<-EOF
	console.log(1)
	EOF"
# A data heredoc ends at its delimiter: what follows is commands again.
check 2 "blob after a data heredoc" 'cat > notes.md <<EOF
text
EOF
python3 -c "print(1)"'
# Found 2026-10-04: under `set -o pipefail`, `printf | grep -q` on a LARGE
# command reads a match as no match (grep exits at the match, printf takes
# SIGPIPE, the pipeline returns 141), so a long enough command let a blob by.
long_tail=$(for i in $(seq 1 4000); do printf 'echo filler line %s with some width to it\n' "$i"; done)
check 2 "blob early in a long command" "node -e \"x\"
$long_tail"
check 2 "a<<b arithmetic swallows nothing" 'echo $((1<<2))
python3 -c "print(1)"'
# A heredoc fed to a SHELL is commands, so its body is read as commands.
check 2 "blob inside bash heredoc" "bash <<'SH'
python3 -c 'print(1)'
SH"
check 2 "interpreter heredoc nested in bash" "bash <<'OUTER'
node <<EOF
console.log(1)
EOF
OUTER"

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
# The two false positives that were reported (top-level TODO.md, 2026-10-02
# and 2026-10-03): an interpreter NAMED in a data heredoc's body is text, not
# a command.
check 0 "commit message via cat heredoc" "git commit -m \"\$(cat <<'EOF'
hooks: mention perl and python3 in the message
EOF
)\""
check 0 "many data heredocs + od -c" "cat >> PLAN-x.md <<'EOF'
run node lab.js peek x, then python3 tools/y.py
EOF
cat >> PLAN-x.md <<'EOF'
- sqlite3 is never typed; ruby and php are not used
EOF
grep -n node PLAN-x.md && printf '%s\\n' done && od -c PLAN-x.md | head -2"
check 0 "a blob QUOTED in a data body" "cat > HOWTO.md <<'EOF'
never type node -e \"x\" or python3 -c \"y\"
EOF"
check 0 "tee heredoc"         'tee notes.txt <<EOF
python3 x.py
EOF'
check 0 "interpreter runs a script beside a data heredoc" "cat > in.json <<'EOF'
{}
EOF
python3 tools/read.py in.json"
check 0 "script given a heredoc's text as an argument" "python3 tools/post.py \"\$(cat <<'EOF'
body
EOF
)\""
check 0 "<<< here-string to grep" "grep -c node <<< 'node lab.js'"
check 0 "git"                 'git add -A && git commit -F msg.txt'
check 0 "grep -e"             'grep -e foo file.txt'
check 0 "sed -e"              'sed -e "s/a/b/" file.txt'
check 0 "empty input"         ''

echo
if [ "$fails" = 0 ]; then echo "all cases passed"; else echo "$fails FAILED"; exit 1; fi
