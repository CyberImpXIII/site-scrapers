#!/usr/bin/env bash
# Development helpers: the shell operations that get repeated while working on
# this repo, as subcommands instead of re-typed inline pipelines.
#
# Written because the same one-liners kept being re-authored from scratch —
# `./test.sh 2>&1 | grep -E "^# (tests|pass|fail)|^not ok"` a dozen times, two
# separate throwaway batch-verification scripts, several ad-hoc DB cleanups.
# Each rewrite costs tokens and risks a new quoting bug.
#
# The larger saving is on OUTPUT, not input: these print a few lines instead
# of the hundreds a raw command emits, so reading the result is cheap too.
#
#   ./dev.sh test [n]                       # run the suite (n times, for flake-checking); summary only
#   ./dev.sh run <target> '<params>' ...    # run recipes, one line each: success / count / first record
#   ./dev.sh verify <target> '<params>' ... # earn "working" for several recipes, one line each
#   ./dev.sh health                         # every recipe's observed rate, flagging status disagreements
#   ./dev.sh snap                           # save the current recipe list as a baseline
#   ./dev.sh new                            # recipes added since the last snap
#   ./dev.sh clean [--yes]                  # list (or remove) stray *.test / *.internal scaffolding recipes
#
# Pairs come as separate arguments: ./dev.sh run remotive.com '{}' nodesk.co '{"search":"qa"}'

set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="$HOME/.nvm/versions/node/v22.20.0/bin/node"
# Silences only node:sqlite's ExperimentalWarning. Real stderr stays visible:
# blanket across these helpers hid a "bad option: --yes" failure
# that showed up as a bare exit code 9 and nothing else.
export NODE_NO_WARNINGS=1
BASELINE="$DIR/data/.dev-baseline.json"
cd "$DIR"

usage() { sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }

cmd="${1:-}"; shift || true

case "$cmd" in
  test)
    n="${1:-1}"
    for i in $(seq 1 "$n"); do
      # Failing test names are kept: a bare pass/fail count tells you
      # something broke without telling you what, which means running it again.
      ./test.sh 2>&1 | grep -E '^# (tests|pass|fail)|^not ok' \
        | tr '\n' ' ' | sed "s|^|run $i: |"
      echo
    done
    ;;

  run|verify)
    [ $# -ge 2 ] || usage
    script=$([ "$cmd" = verify ] && echo verify.js || echo lab.js)
    while [ $# -ge 2 ]; do
      target="$1"; params="$2"; shift 2
      if [ "$cmd" = verify ]; then
        "$NODE_BIN" verify.js "$target" "$params"
      else
        "$NODE_BIN" lab.js peek "$target" "$params"
      fi | "$NODE_BIN" -e '
        let raw=""; process.stdin.on("data",d=>raw+=d).on("end",()=>{
          let d; try { d=JSON.parse(raw); } catch { console.log(`${process.argv[1]}  <no parseable output>`); return; }
          const t=(process.argv[1]||"").padEnd(42);
          if (d.verdict !== undefined) {
            console.log(`${t} ${d.verdict.padEnd(8)} records=${String(d.recordsExtracted).padEnd(5)} ${d.version||"-"} passingRun=${d.definitionHasPassingRun}`);
          } else {
            const first=(d.samples&&d.samples[0])||{};
            const label=first.title||first.href||Object.values(first)[0]||"";
            const where=d.failedStep?` step ${d.failedStep.index} ${d.failedStep.action} ${d.failedStep.selector||""}`
                      : d.failureContext?` waiting on ${d.failureContext.matcher&&d.failureContext.matcher.value}`
                      : d.error?` ${String(d.error).slice(0,60)}`:"";
            console.log(`${t} success=${String(d.success).padEnd(5)} n=${String(d.count??0).padEnd(4)}${d.partialResults?" PARTIAL":""} ${String(label).slice(0,44)}${where}`);
          }
        });' "$target"
    done
    ;;

  health)
    "$NODE_BIN" -e '
      const {openDb,getRecipeHealth}=require("./db");
      for (const r of getRecipeHealth(openDb())) {
        const key=`${r.hostname}#${r.page_type}:${r.recipe_name}`;
        const flag=r.statusDisagrees?"DISAGREES":r.neverRun?"never run":"";
        if (!flag && r.successRate===100) continue;   // only show what needs attention
        console.log(`${key.padEnd(52)} ${String(r.recentRuns).padStart(3)}runs ${String(r.successRate??"-").padStart(4)}%  ${r.status.padEnd(12)} ${flag}`);
      }
      console.log("(recipes at 100% omitted)");'
    ;;

  snap)
    "$NODE_BIN" -e '
      const fs=require("fs");const {openDb,listSites}=require("./db");
      const keys=listSites(openDb()).map(s=>`${s.hostname}#${s.page_type}:${s.recipe_name}`).sort();
      fs.writeFileSync(process.argv[1],JSON.stringify(keys));
      console.log(`baseline saved: ${keys.length} recipes`);' "$BASELINE"
    ;;

  new)
    [ -f "$BASELINE" ] || { echo "no baseline yet — run ./dev.sh snap first"; exit 1; }
    "$NODE_BIN" -e '
      const fs=require("fs");const {openDb,listSites}=require("./db");
      const base=new Set(JSON.parse(fs.readFileSync(process.argv[1],"utf8")));
      const now=listSites(openDb());
      const added=now.filter(s=>!base.has(`${s.hostname}#${s.page_type}:${s.recipe_name}`));
      const gone=[...base].filter(k=>!now.some(s=>`${s.hostname}#${s.page_type}:${s.recipe_name}`===k));
      for (const s of added) console.log(`  NEW  ${`${s.hostname}#${s.page_type}:${s.recipe_name}`.padEnd(52)} ${s.status}`);
      for (const k of gone) console.log(`  GONE ${k}`);
      console.log(`${base.size} -> ${now.length} recipes (+${added.length}, -${gone.length})`);' "$BASELINE"
    ;;

  clean)
    [ "${1:-}" = "--yes" ] && export DEV_CLEAN_YES=1
    # Scaffolding hostnames only. A recipe is never legitimately on a .test or
    # .internal host, so the pattern cannot catch a real one — but it still
    # lists before removing, and removing needs --yes.
    "$NODE_BIN" -e '
      const {openDb,listSites,deleteSite}=require("./db");
      const db=openDb();
      const doomed=listSites(db).filter(s=>/\.(test|internal)$/.test(s.hostname)||s.hostname==="127.0.0.1");
      if (!doomed.length) { console.log("no scaffolding recipes found"); process.exit(0); }
      const go=process.env.DEV_CLEAN_YES==="1";
      for (const s of doomed) {
        const key=`${s.hostname}#${s.page_type}:${s.recipe_name}`;
        if (go) { deleteSite(db,require("./db").getSite(db,s.hostname,s.page_type,s.recipe_name).id); console.log(`  removed ${key}`); }
        else console.log(`  would remove ${key}`);
      }
      if (!go) console.log(`${doomed.length} scaffolding recipes — re-run with --yes to remove`);'
    ;;

  *) usage ;;
esac
