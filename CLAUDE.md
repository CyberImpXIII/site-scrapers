# site-scrapers

A Puppeteer engine driven by a recipe database. Prefer it over interactive
browser tools for any site it knows. Recipes live in the DB, not in per-site code.

**This file is the rules. Detail lives in `docs/` — read the named file when you
start that kind of work, not preemptively.**

| doing this | read first |
|---|---|
| building or fixing a recipe | `docs/recipes.md` |
| a run failed, returned nothing, or returned the wrong thing | `docs/diagnosing.md` |
| changing the engine, a generic action, or anything that writes | `docs/architecture.md` |
| logins, sessions, or a step a person must do | `docs/handoffs.md` |
| what has already gone wrong on a site | `node failures.js match <hostname>` |
| **anything, if you have time to read one thing** | `docs/lessons.md` — mistakes already paid for once, and decisions deliberately NOT taken |
| starting fresh and wondering what to pick up | `TODO.md` — what is not done yet, and what is waiting on Jacob |

Recipe types (`page_type`): `listing` (repeated cards, the default), `article`
(one detail page), `action` (a parameterised automation). Address one as
`hostname#page_type:recipe_name`; both suffixes are optional and default to
`listing` / `default`.

The sections below are this repo's own; the shared rules every repo carries
follow them, between the `shared:rules` markers. Each own section is
classified (a gate, or prose with the reason no check can hold it) in
`gates.json`, which `test/gates-json.test.js` holds to the shared
`rules-gated` check.

---

## Rules

**1. Check before assuming — ENFORCED.** `node query.js site <target>` — `sites`
lists everything, and `./dev.sh known <hostname>` answers "is anything
registered for this host" across every page_type. A `working` recipe →
`./scrape.sh <target> '<json params>'`. Check the `success` field, not the exit
code. A `success:false` run can still carry records: if `partialResults` is
true, the wait expired but the data is there. A `forwarded` field means the
page landed on another site (a job-board slug whose company lists jobs on its
own site): `records` and `count` are then null, not 0 — nothing was read.

**This engine is the primary way to read a web page here, not a fallback.** A
`PreToolUse` hook (`.claude/hooks/prefer-recipes.sh`) refuses a WebFetch or a
Claude-in-Chrome navigation to any host with a `working` recipe, because that
path costs 8+ round trips (screenshots, an accessibility dump, chunked
extractions) for data one Bash call returns. A recipe that is `broken`,
`blocked` or `needs-review` does NOT block — there the browser may be the only
path left. When you genuinely need one on a covered host (building a second
recipe for it, confirming a wall, an attended handoff), open a window first:
`./dev.sh browser-ok` (15 minutes, or pass minutes). For an UNKNOWN site, use
the browser and then register what you learned.

Extracted rows come back as **`records`** (renamed from `jobs` on 2026-09-28 —
the engine is generic, so a product catalogue was arriving under `jobs` too).
Read them with `recordsOf()` from `lib/outputShape.js` rather than reaching for
the key, which also handles an `article` run's single record.

**A URL field is absolute** (since 2026-09-29). `anchor_attribute` resolves
`href`/`src`/`action` against the page's `baseURI`, so `record.href` is usable
without knowing which site produced it — dice and Ashby wrote them relative,
Greenhouse absolute, and every consumer was prefixing an origin defensively.
Only the standard URL attributes are resolved: a `data-job-id` stays exactly
as the site wrote it, because turning an id into a plausible URL is a wrong
value rather than a missing one. See `lib/urlAttrs.js`.

**1b. Building a SECOND recipe on a known host? Read the page first.**
`./dev.sh page <hostname>` pools what every existing recipe on that page already
knows: its flags (slow render, must-be-logged-out, needs a person mid-run), the
params and the values proven to work, which generic actions have demonstrably
run there, and what has broken on that host before. Three pages here already
carry two recipes each and every pair was characterised twice, because nothing
connected them. An action listed as "ran here via a working recipe" is evidence;
one absent from the list has never been tried here, which is not the same as not
working.

**Find out pre-emptively with `node primitives.js try <url>`.** It runs the
heuristic generic actions against a page — one page load each, so results
cannot depend on each other — and records what each one DID, judged by
comparing a page signature before and after. An action that no-ops cleanly is
not evidence that it works, which is the whole reason this is measured rather
than inferred from "it did not throw".

Outcomes: `changed` (the page moved) / `reported` (a diagnostic came back with
findings) / `no_effect` / `error`. `changed` means "this does something here",
not "this helped". A diagnostic action changes nothing by design, so it is
judged on what it reported instead — an action that emitted diagnostics is
judged on them, one that did not is judged on the page signature, so there is
no list of "which actions are probes" to drift.

**This is the fastest way to open an UNKNOWN page**, because the default trials
lead with the questions you have before a recipe exists. One command against
the Lever board returned a usable `card_selector`
(`div:has(div[data-qa="btn-apply"])` x20, shared line "Apply"), a consent
overlay that no recipe on that host handles, and anti-bot present but not
blocking.

Observations are **earned**: `recordObservation` is a guarded write and the
trial runner is its only sanctioned caller, so an outcome cannot be asserted by
hand. They go **stale** — `audit.js units` flags any older than 90 days,
because a measurement taken against a page that has since been redesigned
reads exactly like a current one. Re-measure, or `node primitives.js forget
<hostname>`.

**2. Writes are BLOCKED outside a sanctioned path.**

| to do this | use |
|---|---|
| edit a recipe | `node lab.js set <target> '{..., "note": "why"}'` |
| create one | `node register.js '<json>'` |
| set a status | `node verify.js <target> '<params>'` — earned by a run |
| record a diagnosed failure | `node failures.js record '<json>'` |
| write test fixtures | `authorizeForTests()` in the test's setup |

**Never use raw SQL or inline `node -e` to change data.** That path skips every
check and is the specific thing the guard exists to stop. Long or quote-heavy
JSON goes in a file: `node lab.js set <target> @path.json`.

**3. `status` is earned, never asserted.** Register as `needs-review`, then
verify.

| status | means |
|---|---|
| `working` | a run extracted records from this exact definition |
| `broken` | understood fault; ordinary work to fix |
| `blocked` | **the site** needs a person every run. Recipe is fine — do not re-derive |
| `blocked-attn` | **you** are stuck; the next step needs the user. Do NOT retry, that already failed — the CLI refuses an unattended run even with `allowUnverified` (`lib/blockedGuard.js`), and a hook blocks it earlier. Only `--attended` passes. Requires `notes` saying what only they can supply |

`./dev.sh blocked` lists what is waiting on the user.

**Three of these rules are ENFORCED by hooks, not advised** — rules 1, 3 and 4.
`node init.js` reports which are live. Each hook fails OPEN, because one that
broke every call would be worse than the habit it corrects.

| hook | blocks |
|---|---|
| `no-inline-blobs.sh` | `node -e`, `python3 -c`, heredocs feeding an interpreter (rule 4) |
| `prefer-recipes.sh` | a browser/WebFetch call on a host that has a `working` recipe (rule 1) |
| `troubleshooting.sh` | re-running a `blocked-attn` recipe without `--attended` (rule 3) |

These three live in one copy per tool folder — here, the top level, and every
sibling listed in `DECLARED` in `check-hooks.sh` (knowledge-base and applications included).
`./check-hooks.sh --sync` pushes this repo's; **if you change one, sync them
all.** A declared copy that is absent is an ERROR in the workspace (detected by
the top level's `.claude/agents.manifest.json`) and is printed as `UNCHECKED`,
and counted in the final line, on a standalone clone — never passed silently.
A new tool folder holding the hooks must be added to `DECLARED`. A folder with
no `settings.json` but a `settings.proposed.json` that is fit to apply (valid,
wires every twin there, each fails open) is still an ERROR, labelled
`[not applied yet]` and counted apart in the final line: copying it is Jacob's
step, never an agent's, and it is not drift. Identical
copies can still enforce nothing, because each finds site-scrapers from its own
folder (by `package.json` name — data-bridge also has `dev.sh` and `engine.js`),
so the check also RUNS every `prefer-recipes.sh` copy on a covered host and
requires a block. `SS_BROWSER_OK` moves the `browser-ok` marker for the hook and
`dev.sh` alike; the hook test uses a private one. The top level
also has hooks of its own that exist only there by design (the dispatcher's
delegation layer). `./check-hooks.sh` requires a twin only for the hooks this
repo registers or holds, so a new top-level-only hook needs no exception.

`troubleshooting.sh` also **prints this host's failure history** when you are
about to run `lab.js set` or `register.js` — the `node failures.js match` step
`docs/diagnosing.md` asks for first, done for you rather than demanded.

**4. Never write an inline script blob. This one is ENFORCED, not advised.**
A `PreToolUse` hook (`.claude/hooks/no-inline-blobs.sh`) blocks `node -e`,
`python3 -c` and heredocs feeding an interpreter, and warns on a jq program long
enough to be a script.

It is a hook because it was already a rule and that was not enough: the session
that wrote this rule then hand-authored the same 100-character jq filter four
times in a row. A blob costs full tokens on every rewrite, risks a fresh quoting
bug every time (it has already caused a silent no-op and a mangled commit
message here), and leaves nothing behind.

**The destination is always one of three, so you never have to invent one:**

| what you are doing | where it goes |
|---|---|
| a read or check you will repeat | a `./dev.sh` subcommand |
| anything touching the DB | the CLIs — never raw SQL |
| a genuine one-off | a script file, then run the file |

Use `jq` for short JSON filters and the **Edit** tool for files. If a jq
expression is long enough to need thought, it is a `dev.sh` subcommand you have
not written yet.

**5. Prove a parameter does something.** A recipe that accepts a param and
ignores it answers the wrong question silently — worse than failing. Give every
parameterised recipe `param_probe_values`; `node lab.js adopt-history <target>`
recovers real ones from run history. Then `node audit.js params`.

**6. The recipe is the unique document; the actions it performs are not.**
A recipe holds only what is specific to its site. Everything procedural belongs
in a parameterised generic action. Check `node query.js generic-actions` before
writing steps.

**7. Parallelise across processes, never inside one.** Collect with
`Promise.allSettled`, not `all`. **Never run two live audits or sweeps at once** —
contention produces browser-teardown errors ("detached Frame", "Target closed")
that look exactly like broken recipes. If a sweep reports `INFRA`, re-run alone
before concluding anything.

**8. Confirm before storing an action.** When navigating a page to *do* something
for the user, ask whether they want it stored as a reusable `action` recipe. Not
for read-only lookups.

---

## Commands

```
scrape.sh   <target> '<params>' [--raw] [--attended]   (= engine.js; --attended is the only way to run a blocked-attn recipe)
query.js    sites | site | runs | versions | diff | restore | promote | health
            generic-actions | expand | sessions | clear-session | debug-captures
            run-secrets   (scrape_runs rows holding a credential by key name or value shape; counts and names, never values)
lab.js      probe | sel | inside | match | peek | raw | set | params | history | adopt-history | new
            (probe/sel/inside/match take --wait=MS; the 5s default is too short for slow SPAs)
verify.js   <target> '<params>' [--dry] [--attended]
audit.js    units | inline | repeats | literals | hardcoded | provenance  (offline)
            params | working | fixed-params                              (LIVE, minutes)
failures.js match | record | common | list | types | signatures | probe-knowledge
primitives.js  pages | show <hostname> | try <url> | forget <hostname>
            what is known about a PAGE; `try` MEASURES which generic actions do anything there
dev.sh      check | test [n] | audit | run | verify | inside | apply | waive
            page | hooks | known | failures | board | browser-ok
            health | blocked | snap | new | clean
init.js     first-run setup after a clone
store.sh    export | import | verify [--db PATH]   the store's plain-file form in $DATA_REPO/site-scrapers/
            (cli.json; contract in lib/storeExport.js — no history, no runs, no credentials)
            register | set | verify-recipe | scrape | failures   the writers, forwarded unchanged
            (cli.json names both stores, data/scrapers.db and data/failures.db, so store-guard covers both)
```

`dev.sh` is the **human-readable layer** over those CLIs — they emit JSON by
contract (`test/cli.test.js` calls it "the jq contract"), `dev.sh` emits lines.
Reach for `dev.sh inside` rather than piping `lab.js inside` through jq, and if
the summary you want is not there, add it rather than filtering inline.

**Before committing: `./dev.sh check`** — suite, offline audit, hooks and working
tree in one command, exiting non-zero if the suite fails. An `error` from the audit
means something is already broken. `./dev.sh check --json` prints the same gates
as one document in the shared check schema (`devtools/checkjson.js`,
`test/check-json.test.js`) and is red on any gate's finding, not only the suite's.

**A warning you have checked gets waived, not re-derived.** `./dev.sh waive
<target> <rule> '<what you checked>'` writes an `AUDIT-VERIFIED[rule]` line the
audit itself reads, so it prints as `OK/W` with your evidence instead of as an
open finding. It never applies to an `error`, and the finding still appears —
this records an answer, it does not silence a check. Without it a verified
warning gets re-investigated every session, which is what happened to
salesforce's `:has()` three times.

---

## How the shared rules apply here

The shared rules (between the `shared:rules` markers below) hold here as
written. What they mean in this repo specifically:

- **Wall clock is not a cost; tokens are.** A Puppeteer run is headless, in a
  subprocess, and returns a few hundred bytes: a 60-second run returning 400
  bytes is cheaper than a 2-second one returning 40KB. `query.js efficiency`
  tracks `output_chars` for exactly this reason, and the README's "Why this
  saves tokens" is the same argument. "8 sequential page loads" is ordinary
  browsing, not something that provokes a site into blocking us.
- **The TODO.** Write it at the moment you notice it. Section 0 of `TODO.md`
  carries the proof: three items were spotted mid-session, called "worth
  noting", and never written down; one was a `lib/gate.js` defect.
- **Reporting to an owner has paid for itself here, both ways.** A `glassdoor`
  recipe reported as broken was not broken: a NULL `nav_params_schema` and a
  `kw_end` whose wrong value returns 5 records instead of 30 with
  `success:true`. A report the other way found an import script discarding
  good data on a non-zero exit code. A consumer reading the VALUES found three
  `remoteok` extraction faults every audit here passed. Consumers see what
  audits cannot: an audit checks that a run returned records, not that they
  are right.
- **Gate the seams: worked examples here** are `check-hooks.sh`,
  `test/hooks.test.js`, `audit.js units`, `lib/gate.js`, `lib/outputShape.js`,
  and `test/db-isolation.test.js` (the suite runs on snapshots of the stores
  and fails if the live ones change).
- **Git.** Commit and push to origin master right away -- don't wait to be
  asked, don't branch. `data/` is gitignored and stays that way.

## Absolute constraints

This repo's own, on top of the shared constraints in the block below.

- **Job applications are prepare-then-confirm, one yes per batch** (Jacob,
  2026-10-02: "One yes should cover a batch"). An agent may prepare
  applications end to end — open the form, fill every field, upload documents,
  answer the questions. It **stops before anything irreversible** and presents
  the prepared batch to Jacob: each application, its role and company, and the
  irreversible steps it involves (the submit, and creating an account wherever
  one is required). One explicit yes covers exactly what that presentation
  listed. Anything prepared after the yes — or left out of the presentation —
  needs its own yes. Nothing submits unattended.
- **Never** create an account, or do anything else public or irreversible —
  any other submit included — without Jacob's explicit yes first (for an
  application, a yes to a presented batch that listed it).
- **Never** enter real credentials without Jacob. He supplies them at run time
  (a caller param or a `handoff`); they are never stored.
- Credential-shaped values are caller-supplied params at run time, never written
  into a stored recipe.
- **Never** attempt to bypass bot detection. A detected wall means
  `blocked-attn` and an attended run — never a workaround.
- Captured handoff values go to gitignored mode-600 files. Report key names,
  never values, and don't ask the user to repeat them.

---

<!-- shared:rules@7867132c3871 -->
## Shared rules

This block is installed by the setup tool from its template. **Do not edit it
here:** setup reports an edit inside the markers as `edited locally` and will not
overwrite it. Change the template in the setup tool, then re-run setup in each
repo. A rule that belongs to this repo alone goes outside the markers.

## Never write an inline script blob — ENFORCED, not advised

A `PreToolUse` hook (`.claude/hooks/no-inline-blobs.sh`) blocks `python3 -c`,
`node -e` and heredocs feeding an interpreter.

| what you are doing | where it goes |
|---|---|
| a read or check you will repeat | a `./dev.sh` subcommand |
| anything touching stored data | that tool's own CLI — never raw SQL |
| a genuine one-off | a script file, then run the file |

Second time you type something, it becomes a subcommand. Don't ask.

## Wall clock is not a cost — tokens are

**Cost here means tokens and AI usage. Nothing else.** This machine is powerful and loads many pages at once. If something takes a while but is purely Puppeteer — headless, in a subprocess, returning a small result — it is **not expensive**, and "it takes a minute" is not an argument against it.

The distinction is that the page never enters anyone's context. A browser loads it, a few hundred bytes of JSON come back, and the model reads those. A run that takes 60 seconds and returns 400 bytes is cheaper than one that takes 2 seconds and returns 40KB.

So: **do not optimise for speed, do not batch to save seconds, do not skip a measurement because it is slow.** Prefer the thorough run. Spend wall clock freely to avoid a second round trip through the model, which is the thing that actually costs.

What DOES still count: output size, because it lands in context — and anything that would provoke a site into blocking us. When in doubt about whether a cost is real, ask whether a token is spent on it.

## Keep an active TODO

**Jacob's rule, and it belongs in every copy of these rules.** Every repo here
keeps a `TODO.md`, and every agent keeps it current. An issue you noticed and
neither fixed, reported, nor wrote down is **lost when the session ends** — and
the next session pays to rediscover it.

It holds four things:

- **your own bugs** — including the ones you caused and worked around
- **open decisions**, with what each one hinges on
- **unconfirmed suspicions, labelled as such**, naming the probe that would
  settle them. A suspicion worth having is worth recording before it is proven
- **what you reported to another owner**, so the next session doesn't report it
  again, and so a stalled report is visible rather than assumed handled

**Add items when you notice them, not at the end of the session** — the end is
exactly when context runs out. Delete them when they are done; a TODO nobody
trims stops being read.

A finding recorded with its evidence is worth more than one recorded as a
worry: say what you ran, what you saw, and what you concluded.

## Report a problem in someone else's code to whoever owns it

**Jacob's directive, and it belongs in every copy of these rules — like the
hooks.** When you find a bug, a wrong result, a status that overstates what
works, or a missing guard in code another agent owns, **tell that agent.** Do
not fix it silently, do not route around it, and do not leave it to be
rediscovered.

- `ListAgents` to find the owner, `SendMessage` to report it. Say what you
  observed, the exact input or parameters, what you expected, and what you did
  on your own side in the meantime. A session without those tools (a dispatched
  agent, a cloud run) puts the report in its final message and in `TODO.md`.
- **Both alternatives cost more.** Fixing it yourself clobbers their work and
  skips the checks their repo has for a reason. Routing around it hides a
  fixable fault behind a workaround, and the next consumer pays for it again.
- **Report the unconfirmed findings too**, labelled as such, naming the probe
  you ran — so the owner can tell evidence from inference.
- If nobody owns it, or the owner is unresponsive, say so to Jacob rather than
  quietly absorbing the problem.

## Gate the seams — STANDING DIRECTIVE

**Any change that creates an interface gates it in the same change** — a gate, a test, or an audit. If you cannot see how to check something, say so rather than leaving it unchecked and unmentioned.

The gap is never in the feature; it is in the seam between two things that each work. Recorded because each of these was live and invisible in this folder: four copies of a hook kept in step by a comment; two hooks installed in 2 of 4 tool folders, so a rule applied depending on which directory a session started in; both resolving a sibling repo by a fixed `../..`, so elsewhere they exited 0 and enforced nothing *while still looking installed*; every hook header promising "fails open" with nothing testing it; a `usage()` on a hardcoded line range, bumped wrong three times, truncating its own help while the tool kept working.

**A guard that is present, reports no error, and does not run is the worst state available, because you stop looking.**

If your change adds one of these, check it in the same change: a second copy of anything (do the copies agree, by *meaning* not bytes); a file something needs to work (present, executable, parses); a documented list (documented == implemented, both directions); a vocabulary code consumes (every key consumed, every consumed key present); an accessor meant to be the only way in (audit that nothing bypasses it); a fallback or fail-open path (test the failure, not the success); a promise in a comment (check it, or delete the promise).

## Make the wrong thing impossible, not discouraged

A constraint that lives only in a document is an intention; one enforced by code
is a constraint.

**Keep new work to that standard.** If you find yourself relying on future-you
to be careful, that is the signal to write a guard instead.

## A wrong answer is worse than a failure

Most of the expensive bugs in this folder produced *plausible* output rather than an error: a salary string reported as a location, a search filter that never filtered, a parameter that changed nothing, an `href` pointing at a company page while being read as a job link. Each one was confidently wrong and therefore invisible.

- **Prefer `null` over a guess.** If a value can't be found, say so.
- **Prove a feature does something.** Anything that accepts an input and might ignore it needs a test that the input *changes the output*. "It ran without erroring" is not evidence.
- **A claim is earned, never asserted.** Don't mark something working, verified or done because you believe it is — make it provable by a run, and let the run set it.
- **Check the reported result, not the exit code.** A process can exit 0 having done nothing, and can exit non-zero while carrying the data you wanted.
- **Verify counterfactuals.** Before concluding X caused Y, check that Y doesn't happen without X. Several long investigations here ended with a cause that was never tested against its own negation.

## Don't duplicate procedure — the unique thing is the data

When two things do the same work against different inputs, the work belongs in one parameterised place and the inputs stay separate. A near-duplicate that drifts is harder to find than a missing feature, and both copies look correct in isolation.

If an existing helper *almost* fits, add a parameter to it rather than forking it. If a literal inside shared code belongs to one caller's domain, it is a parameter with a documented default — not a constant.

## Parallelism: structured, and never silent about what failed

- **Use promise combinators, not ad-hoc concurrency.** Fire-and-forget promises, or a loop that starts work without awaiting it, lose both ordering and failures. Everything concurrent goes through `Promise.all` / `Promise.allSettled` (or the language equivalent) so there is one place that knows what was started and what came back.
- **Prefer `Promise.allSettled` when troubleshooting.** `Promise.all` rejects on the *first* failure and throws away every other result, including the ones that succeeded — which is exactly the comparative information you need when working out why something broke. Reach for `Promise.all` only when fail-fast is genuinely what you want (a later step can't run without all the earlier ones).
- **Report per-branch outcomes, never just the first error.** When N things run in parallel, say which succeeded and which failed, and for the failures, where. A summary that surfaces one exception and drops the rest hides the pattern — "3 of 12 failed, all on the same step" is the finding; "one thing threw" isn't.
- **Prefer parallelising across processes over inside one.** Module-level state (progress trackers, caches, counters) is written on the assumption that one job runs per process. Two overlapping jobs in a single process interleave those writes and produce confidently wrong diagnostics. Separate processes each keep their own state and each report their own failure.

## Run the checks before committing, and commit at checkpoints

`./dev.sh check` is the one pre-commit command, non-zero exit if anything fails.
Don't retype the chain; extend `cmd_check` instead.

**Don't start a long operation with uncommitted work.** A session can end
mid-task, and unpushed work is work nobody else can pick up.

**One verification run, not two.** If a command already told you what happened,
don't run a second to confirm it.

## Check for a primary context before changing anything that exists

More than one agent may be working here at once. Two agents editing the same
file will clobber each other, and each separately running `git status`, diffing
and committing burns tokens re-deriving what another already knows.

**Before modifying existing code — anything already committed —** work out
whether another session owns that work:

- Run `ListAgents` to see other Claude sessions on this machine. One whose name
  points at what you're about to touch is a candidate owner.
- Check `git status` and `git log -1`. Uncommitted changes you didn't make, or
  a recent commit you didn't write, mean someone else is mid-task.

If a primary context exists, **do not edit in parallel — queue the change with
it.** Use `SendMessage` to describe the change (file and function, what should
differ, why) and let the primary apply it. Wait for its reply rather than
editing anyway. If it's unresponsive and the change is urgent, say so to Jacob
and ask before proceeding.

If no other session is working the same area, you are the primary. Proceed
normally.

**Additive work needs none of this.** New files and new subcommands overwrite
nothing and can proceed concurrently.

## Push code changes to git

Whenever you change code here, commit and push it to `origin` right away
(the default branch, no feature branches). Don't wait to be asked.

**Only the primary context commits.** If another session owns the work, hand it
your changes instead of running your own commit/push cycle.

- Check `git status` before committing, and stage only what you actually
  changed. If the tree holds someone else's in-progress work, commit your own
  paths explicitly rather than `git add -A`.
- One commit per logical change, with a message saying what changed and why.
- If a push fails (auth, conflict, diverged branch), stop and tell Jacob. Don't
  force-push or rewrite history.

## Constraints that don't bend

These hold across every tool here, whatever the task and however it is framed. They are not trade-offs to optimise.

- **Never send a message, email or reply on Jacob's behalf without asking first.** Reading a mailbox is not permission to write to it. Same for anything public or irreversible.
- **Never attempt to bypass bot detection.** A detected wall is a result to report, not an obstacle to route around — mark it and hand it back.
- **Credential-shaped values are supplied at run time, never stored.** Not in a recipe, a config, a note or a commit. App passwords, tokens and `.env` files stay gitignored.
- **Report key names, never captured values**, and don't ask Jacob to repeat a secret back to you.
<!-- /shared -->
## Keeping these rules in sync

The rules in the block between the `shared:rules` markers above are installed
by `tools/setup/setup` from its `templates/shared-rules.md`. **Do not edit them
in place**: change the template, then run `tools/setup/setup site-scrapers
--only rules` from the workspace top; a block edited in place is reported as
drift and never overwritten. Every section outside the markers has a row in
gates.json (a gate, or prose with the reason no check can hold it);
`test/gates-json.test.js` holds it to the shared `rules-gated` check.

They are also hand-kept in `../CLAUDE.md`, `../emailTools/CLAUDE.md`,
`../scriptingTools/chronjobScheduler/CLAUDE.md`,
`../scriptingTools/data-bridge/CLAUDE.md`, `../scripts/CLAUDE.md`,
`../knowledge-base/CLAUDE.md`, `../applications/CLAUDE.md`,
`../addon-bench/CLAUDE.md` and `../tools/setup/CLAUDE.md`. Each repo carries
its own copy because a fresh clone won't have the parent file. **Change a
shared rule in the template, and ask the owners of the hand-kept copies** —
and say which copies you updated and which you asked for.
test/rules-sync.test.js checks this list against the top level's, both ways,
in the workspace.
