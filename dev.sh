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
#   ./dev.sh waive <target> <rule> '<what you checked>'     # record that an audit warning was checked and does not apply
#   ./dev.sh board <company> ...            # which ATS hosts each company's job board (one cheap HTTP check each)
#   ./dev.sh page <hostname>                # what is already known about this page, before you open a browser
#   ./dev.sh hooks [--sync]                 # verify the hook layer across every tool folder (--sync pushes this repo's copies)
#   ./dev.sh known <hostname>               # every recipe registered for a hostname, as "target<TAB>status"
#   ./dev.sh failures <hostname>            # what has broken here before, one line each, best match first
#   ./dev.sh browser-ok [minutes]           # allow interactive browsing of a covered site for N minutes (default 15)
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

# Prints the header comment block -- however long it is. This was `sed -n
# '2,34p'`, a hardcoded line range that had to be bumped by hand every time a
# subcommand was documented, and was bumped wrong three times in one session:
# the help silently truncated mid-list, which is the failure mode where the tool
# still runs and just stops telling you what it can do.
usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 1; }

# Where `browser-ok` writes its marker. Under data/, which is gitignored, so an
# override never travels to anyone else's clone.
BROWSER_OK="$DIR/data/.browser-ok"

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
    # test.sh is already quiet, so a clean run collapses to one line here. When
    # it fails, print what it said IN FULL -- the assertion, the diff and the
    # file:line. It used to be grepped down to the failing test's name, which
    # told you something broke and then made you run it again to find out what.
    suiteout=$(./test.sh 2>&1); suiterc=$?
    if [ "$suiterc" = 0 ]; then
      printf '   %s\n' "$(printf '%s' "$suiteout" | tr '\n' ' ')"
    else
      printf '%s\n' "$suiteout" | sed 's/^/   /'
    fi
    echo "-- offline audit"
    "$0" audit | sed 's/^/   /'
    # The hook layer, which enforces three rules and until now had none of the
    # guarantees it provides. Reported here rather than left to be remembered,
    # for the same reason the audit is.
    echo "-- hooks"
    hookout=$("$DIR/check-hooks.sh" 2>&1); hookrc=$?
    if [ "$hookrc" = 0 ]; then
      printf '%s\n' "$hookout" | tail -1 | sed 's/^/   /'
    else
      printf '%s\n' "$hookout" | grep -E '^  (ERROR|note)' | sed 's/^ */   /'
      printf '%s\n' "$hookout" | tail -1 | sed 's/^/   /'
    fi
    echo "-- working tree"
    if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
      git status --short | sed 's/^/   /'
      echo "   (stage only your own paths if another session's work is here)"
    else
      echo "   clean"
    fi
    # Gates on test.sh's own exit code rather than on matching "# fail 0" in
    # its text: a run that dies before printing a summary has no such line, and
    # a string match would have read that as a pass.
    [ "$suiterc" = 0 ] || { echo "SUITE FAILED — do not commit"; exit 1; }
    ;;

  audit)
    # The offline checks, as findings rather than a JSON document. Prints
    # nothing when clean, which is the point: `node audit.js units` emits a
    # wrapper object either way, so "is it clean" needs reading rather than
    # looking.
    "$NODE_BIN" audit.js units | "$NODE_BIN" -e '
      let raw=""; process.stdin.on("data",d=>raw+=d).on("end",()=>{
        const d=JSON.parse(raw);
        for (const f of d.unitInvariants||[]) {
          // A waived finding is one already checked against the live site, so
          // it reads as settled rather than outstanding -- otherwise the next
          // session re-investigates it, which is the whole reason waivers
          // exist. The reason and the date are shown so a stale one is
          // visible as stale rather than trusted forever.
          const tag = f.waived ? "OK/W" : f.severity.toUpperCase();
          console.log(`${tag.padEnd(5)} ${f.unit.padEnd(52)} ${f.problem}`);
          if (f.waived) console.log(`      waived ${f.waived.on}: ${f.waived.reason}`);
        }
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

  page)
    # Everything already known about a page, as lines. Read this BEFORE
    # building a second recipe on a host that already has one -- three pages
    # here carry two recipes each and every pair was characterised twice,
    # because nothing connected them.
    [ $# -ge 1 ] || usage
    "$NODE_BIN" primitives.js show "$1" | "$NODE_BIN" -e '
      let raw=""; process.stdin.on("data",d=>raw+=d).on("end",()=>{
        const d=JSON.parse(raw);
        if (d.success === false) { console.log(d.error); process.exit(1); }
        for (const p of d.pages) {
          console.log(`\n${p.page}`);
          for (const r of p.recipes) console.log(`  recipe   ${r.pageType.padEnd(8)} ${r.status}`);
          for (const [k,v] of Object.entries(p.flags)) console.log(`  FLAG     ${k}: ${v}`);
          const declared = Object.keys(p.params.declared);
          if (declared.length) console.log(`  params   ${declared.join(", ")}`);
          for (const [who,vals] of Object.entries(p.params.knownWorkingValues)) {
            console.log(`  known    ${who}: ${JSON.stringify(vals[0]).slice(0,90)}`);
          }
          for (const a of p.genericActions) {
            // A measurement outrules an inference, so it leads when present.
            const m = a.measured;
            const said = m
              ? `MEASURED ${m.outcome}${m.timesObserved>1?` x${m.timesObserved}`:""}${m.stale?" (STALE)":""} — ${m.detail}`
              : a.evidence;
            console.log(`  action   ${a.action.padEnd(22)} ${said}`);
          }
          for (const f of p.knownFailures) {
            console.log(`  BROKE    [${f.type}] x${f.occurrences} -> ${(f.resolution||"no resolution recorded").slice(0,100)}`);
          }
        }
      });' || exit 1
    ;;

  hooks)
    # The hook layer checked like everything else here. See check-hooks.sh for
    # what it verifies and why the hook layer needed its own guard.
    "$DIR/check-hooks.sh" "$@"
    ;;

  known)
    # Every recipe registered for a hostname, as "target<TAB>status".
    #
    # `query.js site <host>` answers for ONE page_type (listing by default), so
    # it cannot answer "is anything registered for this host" -- a host with
    # only an article recipe reads as unknown. Both PreToolUse hooks need
    # exactly that question, and a jq program duplicated into two hook scripts
    # is the thing this file exists to prevent.
    #
    # Silent with no match, so a caller can test it with `[ -n "$(...)" ]`.
    [ $# -ge 1 ] || usage
    "$NODE_BIN" -e '
      const {openDb,listSites}=require("./db");
      const host=String(process.argv[1]||"").replace(/^www\./,"").toLowerCase();
      if(!host) process.exit(0);
      for(const s of listSites(openDb())){
        const h=String(s.hostname||"").replace(/^www\./,"").toLowerCase();
        // Suffix match so a recipe on the bare domain also answers for a
        // subdomain the caller happened to be given, but "notglassdoor.com"
        // never matches "glassdoor.com".
        if(h===host||host.endsWith("."+h)||h.endsWith("."+host)){
          console.log(`${s.hostname}#${s.page_type}:${s.recipe_name}\t${s.status}`);
        }
      }
    ' "$1" 2>/dev/null
    ;;

  failures)
    # What has broken on this host before, one line each. docs/diagnosing.md
    # opens by telling you to check this before re-deriving anything, and the
    # troubleshooting hook prints it for you when you are about to edit a
    # recipe -- so it has to be a line-oriented summary, not the raw JSON.
    #
    # Silent with no match, so a caller can test it with `[ -n "$(...)" ]`.
    [ $# -ge 1 ] || usage
    "$NODE_BIN" failures.js match "$1" 2>/dev/null | jq -r '
      .matches[]? |
      "  score=\(.score) [\(.failure_type)] \(.hostname) (seen \(.occurrences)x) -> \(.resolution // "NO RESOLUTION RECORDED")"
    ' 2>/dev/null
    ;;

  browser-ok)
    # Deliberately allow interactive browsing of a site that already has a
    # working recipe, for a few minutes.
    #
    # The prefer-recipes hook blocks that by default, because reaching for a
    # browser on a covered site is the expensive habit this whole project
    # exists to replace. But there are real reasons to need one -- BUILDING a
    # second recipe for the same host, confirming a wall, an attended handoff --
    # and a block with no way past it would be worse than the habit.
    #
    # Time-limited rather than a permanent flag: an override that outlives the
    # reason for it is just the hook switched off.
    mins="${1:-15}"
    case "$mins" in ''|*[!0-9]*) echo "minutes must be a number"; exit 1 ;; esac
    mkdir -p "$DIR/data"
    date +%s > "$BROWSER_OK"
    echo "interactive browsing allowed for ${mins}m (marker: data/.browser-ok)"
    echo "$mins" >> "$BROWSER_OK"
    ;;

  board)
    # Which ATS hosts a company's job board. The ATS listing recipes are
    # parameterised by company slug, so the only thing needed to point one at a
    # new employer is the slug -- and the slug is a guess until something
    # confirms it.
    #
    # Written after guessing one wrong: a bad slug costs a full browser run that
    # fails with an unhelpful error, where an HTTP status answers it in well
    # under a second. Read-only GETs against public careers pages.
    #
    # A 200 alone is worthless here, which the first version of this got wrong:
    # Ashby, Workable and Recruitee all answer 200 for a slug that does not
    # exist, so five pro-audio companies came back "hosted on all three" --
    # confidently wrong output, which is worse than no helper. It reports the
    # TITLE and byte size as evidence instead, and marks the ones whose title
    # reads like a not-found page. Still a candidate rather than proof: only a
    # recipe run settles it.
    [ $# -ge 1 ] || usage
    for company in "$@"; do
      slug="$(printf '%s' "$company" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-//; s/-$//')"
      hit=0
      # Only platforms where a missing slug is DISTINGUISHABLE from a real one.
      # Deliberately dropped after measuring, because including them made every
      # answer a false positive:
      #   jobs.ashbyhq.com  - client-rendered, serves a byte-identical 9193-byte
      #                       shell titled "Jobs" for every slug, real or not
      #   <slug>.recruitee.com - any unknown slug redirects to Recruitee's own
      #                       marketing site, so every company "has" a board
      #   apply.workable.com - echoes the slug back capitalised as
      #                       "<Slug> - Current Openings", so figma (which is on
      #                       Greenhouse) reads as a Workable customer
      # Those three need a real page read, not a URL probe. A helper that
      # answers "yes" for everything is worse than not having one.
      for url in \
        "https://job-boards.greenhouse.io/$slug" \
        "https://boards.greenhouse.io/$slug" \
        "https://jobs.lever.co/$slug" \
        "https://$slug.breezy.hr"
      do
        body="$(curl -sL -m 15 "$url" 2>/dev/null)"
        [ -n "$body" ] || continue
        title="$(printf '%s' "$body" | tr '\n' ' ' | sed -n 's/.*<title[^>]*>\([^<]*\)<\/title>.*/\1/Ip' | sed 's/^ *//; s/ *$//' | cut -c1-58)"
        bytes="$(printf '%s' "$body" | wc -c | tr -d ' ')"
        # A not-found page names itself in the title far more reliably than in
        # the status code. Anchored to title text only -- a real board can
        # easily contain the string "404" somewhere in its markup.
        case "$(printf '%s' "$title" | tr '[:upper:]' '[:lower:]')" in
          *"not found"*|*404*|*"no longer"*|*"doesn't exist"*|*"does not exist"*|*"page not"*)
            printf '  %-46s SOFT-404  %s\n' "$url" "$title"; continue ;;
        esac
        printf '%-22s %-46s %7s  %s\n' "$slug" "$url" "$bytes" "${title:-<no title>}"
        hit=1
      done
      [ "$hit" = "1" ] || printf '%-22s no candidate board found\n' "$slug"
    done
    ;;

  waive)
    # Record that an audit warning was checked against the live site and does
    # not apply here, so the next session stops re-deriving it.
    #
    # This exists because writing the verification in prose did NOT work:
    # salesforce's descendant :has() was checked, the result written into the
    # recipe's notes, and `audit.js units` kept reporting it -- so it was
    # re-investigated twice more, reaching the same answer each time. The
    # waiver has to be in a form the audit itself reads.
    #
    # A subcommand rather than a hand-written `lab.js set`, because the notes
    # field runs to thousands of characters and appending one line to it by
    # hand means pasting the whole thing back through shell quoting -- which is
    # how a usajobs.gov note silently became a no-op once already.
    [ $# -ge 3 ] || usage
    target="$1"; rule="$2"; reason="$3"
    deffile="$(mktemp -t devwaive)"
    "$NODE_BIN" -e '
      const {openDb,getSite,parseSiteArg}=require("./db");
      // node -e has no script path, so argv[1] is already the first argument.
      const [,target,rule,reason,out]=process.argv;
      const {hostname,pageType,recipeName}=parseSiteArg(target);
      const site=getSite(openDb(),hostname,pageType,recipeName);
      if(!site){console.error(`no recipe for ${target}`);process.exit(1);}
      if(!/^[a-z0-9-]+$/.test(rule)){console.error(`rule must be a slug like descendant-has, got "${rule}"`);process.exit(1);}
      if(reason.trim().length<10){console.error("a waiver needs a real reason -- it is the only evidence it was actually checked");process.exit(1);}
      const notes=String(site.notes||"");
      // Refuse a second waiver for the same rule rather than stacking them:
      // two dates for one check makes the stale one indistinguishable.
      if(new RegExp("AUDIT-VERIFIED\\["+rule+"\\]","i").test(notes)){
        console.error(`${target} already records a waiver for [${rule}] -- edit the note instead of adding a second`);process.exit(2);
      }
      const line=`AUDIT-VERIFIED[${rule}] ${new Date().toISOString().slice(0,10)}: ${reason.replace(/\s+/g," ").trim()}`;
      require("fs").writeFileSync(out,JSON.stringify({notes:`${notes}\n${line}`.trim(),note:`waive ${rule}: ${reason}`}));
      console.log(line);
    ' "$target" "$rule" "$reason" "$deffile" || { rm -f "$deffile"; exit 1; }
    "$NODE_BIN" lab.js set "$target" "@$deffile" | "$NODE_BIN" -e '
      let raw=""; process.stdin.on("data",d=>raw+=d).on("end",()=>{
        const d=JSON.parse(raw);
        if (!d.success) { console.log(`WAIVE FAILED: ${d.error||JSON.stringify(d).slice(0,200)}`); process.exit(1); }
        console.log(`recorded on ${process.argv[1]} -> ${d.version}${d.gate&&d.gate.rolledBack?" (ROLLED BACK)":""}`);
      });' "$target"; rc=$?
    rm -f "$deffile"
    [ $rc -eq 0 ] || exit $rc
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
