#!/usr/bin/env bash
# hooks: applies_to=all
# Blocks inline script blobs in Bash commands. PreToolUse hook; see
# ../settings.json. Tests: bash .claude/hooks/test-no-inline-blobs.sh
#
# INSTALLED INTO EVERY REPO'S .claude/hooks/, because a hook only fires when
# Claude Code's project dir is the one holding it -- so a rule enforced in one
# folder is not enforced when a session starts in another. The source is
# tools/hooks (source/hooks/); setup installs from it, and `hooks copies`
# there fails when a copy differs from it in meaning or a repo lacks one.
# Change the source, never a copy. The `# hooks:` line above is where this
# file says it applies (tools/hooks vocab.json).
#
# Copies rather than symlinks: a hook whose command is missing exits non-zero,
# which Claude Code reads as a block, so a dangling link would refuse EVERY Bash
# call -- far worse than the duplication.
#
# WHY THIS IS A HOOK AND NOT A RULE: it was already a rule. CLAUDE.md rule 4
# says "Never write an inline script blob", and the session that WROTE that rule
# went on to hand-author the same ~100-character jq filter four times in a row
# while migrating four recipes. A rule you have read and agreed with is not a
# constraint; it is an intention. This project's whole design is to make the
# wrong thing impossible rather than discouraged -- the write guard, the
# validation gate, the read-only generated export -- and this is the same idea
# applied to the shell.
#
# What it costs when it is not enforced:
#   - the blob is re-authored from scratch every time, at full token price
#   - each rewrite is a fresh chance to break shell quoting, which has already
#     cost this project a silent no-op (lab.js set) and a mangled commit message
#   - nothing accumulates: the tenth rewrite is no better than the first, and
#     the next session starts from zero
#
# The alternative is always the same and always cheap: add a subcommand to
# dev.sh, or write a real script and call it. dev.sh exists precisely for this
# and its own header says so.
#
# FAILS OPEN. A hook that breaks every Bash call would be far worse than the
# problem it solves, so anything unexpected here allows the command.

set -uo pipefail

input=$(cat 2>/dev/null) || exit 0
command=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[ -n "$command" ] || exit 0

# ------------------------------------------------------------- the reader --
# A heredoc's BODY is not part of the command line. Matching an interpreter's
# name anywhere in the text blocked `git commit -m "$(cat <<'EOF' ... perl
# ...)"` and a PLAN file appended with `cat >> x.md <<'EOF'` whose text named
# node and python3 (top-level TODO.md, 2026-10-02 and 2026-10-03). So the
# command is read, once, quote-aware:
#   - each heredoc belongs to the PIPELINE it is opened in (`a | b` is one
#     pipeline; `;`, `&&`, `||`, `&` and a newline end one; `$( )`, `( )` and
#     backticks are pipelines of their own). The heredoc feeds an interpreter
#     when a COMMAND WORD of that pipeline is one (after sudo/env/exec/...,
#     VAR=x and flags; by path or not): `python3 - <<PY`, `cat <<EOF | node`;
#   - a body fed to a SHELL (bash, sh, zsh, dash, ksh) is commands, and is read
#     again the same way (three levels deep at most);
#   - every other body is data and is cut out before the one-liner check below,
#     so a body that merely MENTIONS `node -e` is text.
# `((...))` / `$((...))` arithmetic is skipped, so `1<<2` opens no heredoc.
# HEURISTIC, and it errs open: `sudo -u x python3` and `nice -n 5 node` read
# `x`/`5` as the command word; a `<<` inside "..." outside `$( )` is text;
# `python3 <<< 'code'` (a here-string) is not a heredoc and is not checked. A
# heredoc feeding an interpreter that runs a stored script (`node x.js <<EOF`)
# still blocks: its pipeline has an interpreter, and the cases were not worth
# telling apart.
#
# Bash 3.2 (macOS's /bin/bash): no mapfile, no associative arrays, and an empty
# "${a[@]}" is an unbound-variable error under set -u, so every array read is
# guarded. State is global; _hd_scan finishes a level before reading a shell
# body, because the next level resets it.
_hd_interp() { case "$1" in node|nodejs|python|python3|perl|ruby|php|sqlite3) return 0 ;; esac; return 1; }
_hd_shell()  { case "$1" in bash|sh|zsh|dash|ksh) return 0 ;; esac; return 1; }
_hd_prefix() {
  case "$1" in
    sudo|env|command|nohup|time|exec|builtin|nice|if|then|else|elif|while|until|do|'!'|'{'|'}') return 0 ;;
  esac
  return 1
}

# per context (index = nesting depth): interpreter seen, shell seen, heredoc
# ids in the current pipeline, next word is a command word, opened inside "..",
# kind (top|sub|tick), and the outer word saved while inside.
_ctx_open() {
  _d=$((_d+1))
  _C_I[_d]=0; _C_S[_d]=0; _C_H[_d]=""; _C_P[_d]=1; _C_K[_d]=$1; _C_DQ[_d]=$2
  _C_W[_d]=$_word; _C_IW[_d]=$_inword; _word=""; _inword=0; _skip=0; _in_dq=0
}
_pl_end() {
  local k kind=data
  if [ "${_C_I[_d]}" = 1 ]; then kind=interp; elif [ "${_C_S[_d]}" = 1 ]; then kind=shell; fi
  for k in ${_C_H[_d]}; do _HD_K[k]=$kind; done
  _C_I[_d]=0; _C_S[_d]=0; _C_H[_d]=""; _C_P[_d]=1
}
_ctx_close() {
  _flush; _pl_end
  _in_dq=${_C_DQ[_d]}; _word=${_C_W[_d]}; _inword=${_C_IW[_d]}
  _d=$((_d-1))
}
_flush() {
  [ "$_inword" = 1 ] || return 0
  local w=$_word v
  _word=""; _inword=0
  if [ "$_skip" = 1 ]; then _skip=0; return 0; fi       # a redirection's target
  [ "${_C_P[_d]}" = 1 ] || return 0
  case "$w" in [A-Za-z_]*=*|-*) return 0 ;; esac         # VAR=x, a prefix's flag
  v=${w##*/}
  _hd_prefix "$v" && return 0
  _hd_interp "$v" && _C_I[_d]=1
  _hd_shell "$v" && _C_S[_d]=1
  _C_P[_d]=0
}

# _hd_scan <text> <depth>: sets _BLOB (an interpreter one-liner outside any
# data body) and _HEREDOC (a heredoc feeding an interpreter).
_hd_scan() {
  local LC_ALL=C
  local s=$1 depth=$2 n=${#1} i=0 c nx rest part k d strip body pre p cut=0 code="" pend="" lastpipe=0
  local shells=()
  _d=0; _C_I=(0); _C_S=(0); _C_H=(""); _C_P=(1); _C_K=(top); _C_DQ=(0); _C_W=(""); _C_IW=(0)
  _HD_D=(); _HD_X=(); _HD_B=(); _HD_K=()
  _word=""; _inword=0; _skip=0; _in_dq=0
  while [ "$i" -lt "$n" ]; do
    c=${s:i:1}
    if [ "$_in_dq" = 1 ]; then
      case "$c" in
        '"') _in_dq=0; i=$((i+1)) ;;
        \\)  _word+=${s:i+1:1}; i=$((i+2)) ;;
        '$') if [ "${s:i+1:2}" = '((' ]; then
               rest=${s:i+3}; part=${rest%%'))'*}; i=$((i + ${#part} + 5))
             elif [ "${s:i+1:1}" = '(' ]; then _ctx_open sub 1; i=$((i+2))
             else _word+=$c; i=$((i+1)); fi ;;
        '`') _ctx_open tick 1; i=$((i+1)) ;;
        *)   _word+=$c; i=$((i+1)) ;;
      esac
      continue
    fi
    [ "$c" = '|' ] || case "$c" in ' '|$'\t'|$'\n'|'#') ;; *) lastpipe=0 ;; esac
    case "$c" in
      \\)
        nx=${s:i+1:1}
        if [ "$nx" = $'\n' ]; then i=$((i+2)); else _word+=$nx; _inword=1; i=$((i+2)); fi ;;
      "'")
        rest=${s:i+1}; part=${rest%%"'"*}; _word+=$part; _inword=1; i=$((i + ${#part} + 2)) ;;
      '"')
        _in_dq=1; _inword=1; i=$((i+1)) ;;
      ' '|$'\t')
        _flush; i=$((i+1)) ;;
      $'\n')
        _flush; i=$((i+1))
        if [ -n "$pend" ]; then                      # bodies start on the next line
          code+=${s:cut:i-cut}
          for k in $pend; do
            d=${_HD_D[k]}; strip=${_HD_X[k]}; rest=${s:i}; body=""
            if [ "$strip" = 0 ]; then
              if [ "$rest" = "$d" ] || [[ $rest == "$d"$'\n'* ]]; then i=$((i + ${#d} + 1))
              else
                pre=${rest%%$'\n'"$d"$'\n'*}
                if [ "$pre" = "$rest" ] && [[ $rest == *$'\n'"$d" ]]; then pre=${rest%$'\n'"$d"}; fi
                if [ "$pre" != "$rest" ]; then body=$pre$'\n'; i=$((i + ${#pre} + ${#d} + 2))
                else body=$rest; i=$n; fi           # no delimiter: the rest is body
              fi
            else
              while [ "$i" -lt "$n" ]; do
                rest=${s:i}; part=${rest%%$'\n'*}; i=$((i + ${#part} + 1))
                p=$part; while [ "${p:0:1}" = $'\t' ]; do p=${p:1}; done
                [ "$p" = "$d" ] && break
                body+=$part$'\n'
              done
            fi
            _HD_B[k]=$body
          done
          pend=""; [ "$i" -gt "$n" ] && i=$n; cut=$i
        fi
        [ "$lastpipe" = 1 ] || _pl_end ;;
      '#')
        if [ "$_inword" = 0 ]; then rest=${s:i}; part=${rest%%$'\n'*}; i=$((i + ${#part}))
        else _word+=$c; i=$((i+1)); fi ;;
      ';')
        _flush; _pl_end; i=$((i+1)) ;;
      '&')
        _flush; nx=${s:i+1:1}
        if [ "$nx" = '&' ]; then _pl_end; i=$((i+2))
        elif [ "$nx" = '>' ]; then _skip=1; i=$((i+2)); [ "${s:i:1}" = '>' ] && i=$((i+1))
        else _pl_end; i=$((i+1)); fi ;;
      '|')
        _flush; nx=${s:i+1:1}
        if [ "$nx" = '|' ]; then _pl_end; i=$((i+2))
        else _C_P[_d]=1; lastpipe=1; i=$((i+1)); [ "$nx" = '&' ] && i=$((i+1)); fi ;;
      '(')
        _flush
        if [ "${s:i+1:1}" = '(' ]; then rest=${s:i+2}; part=${rest%%'))'*}; i=$((i + ${#part} + 4))
        else _ctx_open sub 0; i=$((i+1)); fi ;;
      ')')
        if [ "$_d" -gt 0 ]; then _ctx_close; else _flush; _pl_end; fi
        i=$((i+1)) ;;
      '`')
        if [ "${_C_K[_d]}" = tick ]; then _ctx_close; else _flush; _ctx_open tick 0; fi
        i=$((i+1)) ;;
      '$')
        nx=${s:i+1:1}
        if [ "${s:i+1:2}" = '((' ]; then rest=${s:i+3}; part=${rest%%'))'*}; i=$((i + ${#part} + 5)); _inword=1
        elif [ "$nx" = '(' ]; then _ctx_open sub 0; i=$((i+2))
        elif [ "$nx" = "'" ]; then rest=${s:i+2}; part=${rest%%"'"*}; _word+=$part; _inword=1; i=$((i + ${#part} + 3))
        else _word+=$c; _inword=1; i=$((i+1)); fi ;;
      '<')
        if [ "$_inword" = 1 ] && [[ $_word =~ ^[0-9]+$ ]]; then _word=""; _inword=0; fi
        _flush
        if [ "${s:i:3}" = '<<<' ]; then _skip=1; i=$((i+3))     # here-string: its word is data
        elif [ "${s:i:2}" = '<<' ]; then
          i=$((i+2)); strip=0
          [ "${s:i:1}" = '-' ] && { strip=1; i=$((i+1)); }
          while [ "${s:i:1}" = ' ' ] || [ "${s:i:1}" = $'\t' ]; do i=$((i+1)); done
          d=""
          while [ "$i" -lt "$n" ]; do
            c=${s:i:1}
            case "$c" in
              ' '|$'\t'|$'\n'|';'|'&'|'|'|'('|')'|'<'|'>') break ;;
              "'") rest=${s:i+1}; part=${rest%%"'"*}; d+=$part; i=$((i + ${#part} + 2)) ;;
              '"') rest=${s:i+1}; part=${rest%%'"'*}; d+=$part; i=$((i + ${#part} + 2)) ;;
              \\)  d+=${s:i+1:1}; i=$((i+2)) ;;
              *)   d+=$c; i=$((i+1)) ;;
            esac
          done
          if [ -n "$d" ]; then
            k=${#_HD_D[@]}; _HD_D[k]=$d; _HD_X[k]=$strip; _HD_B[k]=""; _HD_K[k]=data
            _C_H[_d]="${_C_H[_d]} $k"; pend="$pend $k"
          fi
        elif [ "${s:i+1:1}" = '(' ]; then _ctx_open sub 0; i=$((i+2))   # <( process substitution
        else _skip=1; i=$((i+1)); case "${s:i:1}" in '&'|'>') i=$((i+1)) ;; esac; fi ;;
      '>')
        if [ "$_inword" = 1 ] && [[ $_word =~ ^[0-9]+$ ]]; then _word=""; _inword=0; fi
        _flush; nx=${s:i+1:1}
        if [ "$nx" = '(' ]; then _ctx_open sub 0; i=$((i+2))
        elif [ "$nx" = '&' ] && [[ ${s:i+2:1} =~ [0-9-] ]]; then i=$((i+2)); while [[ ${s:i:1} =~ [0-9-] ]]; do i=$((i+1)); done
        else _skip=1; i=$((i+1)); case "$nx" in '>'|'|'|'&') i=$((i+1)) ;; esac; fi ;;
      *)
        _word+=$c; _inword=1; i=$((i+1)) ;;
    esac
  done
  _flush
  while [ "$_d" -gt 0 ]; do _ctx_close; done
  _pl_end
  [ "$cut" -lt "$n" ] && code+=${s:cut}

  # Interpreter one-liners, over the command with its data bodies cut out. The
  # `-e`/`-c` flag is the whole signature: it means the program is being typed
  # rather than stored. The `([^[:space:]]*/)?` matters: in this project the
  # interpreter is almost always reached by path
  # (~/.nvm/versions/node/v22.20.0/bin/node), and a word-boundary-only pattern
  # let exactly the form actually used walk straight through.
  # A here-string, never `printf | grep -q`: under pipefail a match on a large
  # input read as NO match (grep exits early, printf takes SIGPIPE, status 141).
  if grep -qE '(^|[;&|[:space:]])([^[:space:]]*/)?(node|nodejs|python|python3|perl|ruby|php)[[:space:]]+(-[a-zA-Z]*[ec])([[:space:]]|$)' <<< "$code"; then
    _BLOB=1
  fi
  k=0
  while [ "$k" -lt "${#_HD_D[@]}" ]; do
    case "${_HD_K[k]}" in
      interp) _HEREDOC=1 ;;
      shell)  shells+=("${_HD_B[k]}") ;;
    esac
    k=$((k+1))
  done
  [ "$depth" -lt 3 ] || return 0
  for body in ${shells[@]+"${shells[@]}"}; do _hd_scan "$body" $((depth+1)); done
  return 0
}

_BLOB=0; _HEREDOC=0
_hd_scan "$command" 0

if [ "$_BLOB" = 1 ]; then
  cat >&2 <<'MSG'
BLOCKED: inline script blob (CLAUDE.md rule 4).

You are typing a program instead of storing one. Write it down instead:

  - a recurring read or check  ->  add a subcommand to ./dev.sh
  - anything touching the DB   ->  the CLIs (lab.js / register.js / verify.js /
                                   failures.js), never raw SQL or node -e
  - a genuine one-off          ->  write the script to a file and run the file

This is blocked rather than discouraged because it was already a rule, and
being a rule did not stop it. Re-authoring a blob costs full tokens every time,
risks a new quoting bug every time, and leaves nothing behind for the next
session.
MSG
  exit 2
fi

# Heredocs feeding an interpreter. Same thing wearing a different hat. Read
# above: the heredoc's own pipeline decides, not a name anywhere in the text.
if [ "$_HEREDOC" = 1 ]; then
  cat >&2 <<'MSG'
BLOCKED: heredoc feeding an interpreter (CLAUDE.md rule 4).

Same as an inline blob -- the program is being typed, not stored. Put it in a
file and run the file, or add a ./dev.sh subcommand.

(A heredoc writing a DATA file, e.g. `cat > recipe.json <<'EOF'`, is fine and
is not what this matches.)
MSG
  exit 2
fi

# Long jq programs. Short filters are ordinary shell; a 120-character one is a
# program, and in this project it has always been a dev.sh subcommand that was
# never written. Warns rather than blocks: jq is the sanctioned way to read
# these CLIs' JSON, and drawing the line by length is a judgement, not a fact.
jq_prog=$(printf '%s' "$command" | grep -oE "jq[[:space:]]+(-[a-zA-Z]+[[:space:]]+)*'[^']{120,}'" 2>/dev/null | head -1)
if [ -n "$jq_prog" ]; then
  cat >&2 <<'MSG'
NOTE: that is a long jq program, not a filter.

If you are about to run it more than once, it belongs in ./dev.sh as a
subcommand -- the same shape as `dev.sh inside`, which exists because the same
filter was hand-written four times. Proceeding; this is a warning, not a block.
MSG
fi

exit 0
