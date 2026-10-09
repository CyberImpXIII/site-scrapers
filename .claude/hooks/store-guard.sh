#!/usr/bin/env bash
# hooks: applies_to=all
# A store is written only by its CLI. PreToolUse hook on Write, Edit,
# MultiEdit, NotebookEdit and Bash; see ../settings.json.
# Tests: bash .claude/hooks/test-store-guard.sh
#
# PLAN-services.md §3, "Every data store is gated and read-only", rule 3: one
# hook for every store, replacing PLAN-todo-tool.md §9's todo-only hook. A
# store is any file a `cli.json` names in its `store` (a path or a list of
# paths and globs, as tools/checks' schema/cli.schema.json has it). For each
# write target, every directory above it is looked at for a `cli.json`; each
# store it names is resolved against THAT directory (so the workspace top's
# `.claude/cli.json` names `.claude/agents.manifest.json`). Which session
# makes the write, and where it started, does not matter.
# A store no cli.json names yet is named in ../lib/extra-stores.sh, as a
# path relative to a repo root: it is resolved against every directory above
# the target that holds a CLAUDE.md (so `todo.json` is each repo's own
# store, not any file of that name in a folder no repo owns). Its block
# message names what really writes it.
#
# Blocked (exit 2): a write to a named store, or to its SQLite side files
# (`-wal`, `-shm`, `-journal`). The message names the CLI and its verbs.
# The CLI itself passes: a CLI that writes its own store does so inside its
# own process, which no hook sees; only the model's own command is read.
#
# Write/Edit/MultiEdit/NotebookEdit give the path exactly. A Bash command's
# targets come from ../lib/write-targets.sh with its `sqlite` and `indirect`
# opt-ins, which is HEURISTIC: it sees redirects, tee, sed -i, cp/mv onto, rm,
# chflags/chmod, git checkout/restore, ex/vim/ed on a file, a sqlite3 call
# unless opened -readonly, and a variable assigned a literal earlier in the
# same command (`D=.claude; sed -i x $D/m.json`). `indirect` adds what a
# patch or an archive will write: a `git apply`/`patch` file (read here) or
# inline patch (each path tried against the base and the git top, with every
# leading component stripped, so any -pN is covered), and a `tar -x` archive
# (listed here with `tar -tf`, members under -C, --strip-components applied).
#
# A target is matched three ways, so one store has one identity:
#   - lexically, against each store a cli.json above it names (and each
#     extra-stores entry, against each repo root above it);
#   - through its REAL path, the same way: every symlink, of the file or of a
#     directory above it, followed (a link outside the repo to a store);
#   - by identity: an existing target with the same device:inode as an
#     existing literal store (a case variant, a symlink, a hard link in the
#     same tree). On a case-insensitive directory (APFS), names also compare
#     without case, so a new `STATE/x` meets the `state/*` glob.
#
# Not seen (fails open): a script that writes the file itself; a path built
# at run time (`$(pwd)`, a variable not assigned a literal in the command);
# `rm -r` or `git checkout --` of the store's DIRECTORY; git switch/reset/
# stash/merge; an archive or patch fed through a pipe, or not on disk yet; a
# hard link from outside every tree whose cli.json names the store; a store
# outside every directory above it (tools/usage names `~/.claude/usage/...`,
# which no cli.json above those files names); a glob whose directory part
# holds a `*?[` character; a hard link to a GLOB store, or to an extra-stores
# entry from outside its repo. A store with no writer at all is in no list
# (see ../lib/extra-stores.sh). With write-targets.sh absent, Bash is let
# through (the Write tools are still held).
#
# INSTALLED INTO EVERY REPO'S .claude/hooks/, because a hook only fires when
# Claude Code's project dir is the one holding it. The source is tools/hooks
# (source/hooks/); `hooks copies` there fails when a copy differs from it.
# Change the source, never a copy.
#
# FAILS OPEN. Malformed input, no jq, a cli.json that does not parse, anything
# unexpected: exit 0. Exit 2 only for a write to a store a cli.json or the
# extra-stores list names. With extra-stores.sh absent, only cli.json stores.

set -o pipefail

input=$(cat 2>/dev/null) || exit 0
command -v jq >/dev/null 2>&1 || exit 0

tool=$(printf '%s' "$input" | jq -r '.tool_name | strings' 2>/dev/null) || exit 0
cwd=$(printf '%s' "$input" | jq -r '.cwd | strings' 2>/dev/null) || exit 0
[ -n "$cwd" ] || cwd=$PWD

lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)/../lib/write-targets.sh"
have_lib=0
[ -f "$lib" ] && . "$lib" 2>/dev/null && type bash_write_targets >/dev/null 2>&1 && have_lib=1
if [ $have_lib = 0 ]; then   # the Write tools' paths are real; join, never expand
  normpath() { case "$1" in /*) printf '%s' "$1" ;; *) printf '%s/%s' "${2%/}" "$1" ;; esac; }
fi

# The extra-stores list (../lib/extra-stores.sh): X_PAT, X_CLI, X_HOW. An
# entry that is absolute, `~`, climbs (`..`) or lacks a field is skipped.
X_PAT=(); X_CLI=(); X_HOW=()
xlib="${lib%/*}/extra-stores.sh"
if [ -f "$xlib" ] && . "$xlib" 2>/dev/null && type extra_stores >/dev/null 2>&1; then
  while IFS=$'\t' read -r xp xc xh; do
    case "$xp" in ''|/*|'~'*|..|../*|*/..|*/../*) continue ;; esac
    [ -n "$xc" ] && [ -n "$xh" ] || continue
    X_PAT+=("$xp"); X_CLI+=("$xc"); X_HOW+=("$xh")
  done < <(extra_stores 2>/dev/null)
fi

case "$tool" in
  Write|Edit|MultiEdit|NotebookEdit)
    targets=$(printf '%s' "$input" | jq -r '(.tool_input.file_path // .tool_input.notebook_path) | strings' 2>/dev/null) || exit 0
    how="this $tool" ;;
  Bash)
    [ $have_lib = 1 ] || exit 0
    cmd=$(printf '%s' "$input" | jq -r '.tool_input.command | strings' 2>/dev/null) || exit 0
    targets=$(bash_write_targets "$cmd" "$cwd" "sqlite indirect" 2>/dev/null)
    how="this command (as write-targets.sh reads it)" ;;
  *) exit 0 ;;
esac
[ -n "$targets" ] || exit 0

# ident <path>: device:inode of what it names (symlinks followed), or nothing.
if stat -L -c '%d:%i' / >/dev/null 2>&1; then
  ident() { stat -L -c '%d:%i' "$1" 2>/dev/null; }
else
  ident() { stat -L -f '%d:%i' "$1" 2>/dev/null; }
fi

# physdir <dir> -> PHYS: the directory with every symlink above it resolved;
# a part that does not exist yet is kept as written below the nearest one
# that does.
physdir() {
  local d=${1:-/} tail="" r
  while [ ! -d "$d" ] && [ "$d" != / ]; do
    tail=/${d##*/}$tail; d=${d%/*}; [ -n "$d" ] || d=/
  done
  r=$(cd -P "$d" 2>/dev/null && pwd -P) || r=$d
  PHYS=${r%/}$tail; [ -n "$PHYS" ] || PHYS=/
}

# real_of <absolute path> -> REAL: the path with every symlink followed, the
# file's own (up to 40 hops) and every directory's above it.
real_of() {
  local p=$1 n=0 l
  while :; do
    physdir "${p%/*}"; p=${PHYS%/}/${p##*/}
    [ -L "$p" ] && [ $n -lt 40 ] || break
    l=$(readlink "$p" 2>/dev/null) || break
    case "$l" in /*) p=$l ;; *) p=${PHYS%/}/$l ;; esac
    p=$(normpath "$p" / 2>/dev/null) || break
    n=$((n+1))
  done
  REAL=$p
}

# caseless <dir> <a file in it, lower-case where it has letters>: the
# directory's names compare without case (APFS, HFS+ by default).
caseless() {
  local up
  up=$(printf '%s' "$2" | tr '[:lower:]' '[:upper:]')
  [ "$up" != "$2" ] && [ -e "$1/$up" ] || return 1
  [ "$(ident "$1/$up")" = "$(ident "$1/$2")" ]
}

# A cli.json's lines: `cli<TAB>x`, `verbs<TAB>a b`, `store<TAB>p` per store.
# Nothing at all when it does not parse or is not an object (fails open).
read_cli() {
  jq -r 'if type == "object" then
      ("cli\t" + (.cli | strings)),
      ("verbs\t" + ((.verbs // []) | if type == "array" then map(strings) | join(" ") else "" end)),
      ((.store | if type == "string" then [.] elif type == "array" then . else [] end)[] | strings | "store\t" + .)
    else empty end' "$1" 2>/dev/null
}

# matches <target> <store, absolute and normalized>
matches() {
  local p=$1 s=$2 lit pat
  case "$s" in
    *[*?[]*)
      lit=${s%%[*?[]*}; lit=${lit%/*}; pat=${s:${#lit}}
      case "$lit" in *[*?[]*) return 1 ;; esac
      # shellcheck disable=SC2053
      [[ $p == "$lit"$pat ]] ;;
    *) [[ $p == "$s" ]] ;;
  esac
}

# hit <form> <its side-file base> <store> <caseless 0|1>
hit() {
  local rc=1
  [ "$4" = 1 ] && shopt -s nocasematch
  if matches "$1" "$3" || { [ "$2" != "$1" ] && matches "$2" "$3"; }; then rc=0; fi
  shopt -u nocasematch
  return $rc
}

block() {   # <target as given> <store> <dir holding cli.json> <cli> <verbs>
  local run="the CLI it names" what=$1
  [ -n "$4" ] && run="\`$(normpath "$4" "$3")\`"
  [ "$2" = "$1" ] || what="$1 (the store $2)"
  echo "store-guard: $how writes $what, a store that ${3%/}/cli.json names. A store has one way in, its CLI: run $run${5:+ (verbs: $5)} instead. A hand edit, a raw sqlite3 write or a shell write to it is refused (PLAN-services.md §3); for a read, \`sqlite3 -readonly\` or the CLI." >&2
  exit 2
}

block_extra() {   # <target as given> <store> <index in the list>
  local what=$1 run
  [ "$2" = "$1" ] || what="$1 (the store $2)"
  run="${X_HOW[$3]}"
  [ "${X_CLI[$3]}" != - ] && run="\`${X_CLI[$3]}\` (from the workspace top): ${X_HOW[$3]}"
  echo "store-guard: $how writes $what, a store the extra-stores list names (.claude/lib/extra-stores.sh; no cli.json names it yet). A store has one way in: $run. A hand edit, a raw sqlite3 write or a shell write to it is refused (PLAN-services.md §3)." >&2
  exit 2
}

# check_form <target as given> <form: the target or its real path> <ids>
check_form() {
  local p=$1 f=$2 ids=$3 base d dir key val cli verbs stores s sl ci sid k
  base=$f
  case "$f" in *-wal|*-shm|*-journal) base=${f%-*} ;; esac
  d=${f%/*}
  while :; do
    dir=${d:-/}
    if [ -f "$dir/cli.json" ]; then
      cli=""; verbs=""; stores=()
      while IFS=$'\t' read -r key val; do
        case "$key" in
          cli) cli=$val ;;
          verbs) verbs=$val ;;
          store) [ -n "$val" ] && stores+=("$val") ;;
        esac
      done < <(read_cli "$dir/cli.json")
      if [ ${#stores[@]} -gt 0 ]; then
        ci=0; caseless "$dir" cli.json && ci=1
        for s in "${stores[@]}"; do
          sl=$(normpath "$s" "$dir" 2>/dev/null) || continue
          [ -n "$sl" ] || continue
          if hit "$f" "$base" "$sl" $ci; then block "$p" "$sl" "$dir" "$cli" "$verbs"; fi
          # the same file under another name: a case variant, a symlink, a hard link
          case "$s" in *[*?[]*) continue ;; esac
          if [ -n "$ids" ] && sid=$(ident "$sl") && [ -n "$sid" ]; then
            case " $ids " in *" $sid "*) block "$p" "$sl" "$dir" "$cli" "$verbs" ;; esac
          fi
        done
      fi
    fi
    # The extra-stores list, against each repo root above (a CLAUDE.md there).
    if [ ${#X_PAT[@]} -gt 0 ] && [ -f "$dir/CLAUDE.md" ]; then
      ci=0; caseless "$dir" claude.md && ci=1
      for k in "${!X_PAT[@]}"; do
        sl=${dir%/}/${X_PAT[$k]}
        if hit "$f" "$base" "$sl" $ci; then block_extra "$p" "$sl" "$k"; fi
        case "${X_PAT[$k]}" in *[*?[]*) continue ;; esac
        if [ -n "$ids" ] && sid=$(ident "$sl") && [ -n "$sid" ]; then
          case " $ids " in *" $sid "*) block_extra "$p" "$sl" "$k" ;; esac
        fi
      done
    fi
    [ -n "$d" ] || break
    d=${d%/*}
  done
  return 0
}

check_target() {   # <absolute target>; exits 2 on a store
  local p=$1 ids="" i b
  i=$(ident "$p") && ids=$i
  case "$p" in *-wal|*-shm|*-journal) b=${p%-*}; i=$(ident "$b") && ids="$ids $i" ;; esac
  check_form "$p" "$p" "$ids"
  real_of "$p"
  [ "$REAL" = "$p" ] || check_form "$p" "$REAL" "$ids"
  return 0
}

# A path a patch names, relative to <base>: tried against the base and its git
# top, whole and with each leading component stripped (any -pN).
GT_BASE=""; GT_TOP=""
check_patch_path() {   # <path as the patch writes it> <base>
  local p=$1 b=$2 roots t rest
  [ -n "$p" ] || return 0
  case "$p" in /*) check_target "$(normpath "$p" /)"; return 0 ;; esac
  if [ "$GT_BASE" != "$b" ]; then
    GT_BASE=$b; GT_TOP=$(git -C "$b" rev-parse --show-toplevel 2>/dev/null) || GT_TOP=""
  fi
  roots=("$b"); [ -n "$GT_TOP" ] && [ "$GT_TOP" != "$b" ] && roots+=("$GT_TOP")
  rest=$p
  while :; do
    for t in "${roots[@]}"; do check_target "$(normpath "$rest" "$t")"; done
    case "$rest" in */*) rest=${rest#*/} ;; *) break ;; esac
  done
  return 0
}

MAXREAD=$((64 * 1024 * 1024))   # a patch or archive larger than this is not read
small_file() {
  local sz
  [ -f "$1" ] && [ -r "$1" ] || return 1
  sz=$(wc -c < "$1" 2>/dev/null | tr -d ' ') || return 1
  [ -n "$sz" ] && [ "$sz" -le "$MAXREAD" ]
}

# Each line is a target path, or (Bash only) an indirect record from the lib.
first_how=$how
while IFS= read -r line; do
  [ -n "$line" ] || continue
  kind=path
  if [ "$tool" = Bash ]; then
    case "$line" in patch$'\t'*) kind=patch ;; ppath$'\t'*) kind=ppath ;; tar$'\t'*) kind=tar ;; esac
  fi
  case "$kind$line" in
    path*)
      how=$first_how
      p=$(normpath "$line" "$cwd" 2>/dev/null) || continue
      check_target "$p" ;;
    patch*)
      IFS=$'\t' read -r _ f b <<< "$line"
      how="this command's patch ($f)"
      small_file "$f" || continue
      while IFS= read -r pp; do check_patch_path "$pp" "$b"; done < <(patch_paths < "$f" 2>/dev/null) ;;
    ppath*)
      IFS=$'\t' read -r _ pp b <<< "$line"
      how="this command's inline patch"
      check_patch_path "$pp" "$b" ;;
    tar*)
      IFS=$'\t' read -r _ f b strip <<< "$line"
      how="this command's archive ($f)"
      small_file "$f" || continue
      while IFS= read -r m; do
        m=${m#/}; k=0
        while [ "$k" -lt "${strip:-0}" ]; do
          case "$m" in */*) m=${m#*/} ;; *) m="" ;; esac; k=$((k+1))
        done
        [ -n "$m" ] || continue
        check_target "$(normpath "$m" "$b")"
      done < <(tar -tf "$f" 2>/dev/null) ;;
  esac
done <<< "$targets"
exit 0
