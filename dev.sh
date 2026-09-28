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
#   ./dev.sh check                          # THE PRE-COMMIT GATE: suite + offline audit + working tree
#   ./dev.sh test [n]                       # run the suite (n times, for flake-checking); summary only
#   ./dev.sh audit                          # offline audit findings, one line each (silent = clean)
#   ./dev.sh run <target> '<params>' ...    # run recipes, one line each: success / count / first record
#   ./dev.sh verify <target> '<params>' ... # earn "working" for several recipes, one line each
#   ./dev.sh inside <url> '<card_sel>' [--wait=MS] [--all]  # what is inside a card, as field candidates
#   ./dev.sh apply <target> <file.json> '<params>'          # lab.js set, then peek, to see what it did
#   ./dev.sh health                         # every recipe's observed rate, flagging status disagreements
#   ./dev.sh blocked                        # what is waiting on the user vs. waiting on a person each run
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

usage() { sed -n '2,29p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }

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

  check)
    # The three things run before every commit, as one command. CLAUDE.md has
    # said to run the suite and the offline audit before committing since long
    # before this existed, and they were still being chained by hand every
    # time -- which is how one of them gets dropped when the other is slow.
    #
    # Exits non-zero if the suite fails, so it can gate rather than just report.
    echo "-- suite"
    suite=$(./test.sh 2>&1 | grep -E '^# (tests|pass|fail)|^not ok' | tr '\n' ' ')
    echo "   $suite"
    echo "-- offline audit"
    "$0" audit | sed 's/^/   /'
    echo "-- working tree"
    if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
      git status --short | sed 's/^/   /'
      echo "   (stage only your own paths if another session's work is here)"
    else
      echo "   clean"
    fi
    case "$suite" in *"# fail 0"*) ;; *) echo "SUITE FAILED — do not commit"; exit 1 ;; esac
    ;;

  audit)
    # The offline checks, as findings rather than a JSON document. Prints
    # nothing when clean, which is the point: `node audit.js units` emits a
    # wrapper object either way, so "is it clean" needs reading rather than
    # looking.
    "$NODE_BIN" audit.js units | "$NODE_BIN" -e '
      let raw=""; process.stdin.on("data",d=>raw+=d).on("end",()=>{
        const d=JSON.parse(raw);
        for (const f of d.unitInvariants||[]) console.log(`${f.severity.toUpperCase().padEnd(5)} ${f.unit.padEnd(52)} ${f.problem}`);
        if (!(d.unitInvariants||[]).length) console.log("units: clean");
      });'
    ;;

  inside)
    # The card-anatomy read, condensed to the three facts that decide a
    # child_text field. Written after hand-authoring the same ~100-char jq
    # filter four times while migrating four recipes -- which is the inline
    # blob CLAUDE.md prohibits, just in jq instead of node -e.
    #
    # lab.js itself must keep emitting JSON (test/cli.test.js calls that "the
    # jq contract"), so the human-readable layer belongs here.
    [ $# -ge 2 ] || usage
    url="$1"; sel="$2"; shift 2
    wait_arg=""; show_all=0
    for a in "$@"; do
      case "$a" in --wait=*) wait_arg="$a" ;; --all) show_all=1 ;; esac
    done
    "$NODE_BIN" lab.js inside "$url" "$sel" $wait_arg | ALL=$show_all "$NODE_BIN" -e '
      let raw=""; process.stdin.on("data",d=>raw+=d).on("end",()=>{
        let d; try { d=JSON.parse(raw); } catch { console.log(raw.slice(0,400)); return; }
        const a=d.cardAnatomy||{};
        if (a.error) { console.log(`ERROR ${a.error} (cardCount=${a.cardCount})`); return; }
        console.log(`cards=${a.cardCount} sampled=${a.cardsSampled}`);
        const all=process.env.ALL==="1";
        for (const p of a.parts||[]) {
          // everyCard + varies is the field candidate; the rest is optional
          // elements and static labels, which --all keeps because an optional
          // element is still worth KNOWING about -- it just must not be a
          // positional anchor.
          if (!all && !(p.everyCard && p.varies)) continue;
          console.log(`${p.selector}  [in ${p.presentIn}, ${p.maxPerCard}/card${p.varies?"":", STATIC"}]`);
          if (p.positions) for (const q of p.positions) console.log(`    [${q.index}] ${q.samples.join(" | ").slice(0,110)}`);
          else console.log(`    ${(p.samples||[]).join(" | ").slice(0,110)}`);
        }
        if (!all) console.log("(only everyCard+varies shown; --all for optional elements and static labels)");
      });'
    ;;

  apply)
    # set-then-peek. Changing fields and immediately looking at what they now
    # extract is one operation in practice -- the four recipe migrations found
    # four WRONG values in the peek, not in the set.
    [ $# -ge 2 ] || usage
    target="$1"; deffile="$2"; params="${3:-{\}}"
    "$NODE_BIN" lab.js set "$target" "@$deffile" | "$NODE_BIN" -e '
      let raw=""; process.stdin.on("data",d=>raw+=d).on("end",()=>{
        const d=JSON.parse(raw);
        if (!d.success) { console.log(`SET FAILED: ${d.error||JSON.stringify(d).slice(0,200)}`); process.exit(1); }
        console.log(`set ${process.argv[1]} -> ${d.version} (changed: ${(d.changed||[]).join(", ")||"nothing"}${d.gate&&d.gate.rolledBack?", ROLLED BACK":""})`);
      });' "$target" || exit 1
    # ONE run, not two: `dev.sh run` and `lab.js peek` both scrape, and a
    # second live run to print the same facts is a minute of browser time for
    # nothing.
    "$NODE_BIN" lab.js peek "$target" "$params" | "$NODE_BIN" -e '
      let raw=""; process.stdin.on("data",d=>raw+=d).on("end",()=>{
        const d=JSON.parse(raw);
        console.log(`  success=${d.success} n=${d.count??0}${d.partialResults?" PARTIAL":""}${d.error?` ${String(d.error).slice(0,60)}`:""}`);
        // Field coverage is the part worth reading: a field that quietly went
        // to all nulls is the usual way a selector change goes wrong.
        for (const [k,v] of Object.entries(d.fieldCoverage||{})) console.log(`    ${k.padEnd(18)} ${v}`);
        const s=(d.samples||[])[0]; if (s) console.log(`    first: ${JSON.stringify(s).slice(0,220)}`);
      });'
    ;;

  blocked)
    # What is waiting on the USER, separated from what is waiting on work.
    # The point of blocked-attn is that nobody should keep retrying it, so it
    # has to be listable — otherwise it is invisible until someone trips over it.
    "$NODE_BIN" -e '
      const {openDb,listSites,getSite}=require("./db");
      const db=openDb();
      const rows=listSites(db).filter(s=>s.status==="blocked"||s.status==="blocked-attn");
      if(!rows.length){console.log("nothing blocked");process.exit(0);}
      for(const kind of ["blocked-attn","blocked"]){
        const group=rows.filter(r=>r.status===kind);
        if(!group.length) continue;
        console.log(kind==="blocked-attn"
          ? "\nNEEDS YOU — troubleshooting stalled, do not retry these:"
          : "\nNEEDS A PERSON EACH RUN — recipe believed correct, run attended:");
        for(const r of group){
          const full=getSite(db,r.hostname,r.page_type,r.recipe_name);
          console.log(`  ${r.hostname}#${r.page_type}:${r.recipe_name}`);
          const n=(full.notes||"").trim();
          console.log(`     ${n ? n.slice(0,300) : "(no notes — a blocked-attn recipe should say what is needed)"}`);
        }
      }'
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
