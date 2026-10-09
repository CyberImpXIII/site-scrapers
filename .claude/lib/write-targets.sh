#!/usr/bin/env bash
# hooks: applies_to=all dest=.claude/lib sourced_by=.claude/hooks/dispatch-guard.sh
# SOURCED, not executed. The ONE answer to "which files does this tool call
# write?", a pure function over a command string, usable by any guard. Its
# source is tools/hooks (source/lib/); the workspace top's guard sources the
# installed copy by path, and write-ledger.sh and settings-guard.sh source the
# copy beside them (../lib/), which is why it is installed in every repo
# (sourced_by above: the top guard reads $CLAUDE_PROJECT_DIR/.claude/lib/, so
# each project dir needs this copy whichever hooks it installs). One meaning, so no second parser can disagree with
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
#   bash_write_targets <command> <cwd> "<opt-ins>"
#                                 a space-separated list of:
#     sqlite    also the DATABASE operand of every `sqlite3` call not opened
#               read-only (-readonly, or a file: URI with mode=ro or
#               immutable=1). Opt-in, because opening a database is not a file
#               write to every caller: store-guard.sh asks for it (a store is
#               written only by its CLI); the ledger and settings-guard do not.
#     indirect  also what a patch or an archive will write, as RECORDS (lines
#               that do not start with `/`; see _wt_indirect): `git apply` and
#               `patch` fed a file, a `<` input, a heredoc or a here-string,
#               and `tar -x`. The caller reads the patch or lists the archive
#               (this file never touches the disk). Also the lone operand of
#               `git checkout <x>`, which is a branch or a path. Only
#               store-guard.sh asks for it.
#   patch_paths                   stdin: a diff; stdout: each path it names.
#
# bash_write_targets IS HEURISTIC, and every caller's header must say so. It
# catches redirection (`>`, `>>`, `>|`, `N>`, `&>`, `>&file`, glued or spaced;
# not `>&N` or /dev/null), tee/rm/unlink/truncate/touch/chmod/chown/chgrp/shred/
# mv/chattr (every operand), chflags (every operand after the flags),
# cp/install/rsync/ln/scp/ditto (last operand), sed -i and perl -i (every FILE
# operand), dd of=, git checkout/restore (the paths; `git -C dir` moves the
# base), ex/vi/vim/nvim/ed (the files, unless -R/-M), tar -c (the archive) and
# patch (the original file, or -o's), after splitting on ; & && || | |& ( )
# and newlines, skipping sudo/env/command/nohup/time/exec/builtin and
# VAR=value prefixes.
#
# A VARIABLE ASSIGNED A LITERAL in an assignment-only segment (`D=x;`,
# `export D=x`) is substituted in the segments after it (2026-10-09: `D=.claude;
# sed -i x $D/agents.manifest.json`). One assigned at run time (`D=$(pwd)`), or
# set by for/read/printf -v, is unknown, so a target using it is not emitted.
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
# (`python3 x.py`, `node build.js`, awk's own `print > "f"`), git switch/
# reset/stash/merge/pull/am, an archive or patch arriving through a pipe, or
# a path assembled at run time (a variable not known as above, a command
# substitution, a backtick) -- those fail OPEN.
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
  local x; _wt_subst "$1"; _wt_expand "$_WT_X"; x=$_WT_X
  _wt_runtime "$x" && return 1
  case "$x" in /*) ;; *) _wt_runtime "$_WT_BASE" && return 1 ;; esac
  _wt_normpath "$x" "$_WT_BASE"; _WT_R=$_WT_P
}
_wt_emit() {
  case "$1" in ""|"&"*|/dev/null|/dev/std*|/dev/fd/*) return 0 ;; esac
  _wt_resolve "$1" || return 0
  printf '%s\n' "$_WT_R"
}

# Variables assigned a LITERAL earlier in the same command (`D=.claude; sed -i
# x $D/f`, `export D=x`) are known: _WT_VN names, _WT_VV values (bash 3.2 has
# no associative arrays). A value still holding a `$` or backtick after
# substitution leaves any target using it unknown. Read in order, like the shell;
# NOT scoped: an assignment inside `( )` is still known after it, and a
# single-quoted '$D' is expanded although the shell would not (both rare;
# both can only add a target, never hide one).
_wt_subst() {   # word -> _WT_X, every known $NAME / ${NAME} replaced
  local x=$1 j n v out pre post
  case "$x" in *'$'*) ;; *) _WT_X=$x; return 0 ;; esac
  for j in ${_WT_VN[@]+"${!_WT_VN[@]}"}; do
    n=${_WT_VN[$j]}; v=${_WT_VV[$j]}
    x=${x//"\${$n}"/$v}
    out=""
    while [[ $x == *"\$$n"* ]]; do
      pre=${x%%"\$$n"*}; post=${x#*"\$$n"}
      if [[ $post =~ ^[A-Za-z0-9_] ]]; then out+=$pre"\$$n"; else out+=$pre$v; fi
      x=$post
    done
    x=$out$x
  done
  _WT_X=$x
}
_wt_assign() {  # NAME=value
  local n=${1%%=*} v=${1#*=} j keep_n=() keep_v=()
  [[ $n =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || return 0
  for j in ${_WT_VN[@]+"${!_WT_VN[@]}"}; do
    [ "${_WT_VN[$j]}" = "$n" ] && continue
    keep_n+=("${_WT_VN[$j]}"); keep_v+=("${_WT_VV[$j]}")
  done
  _WT_VN=(${keep_n[@]+"${keep_n[@]}"}); _WT_VV=(${keep_v[@]+"${keep_v[@]}"})
  _wt_subst "$v"
  # a value still holding `$` or a backtick is kept as is: substituted, it
  # leaves the target built at run time, so the target is not emitted
  _WT_VN+=("$n"); _WT_VV+=("$_WT_X")
}

# An INDIRECT write (only with the `indirect` flag): the files a patch or an
# archive will write are not in the command, only the patch or archive is.
# One line per record, tab-separated, never starting with `/` (a target
# always does):  patch<TAB>file<TAB>base   a patch file to read (git apply, patch)
#                ppath<TAB>path<TAB>base   a path named by a patch given inline
#                tar<TAB>archive<TAB>dest<TAB>strip   an archive tar -x unpacks
_wt_indirect() {   # kind word [extra]
  [ "${_WT_IND:-0}" = 1 ] || return 0
  local base=$_WT_BASE
  _wt_runtime "$base" && return 0
  case "$1" in
    ppath) printf 'ppath\t%s\t%s\n' "$2" "$base" ;;
    patch) _wt_resolve "$2" || return 0
           [ -n "${3:-}" ] && { _wt_runtime "$3" && return 0; base=$3; }
           printf 'patch\t%s\t%s\n' "$_WT_R" "$base" ;;
    tar)   local arch dest=$base
           _wt_resolve "$2" || return 0; arch=$_WT_R
           if [ -n "${3:-}" ]; then _wt_resolve "$3" || return 0; dest=$_WT_R; fi
           printf 'tar\t%s\t%s\t%s\n' "$arch" "$dest" "${4:-0}" ;;
  esac
}

# The paths a unified or git diff names (`--- a/x`, `+++ b/x`, `rename to x`),
# read from stdin, one per line, as written (prefix not stripped). Pure text.
patch_paths() {
  local line p
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      '+++ '*|'--- '*) p=${line:4}; p=${p%%$'\t'*} ;;
      'rename to '*|'copy to '*) p=${line#* to } ;;
      *) continue ;;
    esac
    case "$p" in \"*\") p=${p:1:${#p}-2} ;; esac
    case "$p" in /dev/null|'') continue ;; esac
    printf '%s\n' "$p"
  done
  return 0
}

# ------------------------------------------------------------------ lexer --
# _wt_lex <command> fills _WT_TOK, one token per element, typed by its first
# character:
#   W<word>  a word, quotes removed; `$` and backticks kept, so a word built at
#            run time is still recognisable as one
#   S        a segment boundary (; & && || | |& ( ) newline, unquoted)
#   O        an output redirection; the next W is its target
#   I        an input redirection; the next W is the file read
#   J        a `<<<` here-string; the next W is text fed to the command
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
            '<') if [ "${s:i+1:1}" = '<' ]; then i=$((i+2)); _WT_TOK+=(J)   # <<< here-string
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
  _WT_SQLITE=0; _WT_IND=0; _WT_VN=(); _WT_VV=()
  case " ${3:-} " in *" sqlite "*) _WT_SQLITE=1 ;; esac
  case " ${3:-} " in *" indirect "*) _WT_IND=1 ;; esac
  _wt_run "${1:-}" "${2:-${PWD:-/}}" 0
  return 0
}

# One command string (the whole command, or a heredoc fed to a shell).
_wt_run() {
  local cmd=$1 start=$2 depth=$3 t pending="" words=() bodies=() targets=() inputs=() texts=() b base
  _wt_lex "$cmd"
  local toks=("${_WT_TOK[@]}")
  for t in "${toks[@]}"; do
    case "${t:0:1}" in
      W) case "$pending" in
           O) targets+=("${t:1}") ;;
           I) inputs+=("${t:1}") ;;
           J) texts+=("${t:1}") ;;
           *) words+=("${t:1}") ;;
         esac
         pending="" ;;
      O|I|J) pending=${t:0:1} ;;
      H) bodies+=("${t:1}") ;;
      S) pending=""
         [ ${#words[@]} -gt 0 ] || [ ${#targets[@]} -gt 0 ] || { bodies=(); inputs=(); texts=(); continue; }
         _WT_INPUTS=(${inputs[@]+"${inputs[@]}"})
         _WT_TEXTS=(${texts[@]+"${texts[@]}"} ${bodies[@]+"${bodies[@]}"})
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
         words=(); bodies=(); targets=(); inputs=(); texts=() ;;
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

# A sqlite3 command line (the words after the verb) -> emits its database, the
# first word that is not an option or an option's argument, unless it is
# opened read-only. Options are read anywhere on the line (sqlite3 does), so
# `sqlite3 db -readonly` is a read. `-A` (archive mode) takes the rest of the
# line as its own arguments: nothing is emitted (fails open).
_wt_sqlite_db() {
  local a=("$@") j=0 n=$# w db="" ro=0 opts=1
  while [ $j -lt "$n" ]; do
    w=${a[$j]}; j=$((j+1))
    if [ $opts -eq 1 ]; then
      case "$w" in
        --) opts=0; continue ;;
        -readonly|--readonly) ro=1; continue ;;
        -A*|--A*) return 0 ;;
        -cmd|-init|-maxsize|-mmap|-newline|-nonce|-nullvalue|-separator|-vfs|-escape|-heap|\
        --cmd|--init|--maxsize|--mmap|--newline|--nonce|--nullvalue|--separator|--vfs|--escape|--heap)
          j=$((j+1)); continue ;;
        -lookaside|-pagecache|--lookaside|--pagecache) j=$((j+2)); continue ;;
        -?*) continue ;;
      esac
    fi
    [ -n "$db" ] || db=$w          # later words are SQL
  done
  [ $ro -eq 0 ] || return 0
  case "$db" in
    ""|:memory:) return 0 ;;
    file:*)
      [[ $db =~ [?\&](mode=ro|immutable=1)(\&|$) ]] && return 0
      db=${db#file:}; db=${db%%\?*} ;;
  esac
  _wt_emit "$db"
}

_wt_unset() {   # NAME: no longer known
  local n=$1 j keep_n=() keep_v=()
  for j in ${_WT_VN[@]+"${!_WT_VN[@]}"}; do
    [ "${_WT_VN[$j]}" = "$n" ] && continue
    keep_n+=("${_WT_VN[$j]}"); keep_v+=("${_WT_VV[$j]}")
  done
  _WT_VN=(${keep_n[@]+"${keep_n[@]}"}); _WT_VV=(${keep_v[@]+"${keep_v[@]}"})
}

# The patch text a command is fed inline (a heredoc or a here-string) ->
# a `ppath` record per path it names.
_wt_inline_patch() {
  local t p
  for t in ${_WT_TEXTS[@]+"${_WT_TEXTS[@]}"}; do
    while IFS= read -r p; do _wt_indirect ppath "$p"; done < <(printf '%s\n' "$t" | patch_paths)
  done
}

# git [global options] <subcommand> ...: the work-tree files a subcommand
# names. checkout (`-- <paths>`, or `<tree-ish> <paths>`; a lone operand is a
# branch OR a path, so it is emitted only with `indirect`), restore (its paths,
# unless only --staged), apply (an `indirect` patch record, unless --cached,
# or --check/--stat/--numstat/--summary without --apply). `-C <dir>` moves the
# base for that one command. Not seen: switch, reset --hard, stash, merge,
# pull, am (many files, none named).
_wt_git() {
  local a=("$@") j=0 n=$# w sub="" saved=$_WT_BASE ops=() dd=0 opts=1 x
  while [ $j -lt "$n" ]; do
    w=${a[$j]}
    case "$w" in
      -C) j=$((j+1)); [ $j -lt "$n" ] || break
          if _wt_resolve "${a[$j]}"; then _WT_BASE=$_WT_R; else _WT_BASE=$_WT_UNKNOWN; fi
          j=$((j+1)) ;;
      -c|--git-dir|--work-tree|--namespace|--exec-path|--config-env) j=$((j+2)) ;;
      -*) j=$((j+1)) ;;
      *) sub=$w; j=$((j+1)); break ;;
    esac
  done
  local staged=0 worktree=0 cached=0 report=0 apply=0 npre=0
  while [ $j -lt "$n" ]; do
    w=${a[$j]}; j=$((j+1))
    if [ $opts -eq 1 ]; then
      case "$sub:$w" in
        *:--) opts=0; dd=1; npre=${#ops[@]}; continue ;;
        checkout:-b|checkout:-B|checkout:--orphan|restore:-s|restore:--source) j=$((j+1)); continue ;;
        restore:-S|restore:--staged) staged=1; continue ;;
        restore:-W|restore:--worktree) worktree=1; continue ;;
        restore:-*W*) worktree=1; case "$w" in *S*) staged=1 ;; esac; continue ;;
        restore:-*S*) staged=1; continue ;;
        apply:--cached) cached=1; continue ;;
        apply:--check|apply:--stat|apply:--numstat|apply:--summary) report=1; continue ;;
        apply:--apply) apply=1; continue ;;
        apply:--directory|apply:--include|apply:--exclude|apply:--whitespace) j=$((j+1)); continue ;;
        *:-*) continue ;;
      esac
    fi
    ops+=("$w")
  done
  case "$sub" in
    checkout)
      if [ $dd -eq 1 ]; then
        # `git checkout [<tree-ish>] -- <paths>`: only what follows -- is a path
        for x in ${ops[@]+"${ops[@]:$npre}"}; do _wt_emit "$x"; done
      elif [ ${#ops[@]} -ge 2 ]; then
        for x in "${ops[@]:1}"; do _wt_emit "$x"; done
      elif [ ${#ops[@]} -eq 1 ] && [ "${_WT_IND:-0}" = 1 ]; then
        _wt_emit "${ops[0]}"
      fi ;;
    restore)
      if [ $staged -eq 0 ] || [ $worktree -eq 1 ]; then
        for x in ${ops[@]+"${ops[@]}"}; do _wt_emit "$x"; done
      fi ;;
    apply)
      if [ $cached -eq 0 ] && { [ $report -eq 0 ] || [ $apply -eq 1 ]; }; then
        if [ ${#ops[@]} -gt 0 ]; then
          for x in "${ops[@]}"; do _wt_indirect patch "$x"; done
        else
          # a `<` input is opened by the shell, in its directory, not -C's
          local gbase=$_WT_BASE
          _WT_BASE=$saved
          for x in ${_WT_INPUTS[@]+"${_WT_INPUTS[@]}"}; do _wt_indirect patch "$x" "$gbase"; done
          _WT_BASE=$gbase
          _wt_inline_patch
        fi
      fi ;;
  esac
  _WT_BASE=$saved
  return 0
}

# tar: in create/append mode (c r u) the archive is a direct target; in
# extract mode (x, not -O) an `indirect` tar record names the archive (or the
# `<` input), the directory (-C / --directory, else the base) and
# --strip-components. Old-style bundles (`tar xzf a.tgz`) are read. An archive
# from a pipe (`curl .. | tar -x`) is not seen.
_wt_tar() {
  local a=("$@") j=0 n=$# w c r mode="" arch="" dir="" strip=0 stdout=0 want=() v
  if [ "$n" -gt 0 ] && [[ ${a[0]} =~ ^[A-Za-z]+$ ]]; then
    r=${a[0]}; j=1
    while [ -n "$r" ]; do
      c=${r:0:1}; r=${r:1}
      case "$c" in
        x) mode=x ;; c|r|u) mode=c ;; t) mode=t ;; O) stdout=1 ;;
        f|C|b|T|X|s|I|F|g|H|K|L|N|V) want+=("$c") ;;
      esac
    done
    for c in ${want[@]+"${want[@]}"}; do
      v=${a[$j]:-}; j=$((j+1))
      case "$c" in f) arch=$v ;; C) dir=$v ;; esac
    done
  fi
  while [ $j -lt "$n" ]; do
    w=${a[$j]}; j=$((j+1))
    case "$w" in
      --) break ;;
      --extract|--get) mode=x ;;
      --create|--append|--update|--catenate|--concatenate) mode=c ;;
      --list) mode=t ;;
      --to-stdout) stdout=1 ;;
      --file=*) arch=${w#--file=} ;;
      --directory=*) dir=${w#--directory=} ;;
      --strip-components=*) strip=${w#--strip-components=} ;;
      --file) arch=${a[$j]:-}; j=$((j+1)) ;;
      --directory) dir=${a[$j]:-}; j=$((j+1)) ;;
      --strip-components) strip=${a[$j]:-}; j=$((j+1)) ;;
      --*) ;;
      -?*)
        r=${w#-}
        while [ -n "$r" ]; do
          c=${r:0:1}; r=${r:1}
          case "$c" in
            x) mode=x ;; c|r|u) mode=c ;; t) mode=t ;; O) stdout=1 ;;
            f|C|b|T|X|s|I|F|g|H|K|L|N|V)
              if [ -n "$r" ]; then v=$r; else v=${a[$j]:-}; j=$((j+1)); fi
              case "$c" in f) arch=$v ;; C) dir=$v ;; esac
              break ;;
          esac
        done ;;
    esac
  done
  [[ $strip =~ ^[0-9]+$ ]] || strip=0
  case "$mode" in
    c) [ -n "$arch" ] && [ "$arch" != - ] && _wt_emit "$arch" ;;
    x) [ $stdout -eq 0 ] || return 0
       if [ -z "$arch" ] || [ "$arch" = - ]; then arch=${_WT_INPUTS[0]:-}; fi
       [ -n "$arch" ] && _wt_indirect tar "$arch" "$dir" "$strip" ;;
  esac
  return 0
}

# patch [options] [originalfile [patchfile]]: the original file when named
# (or -o's output instead); otherwise an `indirect` record for the patch
# (-i, a `<` input, or a heredoc/here-string), with -d's directory as its
# base. --dry-run and BSD's -C/--check write nothing.
_wt_patch() {
  local a=("$@") j=0 n=$# w ops=() input="" dir="" out="" dry=0 opts=1 saved=$_WT_BASE x
  while [ $j -lt "$n" ]; do
    w=${a[$j]}; j=$((j+1))
    if [ $opts -eq 1 ]; then
      case "$w" in
        --) opts=0; continue ;;
        --dry-run|--check|-C) dry=1; continue ;;
        -i|--input) input=${a[$j]:-}; j=$((j+1)); continue ;;
        --input=*) input=${w#--input=}; continue ;;
        -i?*) input=${w#-i}; continue ;;
        -d|--directory) dir=${a[$j]:-}; j=$((j+1)); continue ;;
        --directory=*) dir=${w#--directory=}; continue ;;
        -d?*) dir=${w#-d}; continue ;;
        -o|--output) out=${a[$j]:-}; j=$((j+1)); continue ;;
        --output=*) out=${w#--output=}; continue ;;
        -o?*) out=${w#-o}; continue ;;
        -p|-F|-B|-D|-r|-V|-Y|-z|-g|-x) j=$((j+1)); continue ;;
        -?*) continue ;;
      esac
    fi
    ops+=("$w")
  done
  [ $dry -eq 0 ] || return 0
  if [ -n "$dir" ]; then
    if _wt_resolve "$dir"; then _WT_BASE=$_WT_R; else _WT_BASE=$_WT_UNKNOWN; fi
  fi
  if [ -n "$out" ]; then _wt_emit "$out"
  elif [ ${#ops[@]} -gt 0 ]; then _wt_emit "${ops[0]}"
  elif [ -n "$input" ]; then _wt_indirect patch "$input"
  else
    # a `<` input is opened by the shell, in the shell's directory, not -d's
    local pbase=$_WT_BASE
    _WT_BASE=$saved
    for x in ${_WT_INPUTS[@]+"${_WT_INPUTS[@]}"}; do _wt_indirect patch "$x" "$pbase"; done
    _WT_BASE=$pbase
    _wt_inline_patch
  fi
  _WT_BASE=$saved
  return 0
}

# ex/vi/vim/nvim [options] files, ed [options] file: an editor run from a
# command line (`ex -sc 'wq' f`, `vim -es`) writes the files it names. Not with
# -R or -M (read-only). -c/-S/-u/... take an argument; -s does too in vim's
# normal mode (a script), but not in ex mode (-e, -E, `ex`), where it is silent.
_wt_editor() {
  local verb=$1; shift
  local a=("$@") j=0 n=$# w c r exm=0 ro=0 opts=1 ops=() x
  case "$verb" in ex|ed) exm=1 ;; esac
  while [ $j -lt "$n" ]; do
    w=${a[$j]}; j=$((j+1))
    if [ $opts -eq 1 ]; then
      case "$w" in
        --) opts=0; continue ;;
        +*|-) continue ;;
        --cmd|--startuptime|--log|--servername|--listen) j=$((j+1)); continue ;;
        --*) continue ;;
        -?*)
          r=${w#-}
          while [ -n "$r" ]; do
            c=${r:0:1}; r=${r:1}
            case "$c" in
              e|E) exm=1 ;;
              R|M) ro=1 ;;
              s) [ $exm -eq 1 ] && continue
                 [ -n "$r" ] || j=$((j+1)); break ;;
              p) [ "$verb" = ed ] || continue
                 [ -n "$r" ] || j=$((j+1)); break ;;
              c|S|u|U|i|T|w|W|t|q)
                 [ -n "$r" ] || j=$((j+1)); break ;;
            esac
          done
          continue ;;
      esac
    fi
    ops+=("$w")
  done
  [ $ro -eq 0 ] || return 0
  if [ "$verb" = ed ]; then
    [ ${#ops[@]} -gt 0 ] && _wt_emit "${ops[0]}"
    return 0
  fi
  for x in ${ops[@]+"${ops[@]}"}; do _wt_emit "$x"; done
  return 0
}

# One segment's words. Sets _WT_VERB, and updates _WT_BASE on `cd`, so it
# carries into later segments.
_wt_words() {
  local start=$1; shift
  local args=("$@") verb="" i=0 n=$# x rest=() operands=() k assigns=()
  _WT_VERB=""
  while [ $i -lt "$n" ]; do
    x=${args[$i]}; i=$((i+1))
    case "$x" in
      sudo|command|env|nohup|time|exec|builtin) continue ;;
      # a keyword before the verb: `if [[ a > b ]]` is still a [[ comparison
      if|elif|while|until|then|else|do|'!'|'{') continue ;;
      [A-Za-z_]*=*) assigns+=("$x"); continue ;;
      *) verb=${x##*/}; break ;;
    esac
  done
  if [ -z "$verb" ]; then
    # an assignment-only segment sets shell variables for the segments after
    # it; `D=x cmd $D` does not (the shell expands $D before the assignment)
    for x in ${assigns[@]+"${assigns[@]}"}; do _wt_assign "$x"; done
    return 0
  fi
  _WT_VERB=$verb
  rest=(${args[@]+"${args[@]:$i}"})
  case "$verb" in
    sed|perl)
      "_wt_${verb}_args" ${rest[@]+"${rest[@]}"}
      if [ "$_WT_INPLACE" = 1 ]; then
        for x in ${_WT_OPS[@]+"${_WT_OPS[@]}"}; do _wt_emit "$x"; done
      fi
      return 0 ;;
    sqlite3)
      [ "${_WT_SQLITE:-0}" = 1 ] && _wt_sqlite_db ${rest[@]+"${rest[@]}"}
      return 0 ;;
    export|declare|typeset|local|readonly)
      for x in ${rest[@]+"${rest[@]}"}; do
        case "$x" in -*) ;; [A-Za-z_]*=*) _wt_assign "$x" ;; *) _wt_unset "$x" ;; esac
      done
      return 0 ;;
    for|select|read|unset|mapfile|readarray|getopts|printf)
      # these set a variable at run time: what it held before is no longer known
      for x in ${rest[@]+"${rest[@]}"}; do _wt_unset "$x"; done
      return 0 ;;
    git)   _wt_git ${rest[@]+"${rest[@]}"}; return 0 ;;
    tar|gtar|bsdtar) _wt_tar ${rest[@]+"${rest[@]}"}; return 0 ;;
    patch|gpatch) _wt_patch ${rest[@]+"${rest[@]}"}; return 0 ;;
    ex|vi|vim|nvim|ed) _wt_editor "$verb" ${rest[@]+"${rest[@]}"}; return 0 ;;
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
    tee|rm|unlink|truncate|touch|chmod|chown|chgrp|shred|mv|chattr)
      for x in ${operands[@]+"${operands[@]}"}; do _wt_emit "$x"; done ;;
    chflags)   # the first operand is the flags (nouchg), the rest are files
      for x in ${operands[@]+"${operands[@]:1}"}; do _wt_emit "$x"; done ;;
    cp|install|rsync|ln|scp|ditto)
      [ "$k" -gt 0 ] && _wt_emit "${operands[$((k-1))]}" ;;
    dd)
      for x in ${operands[@]+"${operands[@]}"}; do
        case "$x" in of=*) _wt_emit "${x#of=}" ;; esac
      done ;;
  esac
  return 0
}
