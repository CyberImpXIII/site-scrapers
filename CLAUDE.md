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

**1. Check before assuming.** `node query.js site <target>` — `sites` lists
everything. A `working` recipe → `./scrape.sh <target> '<json params>'`. Check
the `success` field, not the exit code. A `success:false` run can still carry
records: if `partialResults` is true, the wait expired but the data is there.

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
| `blocked-attn` | **you** are stuck; the next step needs the user. Do NOT retry, that already failed. Requires `notes` saying what only they can supply |

`./dev.sh blocked` lists what is waiting on the user.

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
dev.sh      check | test [n] | audit | run | verify | inside | apply
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

---

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
