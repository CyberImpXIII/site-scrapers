# Architecture and invariants

Read this before changing the engine, a generic action, or anything that
writes to a database. The rules that always apply are in `../CLAUDE.md`.

**Writes to the recipe DB are BLOCKED outside a sanctioned path.** Every
definition-mutating function in `db.js` (`upsertSite`, `insertField`,
`deleteSite`, `promoteVersion`, `restoreVersion`, `snapshotVersionIfChanged`,
`insertActionType`, `upsertGenericAction`) refuses unless it is inside one.
`logRun` is exempt — append-only telemetry, not a change. The sanctioned paths:

| to do this | use |
|---|---|
| edit an existing recipe | `node lab.js set <target> '{..., "note": "why"}'` |
| create a recipe | `node register.js '<json>'` |
| set a status | `node verify.js <target> '<params>'` (earned by a run) |
| write test fixtures | `authorizeForTests()` in the test's setup |

**Do not reach for raw SQL or inline `node -e` to change the DB.** That path
skips every check, and it is the specific thing this guard exists to stop — it
is how a recipe once got `status: "blocked"` by hand, and how a status was set
that `register.js` would have refused.

`lab.js set` runs the offline audits **before and after** the change, and any
finding that did not exist beforehand is treated as a regression this change
caused: the recipe is rolled back to its previous version and the change is
reported as failed. Pre-existing findings do not block, because refusing every
edit until the whole library is clean would make the gate something to work
around. A `note` is mandatory — it gates the change and becomes its
`change_log` summary.

**A change is validated against the actions it references, not just the recipe.**
A composed recipe is mostly not its own steps — most of what it runs lives in
the generic actions it pulls in, and a failure there is the hardest kind to
attribute because it happens in code the recipe did not write. So when a change
(or a new registration) references `run_generic_action` / `run_action`, the gate
also checks that each reference resolves, that it expands (which is what catches
a cycle or a dangling ref), and that what it expands to is runnable — no step
type the engine lacks, no unregistered probe kind. It then runs the test suites
covering those actions, found by searching the test files for their names rather
than from a map that would drift.

**Editing a generic action is validated in BOTH directions**, because an action
is library code: changing it changes everything that references it.
`dismiss_overlay` alone is depended on by another action and seven recipes.
Registering or editing one through `register.js` checks the SUBACTIONS it pulls
in (each resolves, expands, and is runnable; a self-reference is caught before
it can expand forever) and the DEPENDENTS it could break — found transitively,
so a recipe that reaches the changed action only through another action still
counts. It runs the suites covering all of them, and rolls the action back to
its previous row if the change introduces a finding. **A builtin is edited through `register.js` too, not by editing the file.** The
DB is the source of truth and `lib/builtinActions.js` is a GENERATED export of
it — written read-only, with a DO-NOT-EDIT header. That flip is what closes the
last ungated path: the file used to be authoritative, so a text editor could
change shared library behaviour with no audit, no dependent check and no
rollback. Editing a builtin requires a `note`, since it is the only record of
why shared behaviour moved.

The file still exists rather than the library living only in the DB, because
`data/*.db` is gitignored: it is how a clone gets the library, and how a change
to shared behaviour stays reviewable in a diff. A binary DB would be neither.

**A generic action is audited at the point of USE, not only when written.**
Every expansion validates the action against whatever the DB currently says —
unimplemented step types, unregistered probe kinds, steps with no `action` — and
refuses to run if it would not execute. That check does not depend on how the
row got there, so it holds for a hand-edited export, a pulled change, or raw
SQL, none of which a write-time gate can see. It throws before a browser is
launched, so failing costs nothing, and it is deliberately narrow: only defects
that make an action *unrunnable*, never style, which `audit.js` reports instead.
Write-time gating still exists because it gives the useful error early, next to
the change that caused it.

Seeding (`openDb()`) is the remaining code→DB direction, for clones and for a
pulled change, and it validates: a builtin that would not run is **not seeded**
and the previous version stays in use, and one whose change breaks a dependent
is **reverted**, both with a process warning naming the problem. `./dev.sh test`
catches the same drift at commit time.

`register.js` applies the same check before writing anything, and REFUSES a new
recipe whose referenced action is itself broken. A reference to an action that
does not exist yet stays a warning — building bottom-up is legitimate — but a
reference to one that exists and is broken is not.

Every gated change records a `change_log` row, so an edit made off-path is
detectable by its absence: `node audit.js provenance` lists recipe versions
with no change_log entry behind them.

**A hostname-independent library also exists** — `generic_actions`, a table
of reusable, named "macros" not tied to any site (a heuristic generic login,
dismissing a cookie-consent banner, an infinite-scroll "load more" loop).
Pull one into any recipe with `{"action":"run_generic_action","ref":"generic_login"}`
— same inline-execution/expansion/cycle-detection machinery as `run_action`,
just keyed by name instead of hostname. The built-in ones are defined in
**`lib/builtinActions.js`** and re-seeded into the DB on every open — they're
library behavior, so they live in code (version-controlled, in a fresh clone)
rather than only in the gitignored DB. To change a builtin, edit that file;
`register.js` refuses to register over a builtin name, since the row would
silently revert on the next open. Register your OWN with `node register.js`
using `{"kind":"generic_action","name":...,"steps":[...]}` instead of the
usual hostname/page_type shape (see register.js's header comment for the
full example); user-registered actions are never touched by re-seeding. Browse the library with `node query.js generic-actions`
(list) or `node query.js generic-action <name>` (one, full detail);
`node query.js expand generic:<name>` flattens one the same way `expand`
does for a site recipe. Reach for a generic action instead of a site-
specific `run_action` when the steps genuinely don't depend on the site
(heuristic element-finding, not exact selectors) — a `run_action` reference
to a specific site's recipe is still the right call when you're reusing
something that recipe already figured out for that one site.

**Running several scrapes at once**: parallelise across *processes* — one
`engine.js` per recipe — never by overlapping sequences inside one process.
Each process keeps its own `failedStep` breadcrumb, so N parallel runs give
you N independent answers; two overlapping sequences in one process
interleave their writes and the engine will tell you so
(`failedStep.breadcrumbUnreliable`) rather than name the wrong step.
Collect the results with `Promise.allSettled`, not `Promise.all` —
`all` rejects on the first failure and discards the rest, which throws away
the comparison you actually want ("3 of 12 failed, all on the same step" is
the finding). Report which recipes succeeded and which failed, with each
failure's step; don't surface one exception and drop the others. The DB is
safe under concurrent writes (WAL + busy timeout).

**Token-efficiency claims are backed by real, ongoing data, not just prose**:
every run logs its output size (`scrape_runs.output_chars`) — check
`node query.js efficiency` before repeating a "this saves tokens" claim from
memory. `npm test` (or `./test.sh` — a bare `node --test` picks up the v16 in
PATH and fails) runs the regression suite: output stays small/structured, and
failures actually leave diagnostics behind.
