#!/usr/bin/env bash
# hooks: applies_to=all dest=.claude/lib
# SOURCED, not executed. The ONE answer to "which files does this tool call
# write?", a pure function over a command string, usable by any guard. Its
# source is tools/hooks (source/lib/); the workspace top's guard sources the
# installed copy by path, and write-ledger.sh and settings-guard.sh source the
# copy beside them (../lib/), which is why it is installed in every repo. One meaning, so no second parser can disagree with
# it: `hooks copies` in tools/hooks fails when a copy differs from the source.
# Tests: bash tools/hooks/source/tests/test-write-targets.sh (the function);
# the top-level guard's own suite tests it again through the guard.
#
#   normpath <path> <base>        absolute, lexically normalized path: ~, $HOME,
#                                 ${HOME}, $CLAUDE_PROJECT_DIR expanded; a
#                                 relative path is resolved against <base>;
#                                 `.`, `..` and `//` collapsed. No filesystem
#                                 access, so it works for files that do not
#                                 exist yet. Any other `$` stays literal: the
#                                 Edit tool's file_path is a real path, never
#                                 shell-expanded.
#   bash_write_targets <command> <cwd>
#                                 one write target per line, ABSOLUTE and
#                                 normalized. A `cd <dir>` segment moves the
#                                 base for the segments after it (`cd` alone ->
#                                 $HOME; `cd -` -> back to <cwd>, since the
#                                 previous directory is not known).
#                                 A target still holding a `$` or a backtick
#                                 AFTER normpath's expansions is built at run
#                                 time (`> "$S/out.json"`, `> $(pwd)/x`), so it
#                                 is NOT emitted: guessing would resolve `$S/x`
#                                 as cwd-relative and block a scratchpad write.
#                                 A `cd` to such a path makes the base unknown,
#                                 so relative targets after it are skipped too;
#                                 absolute and $CLAUDE_PROJECT_DIR targets are
#                                 still emitted.
#
# bash_write_targets IS HEURISTIC, and every caller's header must say so. It
# catches redirection (`>`, `>>`, `>|`, `N>`, `&>`, `>&file`, glued or spaced;
# not `>&N` or /dev/null), tee/rm/unlink/truncate/touch/chmod/chown/chgrp/shred/mv
# (every operand), cp/install/rsync/ln/scp/ditto (last operand), sed -i and
# perl -i (every FILE operand) and dd of=, after splitting on ; & && || | |&
# ( ) and newlines, skipping sudo/env/command/nohup/time/exec/builtin and
# VAR=value prefixes.
#
# QUOTES ARE PARSED, not stripped (fixed 2026-10-02: `grep '^[<>] x'` was read
# as a write to a file named `]`). Inside '...' or "..." a > < ; | & ( ) or #
# is text. A backslash escapes the next character outside quotes. A `#` that
# starts a word starts a comment. Text that is DATA is never read as a target:
#   - a sed or perl program: `-e`'s argument, or the first operand when there
#     is no -e (`perl -0pi -e 's/a/b/' TODO.md` writes TODO.md, not `s/a/b/`);
#   - a heredoc body, unless the command it feeds is a shell (bash, sh, zsh,
#     dash, ksh), whose body lines ARE commands and are read as such;
#   - `(( ... ))` arithmetic, and a `>` inside `[[ ... ]]` (a comparison).
# It does NOT see a script or interpreter that writes a file itself
# (`python3 x.py`, `node build.js`, awk's own `print > "f"`), `git checkout --
# <file>`, or a path assembled at run time (a variable other than
# HOME/CLAUDE_PROJECT_DIR, a command substitution, a backtick) -- those fail
# OPEN.
#
# Both functions only print; neither ever exits non-zero, because both callers
# fail OPEN.

# Run "$@" with globbing off, restoring the caller's setting. Word-splitting a
# path or a command must never expand a `*` against the filesystem.
_wt_noglob() {
  local had_f=0 rc
  case $- in *f*) had_f=1 ;; esac
  set -f
  "$@"; rc=$?
  [ $had_f -eq 1 ] || set +f
  return $rc
}

# The internals return through globals (_WT_X, _WT_P, _WT_R), not stdout: a
# `$(...)` per target forks, and 200 targets cost 11 s that way (measured
# 2026-10-02). Only the two public functions print.
normpath() { _wt_noglob _wt_normpath "$@"; printf '%s' "$_WT_P"; }
_wt_normpath() {   # -> _WT_P
  local p base=${2:-/}
  _wt_expand "${1:-}"; p=$_WT_X
  case "$p" in /*) ;; *) p=$base/$p ;; esac
  local IFS=/ part out=() n
  for part in $p; do
    case "$part" in
      ""|.) ;;
      ..) n=${#out[@]}; [ "$n" -gt 0 ] && unset "out[$((n-1))]"
          out=(${out[@]+"${out[@]}"}) ;;
      *)  out+=("$part") ;;
    esac
  done
  if [ ${#out[@]} -gt 0 ]; then printf -v _WT_P '/%s' "${out[@]}"; else _WT_P=/; fi
  return 0
}

# The only variables this file knows: ~, $HOME, ${HOME}, $CLAUDE_PROJECT_DIR.
_wt_expand() {   # -> _WT_X
  local p=${1:-} home=${HOME:-} root=${CLAUDE_PROJECT_DIR:-}
  case "$p" in
    "~")                       p=$home ;;
    "~/"*)                     p=$home/${p#"~/"} ;;
    '$HOME'|'${HOME}')         p=$home ;;
    '$HOME/'*)                 p=$home/${p#'$HOME/'} ;;
    '${HOME}/'*)               p=$home/${p#'${HOME}/'} ;;
    '$CLAUDE_PROJECT_DIR/'*)   p=$root/${p#'$CLAUDE_PROJECT_DIR/'} ;;
    '${CLAUDE_PROJECT_DIR}/'*) p=$root/${p#'${CLAUDE_PROJECT_DIR}/'} ;;
  esac
  _WT_X=$p
}

# A `$` or backtick left after the known expansions = a path built at run
# time. Tested BEFORE normalizing, because `..` would lexically eat it:
# "$S/../x" must not become <cwd>/x. A `cd` into such a path sets _WT_BASE to
# _WT_UNKNOWN, so a relative target after it is skipped too.
_WT_UNKNOWN='$unknown'
_wt_runtime() { case "$1" in *'$'*|*'`'*) return 0 ;; esac; return 1; }
_wt_resolve() {   # word -> absolute path in _WT_R; returns 1 when unknowable
  local x; _wt_expand "$1"; x=$_WT_X
  _wt_runtime "$x" && return 1
  case "$x" in /*) ;; *) _wt_runtime "$_WT_BASE" && return 1 ;; esac
  _wt_normpath "$x" "$_WT_BASE"; _WT_R=$_WT_P
}
_wt_emit() {
  case "$1" in ""|"&"*|/dev/null|/dev/std*|/dev/fd/*) return 0 ;; esac
  _wt_resolve "$1" || return 0
  printf '%s\n' "$_WT_R"
}

# ------------------------------------------------------------------ lexer --
# _wt_lex <command> fills _WT_TOK, one token per element, typed by its first
# character:
#   W<word>  a word, quotes removed; `$` and backticks kept, so a word built at
#            run time is still recognisable as one
#   S        a segment boundary (; & && || | |& ( ) newline, unquoted)
#   O        an output redirection; the next W is its target
#   I        an input redirection or a heredoc delimiter; the next W is read
#   H<body>  a heredoc body, right before the S that ends its line
# Byte-wise (LC_ALL=C), so an index is O(1) and a multibyte path is just bytes.
_wt_lex() {
  local LC_ALL=C
  local s=$1 n=${#1} i=0 c nx word="" inword=0 quoted=0 rest part k
  local hd_want=0 hd_strip=0 hd_delims=() hd_strips=()
  _WT_TOK=()
  _wt_flush() {
    [ $inword -eq 1 ] || return 0
    if [ $hd_want -eq 1 ]; then hd_delims+=("$word"); hd_strips+=("$hd_strip"); hd_want=0
    else _WT_TOK+=("W$word"); fi
    word=""; inword=0; quoted=0
  }
  while [ $i -lt "$n" ]; do
    c=${s:i:1}
    case "$c" in
      \\)
        nx=${s:i+1:1}
        if [ "$nx" = $'\n' ]; then i=$((i+2)); continue; fi     # line continuation
        word+=$nx; inword=1; quoted=1; i=$((i+2)) ;;
      "'")
        rest=${s:i+1}
        if [[ $rest == *"'"* ]]; then part=${rest%%"'"*}; else part=$rest; fi
        word+=$part; inword=1; quoted=1; i=$((i + ${#part} + 2)) ;;
      '"')
        k=$((i+1))
        while [ $k -lt "$n" ]; do
          c=${s:k:1}
          if [ "$c" = '\' ]; then
            nx=${s:k+1:1}
            case "$nx" in
              '"'|'\'|'$'|'`') word+=$nx; k=$((k+2)); continue ;;
              $'\n') k=$((k+2)); continue ;;
            esac
            word+=$c; k=$((k+1)); continue
          fi
          [ "$c" = '"' ] && break
          word+=$c; k=$((k+1))
        done
        inword=1; quoted=1; i=$((k+1)) ;;
      '`')
        rest=${s:i+1}
        if [[ $rest == *'`'* ]]; then part=${rest%%'`'*}; else part=$rest; fi
        word+="\`$part\`"; inword=1; i=$((i + ${#part} + 2)) ;;
      ' '|$'\t')
        _wt_flush; i=$((i+1)) ;;
      $'\n')
        _wt_flush
        # heredoc bodies start on the line after the one that opened them
        if [ ${#hd_delims[@]} -gt 0 ]; then
          local p=$((i+1)) d j line cmp body
          for j in "${!hd_delims[@]}"; do
            d=${hd_delims[$j]}; body=""
            while [ $p -le "$n" ]; do
              rest=${s:p}
              line=${rest%%$'\n'*}
              cmp=$line
              if [ "${hd_strips[$j]}" = 1 ]; then while [ "${cmp:0:1}" = $'\t' ]; do cmp=${cmp:1}; done; fi
              p=$((p + ${#line} + 1))
              [ "$cmp" = "$d" ] && break
              body+=$line$'\n'
              [ "$line" = "$rest" ] && break                        # last line, no terminator
            done
            _WT_TOK+=("H$body")
          done
          hd_delims=(); hd_strips=()
          _WT_TOK+=(S); i=$p; continue
        fi
        _WT_TOK+=(S); i=$((i+1)) ;;
      ';')
        _wt_flush; _WT_TOK+=(S); i=$((i+1)) ;;
      '|')
        _wt_flush; _WT_TOK+=(S); i=$((i+1))
        case "${s:i:1}" in '|'|'&') i=$((i+1)) ;; esac ;;
      '&')
        nx=${s:i+1:1}
        if [ "$nx" = '>' ]; then                                   # &> and &>>
          _wt_flush; i=$((i+2)); [ "${s:i:1}" = '>' ] && i=$((i+1)); _WT_TOK+=(O)
        else
          _wt_flush; _WT_TOK+=(S); i=$((i+1)); [ "$nx" = '&' ] && i=$((i+1))
        fi ;;
      '(')
        _wt_flush
        if [ "${s:i+1:1}" = '(' ]; then                            # (( arithmetic )): never a write
          rest=${s:i+2}
          if [[ $rest == *'))'* ]]; then part=${rest%%'))'*}; i=$((i + ${#part} + 4)); else i=$n; fi
        else i=$((i+1)); fi
        _WT_TOK+=(S) ;;
      ')')
        _wt_flush; _WT_TOK+=(S); i=$((i+1)) ;;
      '>'|'<')
        nx=${s:i+1:1}
        if [ "$nx" = '(' ]; then _wt_flush; _WT_TOK+=(S); i=$((i+2)); continue; fi   # process substitution
        # an unquoted all-digit word glued to it is a file descriptor, not a word
        if [ $inword -eq 1 ] && [ $quoted -eq 0 ] && [[ $word =~ ^[0-9]+$ ]]; then word=""; inword=0
        else _wt_flush; fi
        i=$((i+1))
        if [ "$c" = '>' ]; then
          case "$nx" in
            '>'|'|') i=$((i+1)); _WT_TOK+=(O) ;;
            '&') i=$((i+1))
                 if [[ ${s:i:1} =~ [0-9-] ]]; then                 # >&N, >&- : a dup, not a file
                   while [[ ${s:i:1} =~ [0-9-] ]]; do i=$((i+1)); done
                 else _WT_TOK+=(O); fi ;;
            *) _WT_TOK+=(O) ;;
          esac
        else
          case "$nx" in
            '<') if [ "${s:i+1:1}" = '<' ]; then i=$((i+2)); _WT_TOK+=(I)   # <<< here-string
                 else i=$((i+1)); hd_strip=0                              # << heredoc
                      [ "${s:i:1}" = '-' ] && { hd_strip=1; i=$((i+1)); }
                      hd_want=1
                 fi ;;
            '&') i=$((i+1)); while [[ ${s:i:1} =~ [0-9-] ]]; do i=$((i+1)); done ;;
            '>') i=$((i+1)); _WT_TOK+=(O) ;;                        # <> opens for writing
            *) _WT_TOK+=(I) ;;
          esac
        fi ;;
      '#')
        if [ $inword -eq 0 ]; then                                 # a comment, to the end of the line
          rest=${s:i}
          if [[ $rest == *$'\n'* ]]; then part=${rest%%$'\n'*}; i=$((i + ${#part})); else i=$n; fi
        else word+=$c; i=$((i+1)); fi ;;
      *)
        word+=$c; inword=1; i=$((i+1)) ;;
    esac
  done
  _wt_flush
  _WT_TOK+=(S)
  unset -f _wt_flush
  return 0
}

# ------------------------------------------------------------- the reader --
bash_write_targets() { _wt_noglob _wt_bash_write_targets "$@"; }
_wt_bash_write_targets() {
  _WT_BASE=${2:-${PWD:-/}}
  _wt_run "${1:-}" "${2:-${PWD:-/}}" 0
  return 0
}

# One command string (the whole command, or a heredoc fed to a shell).
_wt_run() {
  local cmd=$1 start=$2 depth=$3 t pending="" words=() bodies=() targets=() b base
  _wt_lex "$cmd"
  local toks=("${_WT_TOK[@]}")
  for t in "${toks[@]}"; do
    case "${t:0:1}" in
      W) if [ "$pending" = O ]; then targets+=("${t:1}")
         elif [ "$pending" != I ]; then words+=("${t:1}"); fi
         pending="" ;;
      O|I) pending=${t:0:1} ;;
      H) bodies+=("${t:1}") ;;
      S) pending=""
         [ ${#words[@]} -gt 0 ] || [ ${#targets[@]} -gt 0 ] || { bodies=(); continue; }
         _wt_words "$start" ${words[@]+"${words[@]}"}
         # [[ a > b ]] compares strings; it redirects nothing
         if [ "$_WT_VERB" != '[[' ]; then
           for b in ${targets[@]+"${targets[@]}"}; do _wt_emit "$b"; done
         fi
         case "$_WT_VERB" in
           bash|sh|zsh|dash|ksh)
             if [ "$depth" -lt 3 ]; then
               base=$_WT_BASE
               for b in ${bodies[@]+"${bodies[@]}"}; do _wt_run "$b" "$start" $((depth+1)); done
               _WT_BASE=$base
             fi ;;
         esac
         words=(); bodies=(); targets=() ;;
    esac
  done
  return 0
}

# A sed or perl command line (the words after the verb) -> _WT_OPS, its FILE
# operands, and _WT_INPLACE. The program is never a file: it is -e's argument,
# or, with no -e/-f, the first operand.
_wt_sed_args() {
  local a=("$@") j=0 n=$# w c r script=0 opts=1 nx
  _WT_OPS=(); _WT_INPLACE=0
  while [ $j -lt "$n" ]; do
    w=${a[$j]}; j=$((j+1))
    if [ $opts -eq 1 ]; then
      case "$w" in
        --) opts=0; continue ;;
        --in-place*) _WT_INPLACE=1; continue ;;
        --expression=*|--file=*) script=1; continue ;;
        --expression|--file) script=1; j=$((j+1)); continue ;;
        --*) continue ;;
        -?*)
          r=${w#-}
          while [ -n "$r" ]; do
            c=${r:0:1}; r=${r:1}
            case "$c" in
              i) _WT_INPLACE=1
                 # BSD sed: a bare -i takes the next word as the backup suffix
                 # ('' for none, or .bak); GNU's suffix is glued, so its next
                 # word is never one of those.
                 if [ -z "$r" ] && [ $j -lt "$n" ]; then
                   nx=${a[$j]}
                   case "$nx" in
                     "") j=$((j+1)) ;;
                     ./*|../*|.|..) ;;
                     .*) j=$((j+1)) ;;
                   esac
                 fi
                 break ;;
              e|f) script=1; [ -z "$r" ] && j=$((j+1)); break ;;
              l)   [ -z "$r" ] && j=$((j+1)); break ;;
            esac
          done
          continue ;;
      esac
    fi
    _WT_OPS+=("$w")
  done
  [ $script -eq 1 ] || _WT_OPS=(${_WT_OPS[@]+"${_WT_OPS[@]:1}"})
  return 0
}
_wt_perl_args() {
  local a=("$@") j=0 n=$# w c r script=0 opts=1
  _WT_OPS=(); _WT_INPLACE=0
  while [ $j -lt "$n" ]; do
    w=${a[$j]}; j=$((j+1))
    if [ $opts -eq 1 ]; then
      case "$w" in
        --) opts=0; continue ;;
        -) opts=0 ;;
        -?*)
          r=${w#-}
          while [ -n "$r" ]; do
            c=${r:0:1}; r=${r:1}
            case "$c" in
              e|E) script=1; [ -z "$r" ] && j=$((j+1)); break ;;
              i) _WT_INPLACE=1; break ;;                   # the rest is the backup extension
              0) while [[ ${r:0:1} =~ [0-9a-fA-Fx] ]]; do r=${r:1}; done ;;
              l) while [[ ${r:0:1} =~ [0-9] ]]; do r=${r:1}; done ;;
              I|M|m|x|C|d|D|F|V) break ;;                   # the rest is that switch's argument
            esac
          done
          continue ;;
      esac
    fi
    _WT_OPS+=("$w")
  done
  [ $script -eq 1 ] || _WT_OPS=(${_WT_OPS[@]+"${_WT_OPS[@]:1}"})
  return 0
}

# One segment's words. Sets _WT_VERB, and updates _WT_BASE on `cd`, so it
# carries into later segments.
_wt_words() {
  local start=$1; shift
  local args=("$@") verb="" i=0 n=$# x rest=() operands=() k
  _WT_VERB=""
  while [ $i -lt "$n" ]; do
    x=${args[$i]}; i=$((i+1))
    case "$x" in
      sudo|command|env|nohup|time|exec|builtin) continue ;;
      # a keyword before the verb: `if [[ a > b ]]` is still a [[ comparison
      if|elif|while|until|then|else|do|'!'|'{') continue ;;
      [A-Za-z_]*=*) continue ;;
      *) verb=${x##*/}; break ;;
    esac
  done
  [ -n "$verb" ] || return 0
  _WT_VERB=$verb
  rest=(${args[@]+"${args[@]:$i}"})
  case "$verb" in
    sed|perl)
      "_wt_${verb}_args" ${rest[@]+"${rest[@]}"}
      if [ "$_WT_INPLACE" = 1 ]; then
        for x in ${_WT_OPS[@]+"${_WT_OPS[@]}"}; do _wt_emit "$x"; done
      fi
      return 0 ;;
  esac
  for x in ${rest[@]+"${rest[@]}"}; do
    case "$x" in
      "") ;;
      -) [ "$verb" = cd ] && operands+=("$x") ;;   # `cd -` is an operand, not a flag
      -*) ;;
      *) operands+=("$x") ;;
    esac
  done
  k=${#operands[@]}
  case "$verb" in
    cd)
      if [ "$k" -eq 0 ]; then _WT_BASE=${HOME:-/}
      elif [ "${operands[0]}" = - ]; then _WT_BASE=$start
      elif _wt_resolve "${operands[0]}"; then _WT_BASE=$_WT_R
      else _WT_BASE=$_WT_UNKNOWN; fi ;;
    tee|rm|unlink|truncate|touch|chmod|chown|chgrp|shred|mv)
      for x in ${operands[@]+"${operands[@]}"}; do _wt_emit "$x"; done ;;
    cp|install|rsync|ln|scp|ditto)
      [ "$k" -gt 0 ] && _wt_emit "${operands[$((k-1))]}" ;;
    dd)
      for x in ${operands[@]+"${operands[@]}"}; do
        case "$x" in of=*) _wt_emit "${x#of=}" ;; esac
      done ;;
  esac
  return 0
}
