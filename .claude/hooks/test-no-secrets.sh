#!/usr/bin/env bash
# Tests for no-secrets.sh. Run: bash .claude/hooks/test-no-secrets.sh
#
# Every credential-shaped value here is built at run time from parts, so this
# file never holds one (the hook under test would refuse to write it).
# Blocked: one value per shape kind; keyed literals (spaced and camelCase keys,
# quoted and bare, `=`, `:`, `:=`, `=>`), an app-password shape; through Write,
# Edit, every MultiEdit edit and NotebookEdit. The message names the line, the
# kind and the KEY, and never the value. Let through: references (env vars,
# ${VAR}, self.x), placeholders, identifiers, numbers, URLs, a key with no
# value, other tools. Plus fail-open on malformed input and no jq.
# tests/test_secret_shapes.py holds the shapes to tools/checks' list.

set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$DIR/no-secrets.sh"
fails=0
r() { local s="" i; for ((i = 0; i < $2; i++)); do s+=$1; done; printf '%s' "$s"; }

pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; shift; for l in "$@"; do printf '        %s\n' "$l"; done; fails=$((fails + 1)); }

# feed <tool> <text>: the hook's stderr in ERR, exit in CODE
feed() {
  local inp
  case "$1" in
    Write)        inp=$(jq -nc --arg t "$2" '{tool_name:"Write",tool_input:{file_path:"/r/f.py",content:$t}}') ;;
    Edit)         inp=$(jq -nc --arg t "$2" '{tool_name:"Edit",tool_input:{file_path:"/r/f.py",old_string:"a",new_string:$t}}') ;;
    MultiEdit)    inp=$(jq -nc --arg t "$2" '{tool_name:"MultiEdit",tool_input:{file_path:"/r/f.py",edits:[{old_string:"a",new_string:"x = 1"},{old_string:"b",new_string:$t}]}}') ;;
    NotebookEdit) inp=$(jq -nc --arg t "$2" '{tool_name:"NotebookEdit",tool_input:{notebook_path:"/r/n.ipynb",new_source:$t}}') ;;
    *)            inp=$(jq -nc --arg tool "$1" --arg t "$2" '{tool_name:$tool,tool_input:{command:$t,content:$t}}') ;;
  esac
  ERR=$(printf '%s' "$inp" | bash "$HOOK" 2>&1 >/dev/null); CODE=$?
}

# blocks <desc> <tool> <text> <secret value that must not be echoed> <text the message must hold>...
blocks() {
  local desc=$1 tool=$2 text=$3 value=$4 t; shift 4
  feed "$tool" "$text"
  if [ "$CODE" != 2 ]; then fail "$desc" "want exit 2, got $CODE: ${ERR:0:200}"; return; fi
  case "$ERR" in *"$value"*) fail "$desc" "the message echoes the value"; return ;; esac
  for t in "$@"; do case "$ERR" in *"$t"*) ;; *) fail "$desc" "message lacks [$t]: ${ERR:0:300}"; return ;; esac; done
  pass "$desc"
}
lets() {   # <desc> <tool> <text>
  feed "$2" "$3"
  if [ "$CODE" = 0 ] && [ -z "$ERR" ]; then pass "$1"; else fail "$1" "exit $CODE: ${ERR:0:200}"; fi
}

echo "blocked: a value shaped like a known credential (one per kind):"
V=("sk-""ant-$(r a 24)" "sk-$(r A1 17)" "gh""p_$(r b 36)" "github""_pat_$(r c 52)" "AK""IA$(r B 16)"
   "xo""xb-$(r 1 12)" "AI""za$(r d 35)" "123456789:AA$(r e 33)" "-----BEGIN ""OPENSSH PRIVATE"" KEY-----")
K=("Anthropic API key" "OpenAI API key" "GitHub token" "GitHub fine-grained token" "AWS access key id"
   "Slack token" "Google API key" "Telegram bot token" "private key block")
for ((k = 0; k < ${#V[@]}; k++)); do
  blocks "${K[k]}" Write "line one
x = ${V[k]}" "${V[k]}" "line 2: a ${K[k]} shape" "/r/f.py"
done
listed=$(bash "$HOOK" --kinds | tr '\n' '|'); want=$(printf '%s|' "${K[@]}")
if [ "$listed" = "$want" ]; then pass "--kinds lists exactly the kinds tested"; else fail "--kinds lists exactly the kinds tested" "got $listed"; fi

echo "blocked: a literal under a secret-named key:"
P1="hunter$(r 2 3)x9"; P2="Zq8mK$(r 2 2)pLx9"; P3="$(r abcd 1) $(r efgh 1) $(r ijkl 1) $(r mnop 1)"; P4="aB3dE5f$(r G 3)7h"
P5="abcdEFGHijkl$(r MNOP 1)qr"
blocks "password = \"...\""          Write "password = \"$P1\""            "$P1" "key password"
blocks "DB_PASSWORD=... (bare, .env)" Write "DB_PASSWORD=$P1"               "$P1" "key DB_PASSWORD"
blocks "apiKey: '...' (camelCase)"   Write "apiKey: '$P2'"                 "$P2" "key apiKey"
blocks "authToken := ..."            Write "authToken := '$P4'"            "$P4" "key authToken"
blocks "\"client_secret\": \"...\""  Write "{\"client_secret\": \"$P2\"}"  "$P2" "key client_secret"
blocks "'access_key' => '...'"       Write "x = {'access_key' => '$P4'}"   "$P4" "key access_key"
blocks "an app-password shape"       Write "app_pass = '$P3'"              "$P3" "key app_pass"
blocks "16+ chars, both cases"       Write "token=$P5"                     "$P5" "key token"
blocks "the second pair on a line"   Write "user = 'bob', password = '$P1'" "$P1" "key password"

echo "blocked through every write tool:"
blocks "Edit's new_string"           Edit         "password = '$P1'" "$P1" "Edit"
blocks "MultiEdit's second edit"     MultiEdit    "password = '$P1'" "$P1" "MultiEdit"
blocks "NotebookEdit's new_source"   NotebookEdit "x = '${V[0]}'"    "${V[0]}" "/r/n.ipynb"

echo "let through:"
lets "an environment variable"       Write "password = os.environ['DB_PASSWORD']"
lets "a \${VAR} reference"           Write "token: \${GITHUB_TOKEN}"
lets "an env-var name as the value"  Write "PASSWORD=SOME_ENV_NAME"
lets "a dotted name"                 Write "key = self.token"
lets "an identifier"                 Write "token_type = bearer_token"
lets "a camelCase name"              Write "passwordField: loginPassword"
lets "a short word"                  Write "password: hunter"
lets "a placeholder"                 Write "secret = 'changeme123'"
lets "  (your-...)"                  Write "api_key = 'your-api-key-1'"
lets "  (xxx)"                       Write "token = 'xxxxxxxx1234'"
lets "a number"                      Write "max_tokens = 4096"
lets "a URL"                         Write "token_url = 'https://example.invalid/oauth2/token'"
lets "a path"                        Write "private_key = '/etc/keys/k.pem'"
lets "a key with no value"           Write "password:"
lets "prose about a password"        Write "the password is supplied at run time"
lets "a near miss of a shape"        Write "x = AK""IA$(r B 10)"
lets "Bash is not read"              Bash  "echo 'password = $P1'"
lets "Read is not a write"           Read  "password = '$P1'"
lets "an empty Write"                Write ""

echo "fails open (exit 0, no output):"
open() {
  local desc="$1" given="$2" path="${3:-$PATH}" out code
  out=$(printf '%s' "$given" | PATH="$path" "$BASH" "$HOOK" 2>&1); code=$?
  if [ "$code" = 0 ] && [ -z "$out" ]; then pass "$desc"
  else fail "$desc" "exit $code, output: ${out:0:200}"; fi
}
open "empty input"      ''
open "{}"               '{}'
open "not json"         'not json'
open "truncated input"  "{\"tool_name\":\"Write\",\"tool_input\":{\"content\":\"password = '$P1'"
open "content not a string" '{"tool_name":"Write","tool_input":{"content":42}}'
open "edits not a list" '{"tool_name":"MultiEdit","tool_input":{"edits":"x"}}'
T=$(mktemp -d "${TMPDIR:-/tmp}/no-secrets-test.XXXXXX") || exit 1
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/nojq"; for b in cat tr grep cut; do p=$(command -v "$b") && ln -s "$p" "$T/nojq/$b"; done
STATE=$(jq -nc --arg t "password = '$P1'" '{tool_name:"Write",tool_input:{file_path:"/r/f",content:$t}}')
open "no jq on PATH"    "$STATE" "$T/nojq"
out=$(printf '%s' "$STATE" | bash "$HOOK" 2>&1 >/dev/null); code=$?
if [ "$code" = 2 ]; then pass "  (and the same input with jq: blocks)"; else fail "  (and the same input with jq: blocks)" "exit $code"; fi

echo
if [ "$fails" != 0 ]; then echo "$fails FAILED"; exit 1; fi
echo "all cases passed"
