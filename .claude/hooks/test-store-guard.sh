#!/usr/bin/env bash
# Tests for store-guard.sh. Run: bash .claude/hooks/test-store-guard.sh
#
# A write to a store a cli.json names is blocked (exit 2) by the Write tools
# and by a visible Bash write (redirect, tee, sed -i, cp/mv onto, rm, a
# sqlite3 write), and the message names the CLI and its verbs. The CLI's own
# call, a read, another file in the same repo, a repo with no cli.json and a
# cli.json that does not parse all pass. Bash is read through
# ../lib/write-targets.sh; with that lib absent the Write tools are still
# held and Bash passes (fails open). Plus fail-open on malformed input and no
# jq. Every block case has a pass case beside it, so the suite cannot pass by
# blocking everything, and the mutant runs recorded in tools/hooks' TODO.md
# show each block case red with the check removed.

set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$DIR/store-guard.sh"
fails=0
T=$(mktemp -d "${TMPDIR:-/tmp}/store-guard-test.XXXXXX") || exit 1
trap 'rm -rf "$T"' EXIT
T=$(cd "$T" && pwd -P)
R=$T/repo                   # a repo whose cli.json names three stores
mkdir -p "$R/data" "$R/state" "$T/top/.claude" "$T/plain/data" "$T/broken/data" "$T/elsewhere"
printf '{"store": ["data/s.json", "./data/s.db", "state/*"], "cli": "store.sh", "verbs": ["add", "export"]}\n' > "$R/cli.json"
printf '#!/bin/sh\nexit 0\n' > "$R/store.sh"; chmod +x "$R/store.sh"
printf '{}\n' > "$R/data/s.json"
printf '{"store": "m.json", "cli": "./m.sh", "verbs": []}\n' > "$T/top/.claude/cli.json"   # string form, in .claude/
printf 'not json\n' > "$T/broken/cli.json"

pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; shift; for l in "$@"; do printf '        %s\n' "$l"; done; fails=$((fails + 1)); }

# input <tool> <path-or-command> [cwd]
input() {
  local key=file_path
  case "$1" in Bash) key=command ;; NotebookEdit) key=notebook_path ;; esac
  jq -nc --arg tool "$1" --arg k "$key" --arg v "$2" --arg cwd "${3:-$R}" \
    '{hook_event_name:"PreToolUse",session_id:"s",cwd:$cwd,tool_name:$tool,tool_input:{($k):$v}}'
}

# want <exit> <desc> <tool> <path-or-command> [cwd] [hook] [message the block must name]
want() {
  local code err
  err=$(input "$3" "$4" "${5:-$R}" | bash "${6:-$HOOK}" 2>&1 >/dev/null); code=$?
  if [ "$code" != "$1" ]; then fail "$2" "want exit $1, got $code: ${err:0:300}"; return; fi
  if [ "$1" = 2 ]; then
    local need=${7:-"\`$R/store.sh\` (verbs: add export)"}
    if ! printf '%s' "$err" | grep -qF -- "$need"; then
      fail "$2" "blocked without naming $need: ${err:0:300}"; return
    fi
  elif [ -n "$err" ]; then fail "$2" "passed but printed: ${err:0:300}"; return
  fi
  pass "$2"
}

echo "blocked (exit 2), the Write tools:"
want 2 "Write"                           Write        "$R/data/s.json"
want 2 "Edit"                            Edit         "$R/data/s.json"
want 2 "MultiEdit"                       MultiEdit    "$R/data/s.json"
want 2 "NotebookEdit"                    NotebookEdit "$R/data/s.json"
want 2 "a relative path, against cwd"    Edit         "data/s.json"
want 2 "a .. in the path"                Edit         "$R/x/../data/s.json"
want 2 "a session started elsewhere"     Edit         "$R/data/s.json" "$T/elsewhere"
want 2 "a store named ./data/s.db"       Write        "$R/data/s.db"
want 2 "its SQLite side file (-wal)"     Write        "$R/data/s.db-wal"
want 2 "a glob store (state/*)"          Write        "$R/state/a.tsv"
want 2 "a string store in .claude/cli.json" Edit      "$T/top/.claude/m.json" "$T" "" "\`$T/top/.claude/m.sh\`"

echo "blocked (exit 2), visible Bash writes:"
want 2 "a redirect"                      Bash "echo x > data/s.json"
want 2 "an append"                       Bash "echo x >> data/s.json"
want 2 "sed -i"                          Bash "sed -i '' 's/a/b/' data/s.json"
want 2 "tee"                             Bash "printf x | tee data/s.json"
want 2 "cp onto it"                      Bash "cp /tmp/x data/s.json"
want 2 "rm"                              Bash "rm -f data/s.json"
want 2 "cd, then a redirect"             Bash "cd data && echo x > s.json"
want 2 "an absolute path from elsewhere" Bash "echo x > $R/data/s.json" "$T/elsewhere"
want 2 "a sqlite3 write"                 Bash "sqlite3 data/s.db 'DELETE FROM t'"
want 2 "a redirect into a glob store"    Bash "echo x > state/b.tsv"

echo "passes (exit 0):"
want 0 "the store's CLI"                 Bash "./store.sh add 'x > data/s.json'"
want 0 "the CLI by path, output elsewhere" Bash "$R/store.sh export > $T/elsewhere/out.json" "$T/elsewhere"
want 0 "a read"                          Bash "jq . data/s.json"
want 0 "a read copied elsewhere"         Bash "cp data/s.json /tmp/copy.json"
want 0 "sqlite3 -readonly"               Bash "sqlite3 -readonly data/s.db 'SELECT 1'"
want 0 "an unrelated file, same repo"    Write "$R/data/other.json"
want 0 "a file named like the store"     Write "$R/data/s.json.md"
want 0 "the cli.json itself"             Edit  "$R/cli.json"
want 0 "an unrelated Bash write"         Bash  "echo x > notes.txt"
want 0 "a repo with no cli.json"         Write "$T/plain/data/s.json" "$T/plain"
want 0 "no cli.json, Bash"               Bash  "echo x > data/s.json" "$T/plain"
want 0 "a cli.json that does not parse"  Write "$T/broken/data/s.json" "$T/broken"
want 0 "Read is not a write"             Read  "$R/data/s.json"

# ------------------------------------------------------------------------
# The same store under another name, or written another way (2026-10-09:
# a case variant, chflags, a run-time variable, git/patch/tar/ex, a symlink).
printf '{}\n' > "$R/data/other.json"
mkdir -p "$R/sub" "$T/p" "$T/stage/data" "$T/stage/top/data" "$T/stage2" "$T/okstage/data"
git -C "$R" init -q 2>/dev/null
printf 'diff --git a/data/s.json b/data/s.json\n--- a/data/s.json\n+++ b/data/s.json\n@@ -1 +1 @@\n-{}\n+{"x":1}\n' > "$T/p/fix.diff"
printf 'diff --git a/data/other.json b/data/other.json\n--- a/data/other.json\n+++ b/data/other.json\n@@ -1 +1 @@\n-{}\n+{"x":1}\n' > "$T/p/ok.diff"
printf '{}\n' > "$T/stage/data/s.json"; printf '{}\n' > "$T/stage/top/data/s.json"
printf '{}\n' > "$T/stage2/s.json"; printf '{}\n' > "$T/okstage/data/other.json"
tar -cf "$T/p/a.tar" -C "$T/stage" data/s.json
tar -cf "$T/p/b.tar" -C "$T/stage2" s.json
tar -cf "$T/p/c.tar" -C "$T/stage" top/data/s.json
tar -cf "$T/p/ok.tar" -C "$T/okstage" data/other.json
ln -s "$R/data/s.json" "$T/elsewhere/link"
ln -s ../repo/data/s.json "$T/elsewhere/rel"
ln -s "$R/data" "$T/elsewhere/d"
ln -s "$R/data/other.json" "$T/elsewhere/olink"
ln "$R/data/s.json" "$R/data/hard.json"
E=$T/elsewhere
FIX=$'git apply <<EOF\n--- a/data/s.json\n+++ b/data/s.json\n@@ -1 +1 @@\n-{}\n+{"x":1}\nEOF'
OKFIX=$'git apply <<EOF\n--- a/data/other.json\n+++ b/data/other.json\n@@ -1 +1 @@\n-{}\n+{"x":1}\nEOF'

echo "blocked (exit 2), the store under another name:"
if [ -e "$R/data/S.JSON" ]; then   # a case-insensitive file system (APFS, HFS+)
  want 2 "Edit, a case variant"          Edit  "$R/data/S.JSON"
  want 2 "Edit, a case variant dir"      Edit  "$R/DATA/s.json"
  want 2 "a redirect, a case variant"    Bash  "echo x > Data/S.Json"
  want 2 "a new file, case-variant glob" Write "$R/STATE/new.tsv"
  want 2 "a case-variant side file"      Write "$R/data/S.DB-wal"
else
  echo "  skip  case variants: this file system is case-sensitive, so data/S.JSON is another file"
fi
want 2 "a file symlink from outside"     Bash  "echo x > link" "$E"
want 2 "Write through that symlink"      Write "$E/link" "$E"
want 2 "a relative symlink"              Bash  "sed -i '' s/a/b/ rel" "$E"
want 2 "a directory symlink"             Bash  "echo x > d/s.json" "$E"
want 2 "a hard link in the same tree"    Write "$R/data/hard.json"

echo "blocked (exit 2), other ways in:"
want 2 "chflags nouchg"                  Bash  "chflags nouchg data/s.json"
want 2 "chflags nouappnd, -R"            Bash  "chflags -R nouappnd data/s.json"
want 2 "D=x; then \$D"                   Bash  'D=data; echo x > $D/s.json'
want 2 "the manifest case, sed -i"       Bash  'D=.claude; sed -i "" s/a/b/ $D/m.json' "$T/top"  "" "\`$T/top/.claude/m.sh\`"
want 2 "git checkout --"                 Bash  "git checkout -- data/s.json"
want 2 "git checkout <tree-ish> <path>"  Bash  "git checkout HEAD data/s.json"
want 2 "git checkout <path> alone"       Bash  "git checkout data/s.json"
want 2 "git restore"                     Bash  "git restore --source=HEAD data/s.json"
want 2 "git apply <file>"                Bash  "git apply $T/p/fix.diff"
want 2 "git apply from a subdir (git top)" Bash "git apply $T/p/fix.diff" "$R/sub"
want 2 "git apply, a heredoc"            Bash  "$FIX"
want 2 "patch -p1 < <file>"              Bash  "patch -p1 < $T/p/fix.diff"
want 2 "tar -xf"                         Bash  "tar -xf $T/p/a.tar"
want 2 "tar -xf -C <dir>"                Bash  "tar -xf $T/p/b.tar -C data"
want 2 "tar --strip-components=1"        Bash  "tar --strip-components=1 -xf $T/p/c.tar"
want 2 "ex -sc"                          Bash  "ex -sc 'w!' data/s.json"
want 2 "vim -es"                         Bash  "vim -es -c 'normal x' -c wq data/s.json"

echo "passes (exit 0), beside each of those:"
want 0 "a case variant of another file"  Edit  "$R/data/OTHER.json"
want 0 "a new file beside the glob dir"  Write "$R/STATEX/new.tsv"
want 0 "a symlink to another file"       Bash  "echo x > olink" "$E"
want 0 "a new file in a dir symlink"     Bash  "echo x > d/new.json" "$E"
want 0 "chflags on another file"         Bash  "chflags nouchg data/other.json"
want 0 "D=x names another dir"           Bash  'D=sub; echo x > $D/s.json'
want 0 "pinned gap: D=\$(..) is not followed" Bash 'D=$(pwd); echo x > $D/data/s.json'
want 0 "pinned gap: an unset \$S"        Bash  'echo x > "$S/data/s.json"'
want 0 "git checkout -- another file"    Bash  "git checkout -- data/other.json"
want 0 "git checkout <branch>"           Bash  "git checkout main"
want 0 "git restore --staged (index)"    Bash  "git restore --staged data/s.json"
want 0 "git apply, another file"         Bash  "git apply $T/p/ok.diff"
want 0 "git apply --check"               Bash  "git apply --check $T/p/fix.diff"
want 0 "git apply, a heredoc, another file" Bash "$OKFIX"
want 0 "patch, another file"             Bash  "patch -p1 < $T/p/ok.diff"
want 0 "tar -xf, other files"            Bash  "tar -xf $T/p/ok.tar"
want 0 "tar -tf (a listing)"             Bash  "tar -tf $T/p/a.tar"
want 0 "tar -xf, a missing archive"      Bash  "tar -xf $T/p/none.tar"
want 0 "ex on another file"              Bash  "ex -sc 'w!' data/other.json"
want 0 "vim -R (read-only)"              Bash  "vim -R data/s.json"

# The extra-stores list beside the hook (../lib/extra-stores.sh, the real
# one): K is a repo root (a CLAUDE.md) with no cli.json.
K=$T/krepo
mkdir -p "$K/.claude/state" "$K/data" "$K/docs" "$K/inner" "$T/norepo"
printf '# k\n' > "$K/CLAUDE.md"; printf '# inner\n' > "$K/inner/CLAUDE.md"
printf '{}\n' > "$K/todo.json"; printf '{}\n' > "$T/norepo/todo.json"; printf '{}\n' > "$K/docs/todo.json"
ln "$K/todo.json" "$K/hard-todo.json"; ln -s "$K/todo.json" "$E/todo-link"
TODO_CLI='`tools/todo/todo` (from the workspace top)'
echo "blocked (exit 2), a store the extra-stores list names:"
want 2 "Write todo.json at a repo root"  Write "$K/todo.json" "$K" "" "$TODO_CLI"
want 2 "a redirect into todo-history.json" Bash "echo x > todo-history.json" "$K" "" "$TODO_CLI"
want 2 "a nested repo's own todo.json"   Write "$K/inner/todo.json" "$K" "" "$TODO_CLI"
want 2 "a ledger (.claude/state/*.tsv)"  Write "$K/.claude/state/writes.tsv" "$K" "" "only the hooks that append it"
want 2 "an append to a .jsonl ledger"    Bash  "printf x >> .claude/state/agent-ledger.jsonl" "$K" "" "only the hooks and agents.sh"
want 2 "a sqlite3 write to data/failures.db" Bash "sqlite3 data/failures.db 'DELETE FROM f'" "$K" "" '`site-scrapers/failures.js`'
want 2 "a hard link to todo.json"        Write "$K/hard-todo.json" "$K" "" "$TODO_CLI"
want 2 "a symlink from outside to it"    Write "$E/todo-link" "$E" "" "$TODO_CLI"
if [ -e "$K/TODO.JSON" ]; then
  want 2 "a case variant (TODO.JSON)"    Edit  "$K/TODO.JSON" "$K" "" "$TODO_CLI"
  want 2 "a NEW file, case-variant name"  Write "$K/TODO-HISTORY.JSON" "$K" "" "$TODO_CLI"
  want 2 "a NEW ledger, case-variant dir" Write "$K/.Claude/STATE/new.TSV" "$K" "" "only the hooks that append it"
else
  echo "  skip  case variant: this file system is case-sensitive"
fi
echo "passes (exit 0), beside each of those:"
want 0 "todo.json with no repo above"    Write "$T/norepo/todo.json" "$T/norepo"
want 0 "todo.json below a repo root"     Write "$K/docs/todo.json" "$K"
want 0 "todo.json.bak at a repo root"    Write "$K/todo.json.bak" "$K"
want 0 "a state file that is no ledger"  Write "$K/.claude/state/session.json" "$K"
want 0 "data/failures.db read-only"      Bash  "sqlite3 -readonly data/failures.db 'SELECT 1'" "$K"
want 0 "reading todo.json"               Bash  "cat todo.json" "$K"
want 0 "the todo CLI"                    Bash  "tools/todo/todo add x" "$K"

echo "the extra-stores list, its entries read defensively (a lone copy, a planted list):"
X=$T/xl
mkdir -p "$X/hooks" "$X/lib" "$T/xr/sub"; printf '# x\n' > "$T/xr/CLAUDE.md"
cp "$HOOK" "$X/hooks/"; cp "$DIR/../lib/write-targets.sh" "$X/lib/"
printf '%s\t%s\t%s\n' "$T/xr/abs.json" w h '~/home.json' w h ../up.json w h sub/../dots.json w h \
  nofield.json w '' ok.json tools/x 'run x' > "$X/list.tsv"
printf 'extra_stores() { cat %q; }\n' "$X/list.tsv" > "$X/lib/extra-stores.sh"
XH=$X/hooks/store-guard.sh
want 2 "a well-formed entry blocks"      Write "$T/xr/ok.json" "$T/xr" "$XH" '`tools/x` (from the workspace top): run x'
want 0 "an absolute entry matches nothing" Write "$T/xr/abs.json" "$T/xr" "$XH"
want 0 "a ~ entry is skipped"            Write "$T/xr/~/home.json" "$T/xr" "$XH"
want 0 "a .. entry matches nothing"       Write "$T/up.json" "$T/xr" "$XH"
want 0 "a /../ entry matches nothing"     Write "$T/xr/dots.json" "$T/xr" "$XH"
want 0 "an entry missing a field is skipped" Write "$T/xr/nofield.json" "$T/xr" "$XH"
rm "$X/lib/extra-stores.sh"
want 0 "the list absent: its store passes" Write "$T/xr/ok.json" "$T/xr" "$XH"
want 2 "  while a cli.json store is still held" Write "$R/data/s.json" "$R" "$XH"

echo "the lib absent (a lone copy of the hook):"
mkdir -p "$T/lone/hooks" && cp "$HOOK" "$T/lone/hooks/"
want 2 "Write still blocked"             Write "$R/data/s.json" "$R" "$T/lone/hooks/store-guard.sh"
want 0 "Bash passes (fails open)"        Bash  "echo x > data/s.json" "$R" "$T/lone/hooks/store-guard.sh"
want 0 "a listed store passes (no list)" Write "$K/todo.json" "$K" "$T/lone/hooks/store-guard.sh"

echo "fails open (exit 0, no output):"
open() {
  local desc="$1" given="$2" path="${3:-$PATH}" out code
  out=$(printf '%s' "$given" | PATH="$path" "$BASH" "$HOOK" 2>&1); code=$?
  if [ "$code" = 0 ] && [ -z "$out" ]; then pass "$desc"
  else fail "$desc" "exit $code, output: ${out:0:200}"; fi
}
open "empty input"          ''
open "{}"                   '{}'
open "not json"             'not json'
open "truncated input"      "{\"tool_name\":\"Write\",\"cwd\":\"$R\",\"tool_input\":{\"file_path\":\"$R/data/s.json"
open "a non-string path"    '{"tool_name":"Write","tool_input":{"file_path":7}}'
mkdir -p "$T/nojq"; for b in cat tr date mkdir dirname; do p=$(command -v "$b") && ln -s "$p" "$T/nojq/$b"; done
open "no jq, a store write" "$(input Write "$R/data/s.json")" "$T/nojq"

echo
if [ "$fails" != 0 ]; then echo "$fails FAILED"; exit 1; fi
echo "all cases passed"
