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
dev.sh      check | test [n] | audit | run | verify | inside | apply | waive
            known | failures | board | browser-ok
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

- **Never** submit a form, apply to a job, create an account, or enter real
  credentials. Describing a form is safe; filling one is not.
- Credential-shaped values are caller-supplied params at run time, never written
  into a stored recipe.
- **Never** attempt to bypass bot detection. A detected wall means
  `blocked-attn` and an attended run — never a workaround.
- Captured handoff values go to gitignored mode-600 files. Report key names,
  never values, and don't ask the user to repeat them.
