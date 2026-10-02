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

---

## Rules

**1. Check before assuming — ENFORCED.** `node query.js site <target>` — `sites`
lists everything, and `./dev.sh known <hostname>` answers "is anything
registered for this host" across every page_type. A `working` recipe →
`./scrape.sh <target> '<json params>'`. Check the `success` field, not the exit
code. A `success:false` run can still carry records: if `partialResults` is
true, the wait expired but the data is there.

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
| `blocked-attn` | **you** are stuck; the next step needs the user. Do NOT retry, that already failed — a hook now blocks the retry. Requires `notes` saying what only they can supply |

`./dev.sh blocked` lists what is waiting on the user.

**Three of these rules are ENFORCED by hooks, not advised** — rules 1, 3 and 4.
`node init.js` reports which are live. Each hook fails OPEN, because one that
broke every call would be worse than the habit it corrects.

| hook | blocks |
|---|---|
| `no-inline-blobs.sh` | `node -e`, `python3 -c`, heredocs feeding an interpreter (rule 4) |
| `prefer-recipes.sh` | a browser/WebFetch call on a host that has a `working` recipe (rule 1) |
| `troubleshooting.sh` | re-running a `blocked-attn` recipe without `--attended` (rule 3) |

These three live in two copies, here and at the top level (`./check-hooks.sh
--sync` pushes this repo's); **if you change one, change both.** The top level
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
query.js    sites | site | runs | versions | diff | restore | promote | health
            generic-actions | expand | sessions | clear-session | debug-captures
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
```

`dev.sh` is the **human-readable layer** over those CLIs — they emit JSON by
contract (`test/cli.test.js` calls it "the jq contract"), `dev.sh` emits lines.
Reach for `dev.sh inside` rather than piping `lab.js inside` through jq, and if
the summary you want is not there, add it rather than filtering inline.

**Before committing: `./dev.sh check`** — suite, offline audit and working tree
in one command, exiting non-zero if the suite fails. An `error` from the audit
means something is already broken.

**A warning you have checked gets waived, not re-derived.** `./dev.sh waive
<target> <rule> '<what you checked>'` writes an `AUDIT-VERIFIED[rule]` line the
audit itself reads, so it prints as `OK/W` with your evidence instead of as an
open finding. It never applies to an `error`, and the finding still appears —
this records an answer, it does not silence a check. Without it a verified
warning gets re-investigated every session, which is what happened to
salesforce's `:has()` three times.

---

## Wall clock is not a cost — tokens are

**Cost here means tokens and AI usage. Nothing else.** This machine is
powerful and loads many pages at once. If something takes a while but is
purely Puppeteer — headless, in a subprocess, returning a small result — it is
**not expensive**, and "it takes a minute" is not an argument against it.

The distinction is the page never enters anyone's context. A browser loads it,
a few hundred bytes of JSON come back, and the model reads those. A run that
takes 60 seconds and returns 400 bytes is cheaper than one that takes 2
seconds and returns 40KB. `query.js efficiency` tracks `output_chars` for
exactly this reason, and the README's "Why this saves tokens" is the same
argument: what got eliminated was screenshots, DOM dumps and chunked
retries — the scaffolding around the data — not the waiting.

So: **do not optimise for speed, do not batch to save seconds, do not skip a
measurement because it is slow.** Prefer the thorough run. Spend wall clock
freely to avoid a second round trip through the model, which is the thing that
actually costs.

What DOES still count against a run: output size (it lands in context), and
anything that would provoke a site into blocking us — but "8 sequential page
loads" is ordinary browsing, not that. When in doubt about whether a cost is
real, ask whether a token is spent on it.

## Keep an active TODO — write it when you notice it

**Jacob's rule, in every copy of these rules.** `TODO.md` is not an end-of-
session summary. An issue you noticed and neither fixed, reported, nor wrote
down is **lost when the session ends**, and the next session pays to find it
again. It holds your own bugs (including ones you caused and worked around),
open decisions with what each hinges on, **unconfirmed suspicions labelled as
such** naming the probe that would settle them, and **what you reported to
another owner** — so nobody re-reports it and a stalled report stays visible.

Record evidence, not worry: what you ran, what you saw, what you concluded.
Delete items when done; a TODO nobody trims stops being read.

**Write it at the moment you notice it.** The end of a session is exactly when
context runs out. Section 0 of `TODO.md` carries the proof: three items were
spotted mid-session, called "worth noting", and never written down — they
surfaced only because Jacob asked whether anything had been left out. One was
a `lib/gate.js` defect I had explicitly said I would record.

## Report a problem in someone else's code to whoever owns it

**Jacob's directive, in every copy of these rules — like the hooks.** When you
find a bug, a wrong result, a status that overstates what works, or a missing
guard in code another agent owns, **tell that agent.** Do not fix it silently,
do not route around it, do not leave it to be rediscovered.

- `ListAgents` to find the owner, `SendMessage` to report. Say what you
  observed, the exact input or parameters, what you expected, and what you did
  on your own side meanwhile.
- **Both alternatives cost more.** Fixing it yourself clobbers their work and
  skips the checks their repo has for a reason. Routing around it hides a
  fixable fault, and the next consumer pays again.
- **Report unconfirmed findings too**, labelled, naming the probe you ran, so
  the owner can tell evidence from inference.
- If nobody owns it, or the owner is unresponsive, tell Jacob rather than
  quietly absorbing it.

It has paid for itself in both directions from this repo. A `glassdoor` recipe
reported here as broken was not broken — it had a NULL `nav_params_schema` and
a `kw_end` whose wrong value returns 5 records instead of 30 with
`success:true`. A report in the other direction found an import script
discarding good data by aborting on a non-zero exit code. And a consumer
reading the VALUES found three `remoteok` extraction faults that every audit
here passed, because a run returning 50 rows looks healthy from the inside.

**Consumers see what audits cannot.** An audit here checks that a run returned
records; it does not read them. If someone is using this engine's output, their
report is the strongest signal available about whether a recipe is actually
right.

## Gate the seams — STANDING DIRECTIVE

**Any change that creates an interface gates it in the same change** — a gate, a
test, or an audit. If you cannot see how to check something, say so rather than
leaving it unchecked and unmentioned.

The gap is never in the feature; it is in the seam between two things that each
work. Recorded here because each of these was live and invisible: four copies of
a hook kept in step by a comment; two hooks installed in 2 of 4 tool folders, so
a rule applied depending on which directory a session started in; both resolving
a sibling repo by a fixed `../..`, so elsewhere they exited 0 and enforced
nothing *while still looking installed*; every hook header promising "fails
open" with nothing testing it; `usage()` on a hardcoded line range, bumped wrong
three times, truncating the help while the tool kept working.

**A guard that is present, reports no error, and does not run is the worst state
available, because you stop looking.**

If your change adds one of these, check it in the same change: a second copy of
anything (do the copies agree, by *meaning* not bytes); a file something needs
to work (present, executable, parses); a documented list (documented ==
implemented, both directions); a vocabulary code consumes (every key consumed,
every consumed key present); an accessor meant to be the only way in (audit that
nothing bypasses it); a fallback or fail-open path (test the failure, not the
success); a promise in a comment (check it, or delete the promise).

Worked examples: `check-hooks.sh`, `test/hooks.test.js`, `audit.js units`,
`lib/gate.js`, `lib/outputShape.js`.

## Working in this repo

**Check for a primary context before changing anything that exists.** More than
one agent may work here. Run `ListAgents`; check `git status` and `git log -1`
for someone else's in-progress work. If another session owns it, queue the change
via `SendMessage` rather than editing in parallel — and only the primary commits.
Additive work (new files, recipes, actions) needs no coordination.

**Commit and push to `origin master` right away** — don't wait to be asked, don't
branch. Stage only your own paths if the tree holds someone else's work. `data/`
is gitignored and stays that way. If a push fails, stop and tell Jacob rather
than force-pushing.

**Don't start a long operation with uncommitted work.** Commit at checkpoints.
One verification run, not two.

---

## Absolute constraints

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
