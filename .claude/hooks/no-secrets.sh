#!/usr/bin/env bash
# hooks: applies_to=all
# Credential-shaped values are supplied at run time, never stored -- held at
# write time by a hook, not by prose. PreToolUse hook on Write, Edit,
# MultiEdit and NotebookEdit; see ../settings.json.
# Tests: bash .claude/hooks/test-no-secrets.sh
#
# Blocked (exit 2), whoever the caller and whatever the file: new text (Write's
# content, Edit's new_string, every MultiEdit new_string, NotebookEdit's
# new_source) holding
#   - a SHAPE: a value shaped like a known credential. The kinds and patterns
#     are tools/checks' `no-secrets` SHAPES, the commit-time gate, written as
#     ERE here; tests/test_secret_shapes.py in tools/hooks holds the two
#     lists to the same kinds and the same verdicts. `bash no-secrets.sh
#     --kinds` prints the kinds;
#   - a KEYED LITERAL: a key ending in password, passwd, pwd, pass, secret,
#     token, api_key/apikey, access_key, private_key or credential(s) (any
#     case, `_`/`-`/`.` separated or camelCase), then `=`, `:`, `:=` or `=>`,
#     then a literal that looks like a credential: 8+ characters with no
#     space, quote, `$`, bracket or `://`; not an env-var name (ALL_CAPS), a
#     dotted name (self.token), a lowercase identifier or camelCase name
#     without a digit, a number, or a placeholder (xxx, changeme, example,
#     placeholder, your..., dummy, redacted); and holding a digit or a symbol
#     (+/=~!@#%^&*), or 16+ characters in both cases. A Gmail app-password
#     shape (four groups of four lowercase letters, spaced or not) is one.
# The message names the line, the kind and the KEY, never the value. Why it
# exists: PLAN-hard-gates.md §3 row 7. The way through is to reference the
# value (an environment variable, a gitignored file the user fills); a test
# fixture builds its fake at run time so the file never holds the shape.
#
# NOT SEEN: a value written by a Bash command (echo, tee, a script); a value
# split across lines or built at run time; a shape tools/checks does not
# list. The commit-time gate (tools/checks no-secrets, from the pre-commit git
# hook) is the second gate behind this one, for tracked files.
#
# INSTALLED INTO EVERY REPO'S .claude/hooks/, because a hook only fires when
# Claude Code's project dir is the one holding it. The source is tools/hooks
# (source/hooks/); `hooks copies` there fails when a copy differs from it.
# Change the source, never a copy.
#
# FAILS OPEN. Malformed input, no jq, a tool it does not know: exit 0, no
# output. Exit 2 only for a finding.

set -o pipefail
export LC_ALL=C

# The shapes: KINDS[i] is matched by SHAPES[i] (ERE). Each pattern is written
# so that it does not match its own source text. Word edges are spelled out
# (BSD and GNU grep disagree on \b).
L='(^|[^A-Za-z0-9_])'; R='([^A-Za-z0-9_]|$)'
KINDS=(
  "Anthropic API key"
  "OpenAI API key"
  "GitHub token"
  "GitHub fine-grained token"
  "AWS access key id"
  "Slack token"
  "Google API key"
  "Telegram bot token"
  "private key block"
)
SHAPES=(
  'sk-ant-[A-Za-z0-9_-]{20,}'
  "${L}sk-(proj-)?[A-Za-z0-9]{32,}"
  "${L}gh[pousr]_[A-Za-z0-9]{36,}"
  "${L}github_pat_[A-Za-z0-9_]{50,}"
  "${L}AKIA[0-9A-Z]{16}${R}"
  "${L}xox[abprs]-[A-Za-z0-9-]{10,}"
  "${L}AIza[0-9A-Za-z_-]{35}${R}"
  "${L}[0-9]{8,10}:AA[A-Za-z0-9_-]{33}${R}"
  '-----BEGIN (RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----'
)

if [ "${1:-}" = --kinds ]; then printf '%s\n' "${KINDS[@]}"; exit 0; fi

input=$(cat 2>/dev/null) || exit 0
command -v jq >/dev/null 2>&1 || exit 0
tool=$(printf '%s' "$input" | jq -r '.tool_name | strings' 2>/dev/null) || exit 0
case "$tool" in
  Write)        q='.tool_input.content' ;;
  Edit)         q='.tool_input.new_string' ;;
  MultiEdit)    q='[.tool_input.edits[]? | .new_string | strings] | join("\n")' ;;
  NotebookEdit) q='.tool_input.new_source' ;;
  *) exit 0 ;;
esac
# -j and the trailing x keep the text's own trailing newlines.
text=$(printf '%s' "$input" | jq -j "$q | strings" 2>/dev/null && printf x) || exit 0
text=${text%x}
[ -n "$text" ] || exit 0
target=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.notebook_path | strings' 2>/dev/null)

found=()

# ------------------------------------------------------------- the shapes --
for ((k = 0; k < ${#SHAPES[@]}; k++)); do
  while IFS= read -r n; do
    [ -n "$n" ] && found+=("line $n: a ${KINDS[k]} shape")
  done <<< "$(printf '%s\n' "$text" | grep -nE -e "${SHAPES[k]}" 2>/dev/null | cut -d: -f1)"
done

# ------------------------------------------------------- the keyed literals --
SECRET_KEY='(password|passwd|pwd|(^|[^a-z])pass|secret|token|api[_.-]?key|access[_.-]?key|private[_.-]?key|credentials?)$'
PAIR="([A-Za-z_][A-Za-z0-9_.-]*)[\"']?[[:space:]]*(:=|=>|=|:)[[:space:]]*"

credential_like() {   # $1 the literal -> 0 when it looks like a credential
  local v=$1 lower
  [[ $v =~ ^[a-z]{4}\ ?[a-z]{4}\ ?[a-z]{4}\ ?[a-z]{4}$ ]] && return 0   # app password
  [ ${#v} -ge 8 ] || return 1
  [[ $v =~ ^[A-Za-z0-9_+/=~!@#%^\&*.:-]+$ ]] || return 1
  case "$v" in *://*|/*|./*|~*) return 1 ;; esac
  lower=$(printf '%s' "$v" | tr '[:upper:]' '[:lower:]')
  case "$lower" in *xxx*|*changeme*|*example*|*placeholder*|your*|*dummy*|*redacted*|*'***'*) return 1 ;; esac
  [[ $v =~ ^[A-Z][A-Z0-9_]*$ ]] && return 1                                  # an env-var name
  [[ $v =~ ^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$ ]] && return 1  # a dotted name
  [[ $v =~ ^[0-9.]+$ ]] && return 1                                          # a number
  if [[ ! $v =~ [0-9] ]]; then
    [[ $v =~ ^[a-z]+([_-][a-z]+)*$ ]] && return 1                            # identifier words
    [[ $v =~ ^[a-z]+([A-Z][a-z]+)+$ ]] && return 1                           # camelCase
  fi
  [[ $v =~ [0-9+/=~!@#%^\&*] ]] && return 0
  [ ${#v} -ge 16 ] && [[ $v =~ [a-z] ]] && [[ $v =~ [A-Z] ]] && return 0
  return 1
}

keyed() {   # $1 line number, $2 line
  local n=$1 rest=$2 key val quote
  while [[ $rest =~ $PAIR ]]; do
    key=${BASH_REMATCH[1]}
    rest=${rest#*"${BASH_REMATCH[0]}"}
    quote=${rest:0:1}
    case "$quote" in
      \"|\') rest=${rest:1}; val=${rest%%"$quote"*} ;;
      *) quote=""; val=${rest%%[[:space:],;\)\}]*} ;;
    esac
    # The key is matched in any case; the value never is (credential_like
    # tells ALL_CAPS from lowercase), so nocasematch is off before it runs.
    local secret_key=0
    shopt -s nocasematch
    [[ $key =~ $SECRET_KEY ]] && secret_key=1
    shopt -u nocasematch
    # camelCase keys (apiKey, authToken): the last hump decides.
    [[ $key =~ (Password|Passwd|Secret|Token|ApiKey|AccessKey|PrivateKey|Credentials?)$ ]] && secret_key=1
    if [ $secret_key = 1 ] && credential_like "$val"; then
      found+=("line $n: key $key holds a literal credential-shaped value")
      return
    fi
  done
}

while IFS= read -r hit; do
  [ -n "$hit" ] || continue
  keyed "${hit%%:*}" "${hit#*:}"
done <<< "$(printf '%s\n' "$text" | grep -niE '(pass|pwd|secret|token|key|credential)[A-Za-z0-9_.-]*["'"'"']?[[:space:]]*(:=|=>|=|:)' 2>/dev/null)"

[ ${#found[@]} -gt 0 ] || exit 0
{
  printf 'no-secrets: this %s would store a credential-shaped value%s (values not shown):\n' "$tool" "${target:+ in $target}"
  printf '  %s\n' "${found[@]}"
  printf 'Credentials are supplied at run time, never stored: write the key name and read the value from the environment or a gitignored file the user fills. A test fixture builds its fake at run time (join the parts) so the file never holds the shape.\n'
} >&2
exit 2
