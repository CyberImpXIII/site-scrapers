#!/usr/bin/env bash
# hooks: applies_to=all
# Stamps every commit with the agent that made it, and refuses the git commands
# that skip the git hooks or sweep up other agents' work. PreToolUse hook on
# Bash; see ../settings.json. Tests: bash .claude/hooks/test-git-stamp.sh
#
# BLOCKED (exit 2, nothing rewritten), read by the same reader as the stamp:
#   - `git commit` / `git merge` with --no-verify, and commit's -n (alone or in
#     a cluster: -nm, -an): it skips pre-commit and commit-msg, the git-side
#     gates (PLAN-hard-gates.md §7 phase 2 report);
#   - core.hooksPath set for one command (`git -c core.hooksPath=...`, any
#     case) or written by `git config` (a value, --unset, --add,
#     --replace-all); reading it (`git config core.hooksPath`) passes;
#   - `git add -A`, `--all`, `.`, `./`, `:/` and `git commit -a`, `--all`,
#     `.`: they stage every change, other agents' included (§3 row 4). Stage
#     by name. `git add -u` is NOT refused (tracked files only; still a sweep).
# An option's value is skipped (`-m "-a"` is a message), quotes are read
# (`"-A"` is -A), a word that expands anything (`$X`) is not judged.
#
# A `git commit` in the command comes back (as `updatedInput`, no permission
# decision taken, so the permission system still decides) with two trailers
# inserted right after the word `commit`:
#   --trailer 'Agent: <agent_type>'     the main thread has no agent_type in
#                                       its hook input and gets MAIN_THREAD_NAME
#   --trailer 'Agent-Id: <agent_id>'    the main thread's session_id instead
# Inserted after `commit`, not appended, so `git commit ... && git push` and the
# `-m "$(cat <<'EOF' ...)"` message form both work, and a permission rule
# matching `git commit` still matches. Why it exists: PLAN-hard-gates.md §2 --
# a commit message is written by the model, so a stamp the model writes is
# prose; the hook input's agent_type is not.
#
# THE READER. The command is read, not grepped: quotes, `$( )`, `$(( ))`,
# `${ }`, `$'...'`, comments and heredoc bodies are skipped as text, so
# `echo "git commit"` and a message that mentions git commit are not stamped.
# `git` (or a path ending /git) at a command position, after any VAR=x
# prefixes and git's own global options (-C x, -c k=v, --git-dir ...), followed
# by the bare word `commit`, is a commit. Every such commit is stamped.
#
# LEAVES THE COMMAND UNCHANGED (exit 0, no output) when it cannot read it: an
# unterminated quote or `$(`, a backtick, an agent name or id it cannot put
# safely in single quotes. Also not seen: `sudo git commit`, `xargs git
# commit`, a commit inside `bash -c '...'` or a heredoc fed to a shell. An
# unstamped commit is what the second gate (a git-side commit-msg hook,
# PLAN-hard-gates.md §7 phase 2) refuses. The same blind spots apply to the
# blocks, plus GIT_CONFIG_* environment variables and an alias.
#
# INSTALLED INTO EVERY REPO'S .claude/hooks/, because a hook only fires when
# Claude Code's project dir is the one holding it. The source is tools/hooks
# (source/hooks/); `hooks copies` there fails when a copy differs from it.
# Change the source, never a copy.
#
# FAILS OPEN. Malformed input, no jq, a command it cannot read, anything
# unexpected: exit 0, no output, the command runs as written. Exit 2 only for
# a block above.

set -uo pipefail
export LC_ALL=C

# The name a main thread (no agent_type in its hook input) commits under:
# PLAN-hard-gates.md §6, "a main-thread input yields" this.
MAIN_THREAD_NAME=dispatcher

input=$(cat 2>/dev/null) || exit 0
case "$input" in *git*) ;; *) exit 0 ;; esac
command -v jq >/dev/null 2>&1 || exit 0

# -j and the trailing x keep the command's own trailing newlines.
S=$(printf '%s' "$input" | jq -j '.tool_input.command | strings' 2>/dev/null && printf x) || exit 0
S=${S%x}
[ -n "$S" ] || exit 0
ids=$(printf '%s' "$input" | jq -r '[.agent_type // "", .agent_id // "", .session_id // ""] | join("\u001f")' 2>/dev/null) || exit 0
IFS=$'\x1f' read -r agent_type agent_id session_id <<< "$ids"

name=${agent_type:-$MAIN_THREAD_NAME}
id=${agent_id:-$session_id}
safe='^[A-Za-z0-9._@:/+-]+$'
stamp_ok=1      # a name or id it cannot quote safely: no stamp, the blocks still hold
[[ $name =~ $safe ]] || stamp_ok=0
[ -z "$id" ] || [[ $id =~ $safe ]] || stamp_ok=0

# ------------------------------------------------------------- the reader --
# Globals: S the command, N its length, I the read position, BAD set when the
# reader meets what it does not model, INS the insert offsets (ascending).
N=${#S}; I=0; BAD=0; INS=(); BLOCK=()
W_RAW=""; W_PLAIN=1

_sq() {      # I at an opening ' -> after the closing one
  I=$((I + 1))
  while [ $I -lt $N ]; do
    [ "${S:I:1}" = "'" ] && { I=$((I + 1)); return; }
    I=$((I + 1))
  done
  BAD=1
}

_ansi() {    # I at $' -> after the closing '
  I=$((I + 2))
  while [ $I -lt $N ]; do
    case "${S:I:1}" in
      \\) I=$((I + 2)) ;;
      "'") I=$((I + 1)); return ;;
      *) I=$((I + 1)) ;;
    esac
  done
  BAD=1
}

_balanced() {   # $1 open, $2 close; I at the first $1 -> after its match
  local d=0
  while [ $I -lt $N ]; do
    case "${S:I:1}" in
      "$1") d=$((d + 1)) ;;
      "$2") d=$((d - 1)); [ $d -eq 0 ] && { I=$((I + 1)); return; } ;;
    esac
    I=$((I + 1))
  done
  BAD=1
}

_dollar() {  # I at $
  case "${S:I+1:1}" in
    "(") if [ "${S:I+2:1}" = "(" ]; then I=$((I + 1)); _balanced "(" ")"
         else I=$((I + 2)); _cmds ")"; fi ;;
    "{") I=$((I + 1)); _balanced "{" "}" ;;
    "'") _ansi ;;
    *) I=$((I + 1)) ;;
  esac
}

_dq() {      # I at an opening " -> after the closing one
  I=$((I + 1))
  while [ $I -lt $N ] && [ $BAD = 0 ]; do
    case "${S:I:1}" in
      '"') I=$((I + 1)); return ;;
      \\) I=$((I + 2)) ;;
      '$') _dollar ;;
      '`') BAD=1 ;;
      *) I=$((I + 1)) ;;
    esac
  done
  BAD=1
}

_word() {    # one shell word from I -> W_RAW; W_PLAIN=0 if it had any quoting
  local start=$I
  W_PLAIN=1
  while [ $I -lt $N ] && [ $BAD = 0 ]; do
    case "${S:I:1}" in
      ' '|$'\t'|$'\n'|';'|'&'|'|'|'('|')'|'<'|'>') break ;;
      "'") W_PLAIN=0; _sq ;;
      '"') W_PLAIN=0; _dq ;;
      \\) W_PLAIN=0; I=$((I + 2)) ;;
      '$') W_PLAIN=0; _dollar ;;
      '`') BAD=1 ;;
      *) I=$((I + 1)) ;;
    esac
  done
  [ $I -gt $N ] && I=$N
  W_RAW=${S:start:I-start}
}

_blank() { while [ $I -lt $N ]; do case "${S:I:1}" in ' '|$'\t') I=$((I + 1)) ;; *) return ;; esac; done; }

_unq() {     # $1 a word -> UNQ, its text with quotes and backslashes dropped;
             # empty when it expands anything ($), which cannot be judged
  case "$1" in *'$'*) UNQ="" ;; *) UNQ=${1//[\'\"\\]/} ;; esac
}

_lower() { LOWER=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]'); }

_git() {     # I right after a `git` word at a command position
  local want_val=0
  while [ $BAD = 0 ]; do
    _blank
    [ $I -ge $N ] && return
    case "${S:I:1}" in $'\n'|';'|'&'|'|'|'('|')'|'<'|'>'|'#') return ;; esac
    _word
    [ $BAD = 1 ] && return
    _unq "$W_RAW"; _lower "$UNQ"
    case "$LOWER" in *core.hookspath*) BLOCK+=(hookspath) ;; esac
    if [ $want_val = 1 ]; then want_val=0; continue; fi
    case "$W_RAW" in
      -C|-c|--git-dir|--work-tree|--namespace|--super-prefix|--config-env) want_val=1 ;;
      -*) ;;
      commit) [ $W_PLAIN = 1 ] && { INS+=("$I"); _args commit; }; return ;;
      add|merge|config) [ $W_PLAIN = 1 ] && _args "$W_RAW"; return ;;
      *) return ;;
    esac
  done
}

_args() {    # $1 the subcommand; I after it -> the end of this command
  local sub=$1 want=0 dd=0 u c k rest cfgn=0 cfgkey="" cfgwrite=0
  while [ $BAD = 0 ]; do
    _blank
    [ $I -ge $N ] && break
    case "${S:I:1}" in $'\n'|';'|'&'|'|'|'('|')'|'<'|'>'|'#') break ;; esac
    _word
    [ $BAD = 1 ] && return
    _unq "$W_RAW"; u=$UNQ
    if [ $want = 1 ]; then want=0; continue; fi
    if [ $dd = 0 ]; then
      case "$u" in
        --) dd=1; continue ;;
        --no-verify) case $sub in commit|merge) BLOCK+=(noverify) ;; esac; continue ;;
        --all) case $sub in commit) BLOCK+=(commitall) ;; add) BLOCK+=(addall) ;; esac; continue ;;
        --unset|--unset-all|--replace-all|--add) cfgwrite=1; continue ;;
        --*=*) continue ;;
        --message|--file|--reuse-message|--reedit-message|--template|--author|--date|--cleanup|\
        --fixup|--squash|--trailer|--pathspec-from-file|--strategy|--strategy-option|--blob|--type|--default)
          want=1; continue ;;
        --*) continue ;;
        -?*)
          rest=${u#-}
          for ((k = 0; k < ${#rest}; k++)); do
            c=${rest:k:1}
            case "$sub:$c" in
              commit:n) BLOCK+=(noverify) ;;
              commit:a) BLOCK+=(commitall) ;;
              add:A)    BLOCK+=(addall) ;;
              commit:[mFCct]|merge:[msX]|config:f) [ $((k + 1)) = ${#rest} ] && want=1; break ;;
              commit:[Su]) break ;;
            esac
          done
          continue ;;
      esac
    fi
    case "$sub:$u" in
      add:.|add:./|add::/)          BLOCK+=(addall) ;;
      commit:.|commit:./|commit::/) BLOCK+=(commitall) ;;
      config:*) cfgn=$((cfgn + 1))
                [ $cfgn = 1 ] && cfgkey=$u
                [ $cfgn = 2 ] && cfgwrite=1 ;;
    esac
  done
  _lower "$cfgkey"
  [ "$sub" = config ] && [ "$LOWER" = core.hookspath ] && [ $cfgwrite = 1 ] && BLOCK+=(hookspath)
  return 0
}

_bodies() {  # I at the start of a heredoc body; $@ = "strip:delim" in order
  local spec strip delim rest line
  for spec in "$@"; do
    strip=${spec%%:*}; delim=${spec#*:}
    while [ $I -lt $N ]; do
      rest=${S:I}; line=${rest%%$'\n'*}
      I=$((I + ${#line} + 1))
      [ "$strip" = 1 ] && line=${line#"${line%%[!$'\t']*}"}
      [ "$line" = "$delim" ] && break
    done
  done
  [ $I -gt $N ] && I=$N
}

_cmds() {    # a command list from I; $1 = ")" inside $( ), else ""
  local term="$1" cmdpos=1 depth=0 hd=() strip
  while [ $I -lt $N ] && [ $BAD = 0 ]; do
    case "${S:I:1}" in
      ' '|$'\t') I=$((I + 1)) ;;
      $'\n') I=$((I + 1)); cmdpos=1
             if [ ${#hd[@]} -gt 0 ]; then _bodies "${hd[@]}"; hd=(); fi ;;
      ';'|'&'|'|') I=$((I + 1)); cmdpos=1 ;;
      '(') I=$((I + 1)); depth=$((depth + 1)); cmdpos=1 ;;
      ')') I=$((I + 1)); cmdpos=1
           if [ $depth -gt 0 ]; then depth=$((depth - 1))
           elif [ -n "$term" ]; then return; fi ;;
      '#') while [ $I -lt $N ] && [ "${S:I:1}" != $'\n' ]; do I=$((I + 1)); done ;;
      '<') if [ "${S:I:3}" = "<<<" ]; then I=$((I + 3))
           elif [ "${S:I:2}" = "<<" ]; then
             I=$((I + 2)); strip=0
             [ "${S:I:1}" = "-" ] && { strip=1; I=$((I + 1)); }
             _blank; _word
             hd+=("$strip:${W_RAW//[\'\"\\]/}")
           elif [ "${S:I:2}" = "<(" ]; then I=$((I + 2)); _cmds ")"
           else I=$((I + 1)); fi ;;
      '>') if [ "${S:I:2}" = ">(" ]; then I=$((I + 2)); _cmds ")"; else I=$((I + 1)); fi ;;
      *) _word
         [ $BAD = 1 ] && return
         if [ $cmdpos = 1 ]; then
           if [[ $W_RAW =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then :
           else
             case "$W_RAW" in
               if|then|else|elif|do|while|until|'!'|'{'|time) ;;
               git|*/git) cmdpos=0; [ $W_PLAIN = 1 ] && _git ;;
               *) cmdpos=0 ;;
             esac
           fi
         fi ;;
    esac
  done
  [ -n "$term" ] && BAD=1    # ran off the end inside $( )
}

_cmds ""
[ $BAD = 0 ] || exit 0

# ------------------------------------------------------------ the blocks --
if [ ${#BLOCK[@]} -gt 0 ]; then
  seen=" "
  {
    echo "git-stamp: this git command is refused in a session:"
    for b in "${BLOCK[@]}"; do
      case "$seen" in *" $b "*) continue ;; esac
      seen+="$b "
      case "$b" in
        noverify)  echo "  - --no-verify (or commit -n) skips the git hooks: pre-commit's checks and commit-msg's stamp check. They are the gate, not an obstacle: fix what they refuse, or say in your report why it cannot pass." ;;
        hookspath) echo "  - core.hooksPath (as -c for one command, or set by git config) replaces or turns off the git hooks, which are the gate. Leave it as setup installed it." ;;
        addall)    echo "  - git add -A / --all / . / :/ stages every change in the tree, other agents' uncommitted work included. Stage your own paths by name: git add -- <path>..." ;;
        commitall) echo "  - git commit -a / --all / . commits every tracked change, other agents' work included. Stage your own paths by name (git add -- <path>...), then commit." ;;
      esac
    done
    echo "(PLAN-hard-gates.md §3 row 4 and the phase 2 report; the hook is tools/hooks source/hooks/git-stamp.sh.)"
  } >&2
  exit 2
fi
[ ${#INS[@]} -gt 0 ] && [ $stamp_ok = 1 ] || exit 0

stamp=" --trailer 'Agent: $name'"
[ -n "$id" ] && stamp+=" --trailer 'Agent-Id: $id'"
new=$S
for ((k = ${#INS[@]} - 1; k >= 0; k--)); do
  p=${INS[k]}
  new="${new:0:p}${stamp}${new:p}"
done

out=$(printf '%s' "$input" | jq -c --arg c "$new" \
  '{hookSpecificOutput: {hookEventName: "PreToolUse", updatedInput: (.tool_input + {command: $c})}}' 2>/dev/null) || exit 0
printf '%s\n' "$out"
exit 0
