# site-scrapers — quick use

Prefer this over interactive browser tools for job sites. Recipes live in a
DB, not per-site code. Three recipe types (`page_type`): `listing` (results
page, repeated cards — default), `article` (single detail/post page), and
`action` (a repeatable, parameterized automation — login, add-to-cart, etc;
runs the same as `article` — steps, then optional field capture — it's a
separate type purely for organization). Pick with a `#` suffix, e.g.
`hiringcafe.com#article`; omit it for `listing`.

A hostname can hold more than one recipe of the *same* page_type too (e.g.
two `action` recipes) — add `:recipe_name`, e.g. `example.com#action:login`
vs `example.com#action:add_to_cart`. Omit it for the single/primary recipe of
a page_type (implicit `recipe_name` = `default`).

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
its previous row if the change introduces a finding. A builtin cannot be
registered over at all, since the next open would silently revert it; to change
one, edit `lib/builtinActions.js`, which is a code change and runs the full
suite.

`register.js` applies the same check before writing anything, and REFUSES a new
recipe whose referenced action is itself broken. A reference to an action that
does not exist yet stays a warning — building bottom-up is legitimate — but a
reference to one that exists and is broken is not.

Every gated change records a `change_log` row, so an edit made off-path is
detectable by its absence: `node audit.js provenance` lists recipe versions
with no change_log entry behind them.

1. `node query.js site <hostname>[#page_type[:recipe_name]]` — check if known
   first. `node query.js sites` lists every registered recipe (all
   hostnames/page_types/recipe_names) if you're not sure what's there.
2. Known + `working` → `./scrape.sh <hostname>[#page_type[:recipe_name]] '<json params>'`
   (article/action recipes take whatever params their `nav_params_schema`
   documents — often `{"url": "<full page url>"}` for article, or credentials/
   inputs substituted into `ui_steps` for action). Check the `success` field,
   not exit code. **A `success:false` run can still carry usable data**: if
   `partialResults` is true, the wait deadline passed but records were
   extracted anyway and are present in `jobs`/`article` — check `count`
   before discarding them, and consider raising `ready_timeout_ms`. Add trailing `--raw` only when debugging extraction
   (roughly doubles output size) — omit it otherwise.
3. **Two blocked states, different in kind — do not confuse them.**
   - **`blocked`** is about the SITE. The recipe is believed correct; the site
     needs a person every run (CAPTCHA, login wall, bot protection). The path
     forward is known: run it attended, or tell the user. Nothing to fix, so
     re-deriving it wastes effort. `verify.js` sets this automatically when
     the failure sweep sees a wall.
   - **`blocked-attn`** is about YOUR knowledge. The recipe is *not* known
     correct and troubleshooting is stalled: you cannot determine the next
     step without the user participating. Retrying or re-deriving is exactly
     what already failed. Set it deliberately — nothing can detect it, since
     it is a judgement that you are out of moves — and `register.js` requires
     `notes` saying what was tried, what the obstacle is, and what only they
     can supply or decide. Then surface it and move on to other work.

   `./dev.sh blocked` lists both, separated, so what is waiting on the user is
   visible instead of being rediscovered later.

4. `documented:false` → nothing known. `documented:true, success:false` →
   broken/needs-review, or this run failed — check `error`/`timedOut`/
   `consistencyWarning`.
5. Unknown or broken → fall back to interactive browser tools.
6. Whenever navigating to a page to *do* something for the user — not just
   to scrape a listing/article — confirm with the user whether they'd like
   that action stored as a reusable, adjustable recipe (`page_type: action`)
   before moving on, rather than assuming a one-off interactive pass is
   fine. Don't ask this for read-only listing/article lookups.
7. **`status: "working"` cannot be set by hand.** `register.js` refuses it.
   Register as `needs-review`, then `node verify.js <target> '<params>'` — a
   run that actually extracts records is what sets the status. Editing a
   verified recipe invalidates it (the thing that passed no longer exists);
   promoting does not, since promotion copies the definition unchanged. Use
   `{"allowUnverified": true}` to run an unblessed recipe while iterating.
8. **Prove a parameter does something.** Give every recipe that declares
   params a `param_probe_values`: two or more contrasting param sets that
   *should* return different records, e.g.
   `[{"q":"sales"},{"q":"engineer"}]`. They live on the recipe because only
   the site knows which values are meaningful. Then
   `node audit.js params` runs every recipe twice and reports `ok`, `INERT`
   (the recipe ignores its params), `INCONCLUSIVE` (both runs empty — pick
   better values) or `UNVALIDATABLE` (declares params, has no probe values).
   `node lab.js params <target> '<A>' '<B>'` does one recipe ad hoc.
   A recipe that accepts a param and ignores it is worse than a broken one —
   it answers the wrong question silently.
   nodesk.co shipped an inert param: `?s=` never filtered, and both keywords
   returned byte-identical records. If a site filters client-side, type into
   its search box with `ui_steps` instead of faking a URL param; if it cannot
   filter at all, drop the param from `nav_params_schema` rather than
   promising what it does not do.

   This validates *parameters* only, not fixed values baked into a
   `nav_template`. If a template hard-codes a filter and the schema promises
   it (e.g. linkedin.com#listing's "f_WT=2 (Remote) fixed"), nothing here
   checks that promise — confirm it by reading the records, or stop making it.
9. **Never write an inline script blob. Use a helper — and if none fits,
   write the helper first, then use it.** No `node -e "..."`, no
   `python3 -c "..."`, no `node - <<EOF` / `python3 - <<PY` heredocs. Each
   one costs tokens to author, reintroduces a shell-quoting bug roughly every
   third attempt, and leaves nothing behind for next time. The helper you add
   is reusable; the blob never is. What to reach for instead:

   | instead of | use |
   |---|---|
   | `python3 -c` to read a JSON field | `jq` (already installed) |
   | a heredoc that patches a file | the **Edit** tool |
   | `node -e` to change a recipe in the DB | `node lab.js set <target> '<json>'` |
   | `node -e` to inspect a recipe | `node query.js site <target>` |
   | a pipeline to run/summarise recipes | `./dev.sh run` / `verify` / `health` |

   Everything above already exists, so an inline blob is almost always a
   discipline failure rather than a missing tool. When something genuinely
   isn't covered, add a `./dev.sh` subcommand or a `lab.js` command in the
   same turn and call that — do not write it inline "just this once".

   Helpers must trim their own output: reading five lines instead of five
   hundred saves more than a shorter command does. They must also keep
   failure detail — a helper printing only a pass/fail count forces a second
   run to learn what broke.

   - `./dev.sh test [n]` — run the suite, summary only; `n` runs it
     repeatedly to flake-check. Keeps failing test NAMES, so a failure is
     diagnosable without a second run.
   - `./dev.sh run <target> '<params>' ...` — run several recipes, one line
     each (success / count / first record / where it broke).
   - `./dev.sh verify <target> '<params>' ...` — batch-verify.
   - `./dev.sh health` — only the recipes needing attention.
   - `./dev.sh snap` / `new` — baseline the recipe list, then see what changed.
     Worth doing before any batch of recipe work.
   - `./dev.sh clean [--yes]` — remove stray `*.test` / `*.internal`
     scaffolding recipes. Lists by default.

   Write a new helper when you notice yourself composing the same pipeline a
   second time — not speculatively. An unused helper is worse than the inline
   version it replaced, and a wrong one is worse still.

10. **`node lab.js` is the workbench** for building recipes — `probe <url>`
   (card/form/blocker sweep), `sel <url> '<css>'` (match counts), `raw`
   /`peek <target>` (samples plus per-field null counts), `set <target>`
   (selectors and fields in one call), `params`, and `new` (prints the whole
   build-and-verify sequence). Prefer it over ad-hoc `node -e` one-liners.
11. After a successful interactive session (and the user said yes to step 6,
   for actions), document it: `node register.js '<recipe json>'` (all three
   JSON shapes are in register.js's header comment). Give it an explicit
   `recipe_name` if the hostname already has a recipe of the same page_type.

**The recipe is the unique document; the actions it performs are not.** A
recipe should hold only what is genuinely specific to its site — selectors,
URLs, field mappings, parameter values. Everything procedural belongs in a
parameterised generic action it references. Two consequences, both enforceable:

- **Reuse before you write.** Run `node query.js generic-actions` and
  `node query.js expand <target>` before adding steps. If an existing action
  does most of what you need, pass it a parameter rather than writing a
  near-duplicate; if it *almost* fits, add a parameter to it rather than
  forking it.
- **Hard-code as little as possible.** A literal inside a generic action is
  acceptable only when it is universal platform vocabulary (ARIA dialog
  roles, captcha iframes, form controls). Anything that belongs to a domain
  or a site is a parameter with a documented default — "jobs / openings /
  positions" baked into an empty-result probe made it a job-board probe
  wearing a generic name. Use `default_selector` for an overridable default
  and `optional_selector: true` for a step that skips itself when the caller
  passes nothing.

**`node audit.js` measures this** rather than leaving it to judgement:

| check | finds |
|---|---|
| `inline` | recipes re-implementing an existing generic action step-for-step (fix: one `run_generic_action`) |
| `repeats` | step sequences shared by 2+ recipes that no action covers yet — the next actions worth creating |
| `literals` | the same literal hard-coded in 2+ recipes, i.e. copy-paste hiding a parameter |
| `hardcoded` | literals inside generic actions, to judge universal vs smuggled site knowledge |
| `units` | static per-component invariants — offline and instant, run it freely |
| `params` | **live**: do recipes that declare parameters actually honour them |
| `working` | **live**: does every recipe claiming `working` actually return records *now* |
| `fixed-params` | **live**: does a HARDCODED query param in a nav_template suppress results |

`audit.js working` is the check that `status` is telling the truth. `dev.sh
health` answers the same question from run *history*, which goes stale exactly
when it matters; this runs each one. A `LIAR` verdict means the status is
wrong — fix the recipe, or let `verify.js` write an honest one. `UNRUNNABLE`
means the recipe's `nav_template` has placeholders that `param_probe_values`
cannot fill, so it could not be exercised at all; that is not a pass.

Both live audits need `param_probe_values`, and the values are usually already
in run history: `node lab.js history <target>` shows the param sets that have
actually returned records, and `node lab.js adopt-history <target>` sets the
two most recent distinct ones. Prefer those over inventing values — an article
recipe needs a real posting URL, and a guessed one proves nothing.

Run it after adding recipes. A finding in `inline` or `literals` is a
defect; a finding in `hardcoded` is a judgement call the tool surfaces rather
than decides.

`units` catches the mistakes that produce no error and no wrong answer, just a
quiet dead end: a step type no `engine.js` case implements (it does nothing at
run time), a `probe` kind referenced but never registered, a parameter a schema
documents that no step reads (passing it via `with` has no effect), a
placeholder no schema documents (a caller cannot discover it), or a builtin
that did not seed — in which case edits to `lib/builtinActions.js` are silently
ignored. It is offline, so there is no reason not to run it before committing.
An `error` there means something is already broken and nobody has noticed.

`fixed-params` covers the blind spot between the other two: a value baked into
a `nav_template` is not a parameter, so `params` ignores it, and a bad one
fails in a way that looks like anything else. usajobs.gov carried `rmi=true`,
which returned 0 records where removing it returned 25 — and it survived a
full investigation that ruled out selectors, walls and rendering before a
human simply looked at the page and said the search had no results. The audit
runs each recipe with and without each hardcoded value and flags any whose
removal unlocks results.

For `action` recipes specifically, prefer keeping them within the small
`action_types` taxonomy (`node query.js action-types`) rather than inventing
arbitrary, similar-but-not-quite-the-same types (e.g. `add_to_cart` on one
site and `add-to-basket` on another for the same underlying action).
`register.js` enforces this — it rejects an `action_type` that isn't already
in the taxonomy unless you deliberately add `new_action_type_description` to
register a genuinely new one. Reach for that escape hatch only when nothing
existing actually fits, not as a default.

Credential-shaped values (passwords, tokens) for an `action` recipe belong in
caller-supplied params at run time, never written into the stored recipe
(`nav_template`/`notes`/`fields`) — same as any other param, just don't let
it end up in the DB.

**Steps that need a human mid-run**: give a `ui_steps` sequence a `handoff`
step (2FA/OTP entry, a CAPTCHA, a final "place order" confirmation — anything
the automation shouldn't do unattended). `engine.js` detects it up front and
runs the whole thing in a real, visible browser window instead of headless,
since that window is the only way control actually reaches a person mid-run
— there's no other channel back to them. It resumes automatically once
`resume_selector` (preferred) or `resume_url_includes` appears on the page,
or after `timeout_ms` (default 5 min) if neither is given. Run the call with
a generous timeout or in the background — it isn't hung, it's waiting on
them. See register.js's header comment for the step shape.

**Before** telling the user about that upcoming handoff, ask them which
capture mode to use for this specific run (this is a per-run choice, never
something to assume or bake into the recipe):
- **none** (default/safest) — capture nothing.
- **flagged** — capture only the selectors the step's `capture.fields`
  names (values the recipe author marked as reusable/non-secret — an email,
  a reference number).
- **all** — capture every form field on the page once the handoff resolves,
  *including* a password or 2FA code if one is still sitting in a field.
  Only pick this because the user explicitly chose it, never by default.

Only after they answer do you tell them a browser window is about to open
and what to do in it, then pass their choice as `captureMode` in params.
Captured values land in a gitignored temp file under `data/.captures/` and
are never printed to stdout or logged to `scrape_runs` — the result JSON's
`handoffCaptures` gives you the file path and which keys were captured, not
the values, so don't ask for or repeat the values yourself either.

**Session cookies persist across runs ON BY DEFAULT**, per `(hostname,
sessionName)` — every call loads that session's saved cookies before
navigating and saves the updated jar back afterward, so a successful login
survives to the next call without repeating a handoff. `params.session`
(default `"default"`) selects which of possibly several *parallel* sessions
to use for a hostname — e.g. two different accounts never share cookies as
long as each run passes a distinct `session` name. `params.noSession: true`
skips persistence for one call. `node query.js sessions [hostname]` lists
what's saved (metadata only, never cookie values); `node query.js
clear-session <hostname>[:sessionName]` forces a fresh login next time. If a
recipe's page only works LOGGED OUT (its signed-in DOM differs, so a saved
session silently yields 0 results), give the recipe `"session_mode": "none"`
rather than documenting "remember to pass noSession" — the engine then
enforces it regardless of the caller. A
login recipe's `handoff` combines with this for free — a still-valid session
typically means the resume condition (e.g. redirected past `/login`) is
already true the instant the handoff step starts, so no human is needed at
all; a stale session just falls through to a real handoff as normal.

**Compose actions instead of duplicating steps**: when a new `action`
recipe needs something an existing one already does (most often `login`),
add a `run_action` step — `{"action":"run_action","ref":"login"}` (same
hostname, page_type `action`) or `{"action":"run_action","ref":"other.com#action:sso_login"}`
(cross-hostname) — instead of copy-pasting that recipe's steps inline. It
runs on the same page, not a separate session, so a nested `handoff`/
`capture` inside the referenced action works exactly as it would standalone.
Check what a composed recipe will actually run with `node query.js expand
<hostname>#action:<recipe_name>` before relying on it. Composed recipes
share one `params` object with whatever they reference — no per-reference
renaming yet, so agree on param names (e.g. `{{email}}`/`{{password}}`)
across a recipe and whatever it composes. `register.js` warns (non-fatally,
via `unresolvedReferences`) on a `run_action` ref that doesn't currently
resolve — building bottom-up or top-down are both fine — but `engine.js`
fails fast, before launching a browser, on a dangling reference, a
referenced recipe that isn't `status:"working"`, or a reference cycle.

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

**Cookie/consent overlays** escalate through a ladder — **skip, then deny,
then (opt-in) accept**: first remove the overlay from the DOM (no consent
signal at all, no click), then if a banner survives because its container
wasn't recognized, click Reject/Decline/Close, and only as a last resort
Accept. `dismiss_overlay` (start here) does skip→deny and never accepts;
`dismiss_overlay_accept` adds the accept rung, which sets that site's
tracking cookies into the saved session jar, so use it only when a site
genuinely gates content behind accepting; `remove_overlay` is skip-only,
guaranteed never to click anything. Which one a recipe references *is* the
consent decision — pick deliberately. To make any step optional (act if
present, carry on if not), wrap it in `repeat` with `times: 1` — a bare
`stop_if_missing` click ends the whole remaining step list at top level.

**Listing recipes read page 1 only unless asked.** A recipe with
`pagination_method: "steps"` takes `{"extra_pages": N}` to go further; without
it nothing extra runs. Two generic actions cover the usual patterns:
`paginate` (Next button replaces content — needs the site's selector via
`with: {"next_selector": "..."}`) and `infinite_scroll` (results append as you
scroll). Pages are merged and de-duplicated by `href`; output includes
`pagesVisited`. The underlying step types work in any ui_steps list:
`repeat` (`times`, capped at 50), `click` with `stop_if_missing`, `collect`
(listing only), `scroll_bottom`, and `wait`. For cards with no shared literal
text, use `card_selector` (a CSS selector matching each card container)
instead of `card_anchor_text`; for cards grouped under a shared header (a
company name above its jobs), the `ancestor_first_line` field kind reads that
header. Details in README.md.

**Check what has broken before, first.** A second database
(`data/failures.db`, separate from `scrapers.db`) remembers diagnosed
failures and their fixes. Before re-deriving a recipe that broke, run
`node failures.js match <hostname> '<json probe>'` — the probe can carry
`failure_type`/`symptom`/`step_selector`/`step_action`/`step_from`, most of
which come straight from the run's `failedStep`. A hit on a **different**
site is still valuable when the resolution transfers ("this is the
consent-overlay pattern again"). `node failures.js common` shows which
failure types dominate overall.

When you diagnose something, record it: `node failures.js record '<json>'`
with a `failure_type`, a `symptom`, and ideally a `resolution`. Recording
the same shape twice bumps `occurrences` rather than adding a row, and a
repeat is itself a finding worth acting on. **Keep the taxonomy small** —
run `node failures.js types` and reuse an existing type rather than
inventing a near-duplicate; `failures.js` rejects an unknown type unless you
deliberately pass `new_failure_type_description`. A taxonomy that fragments
("cookie_wall" beside "consent_overlay") cannot answer "have we seen this
before", which is the only reason the database exists.

**Job applications go through a handful of ATS platforms**, and they are
standardized enough that one shape covers them. `open_apply_form` gets a
posting to the point where its form is on screen (dismiss overlay →
optional Apply click → wait → dismiss again), and `describe_form` reports
every field with selector, type, label and whether it is required. Together
they hand you a structured form description to decide what to enter.
Verified against real Greenhouse, Lever and Ashby postings, whose recipes
are now byte-identical 3-step definitions. **Neither action fills or submits
anything, and `open_apply_form` must never be extended with a step that
clicks Submit/Send** — describing a form is safe to run unattended, filling
one is not.

Required-ness is reported with `requiredEvidence`, because Greenhouse and
Lever mark it only with a `*`/`✱` in the label and leave the HTML attribute
off. Trusting the attribute alone understated a 32-field form as almost
entirely optional.

**Don't guess a selector — probe for it.** `probe` steps report what's on
the page and never change it or fail the run; results land in the output
JSON's `diagnostics`. Four generic actions wrap them: `diagnose_page` (all
sweeps), `probe_card_candidates` (proposes `card_selector` /
`card_anchor_text`, including the repeated line across cards — the most
common thing to get wrong), `diagnose_blockers` (CAPTCHA / bot-check /
login wall / consent overlay / empty body, which all look identical in a
bare timeout), and `probe_selectors` (test candidates in one run via
`with: {"selectors": "a, b, c"}`). **This sweep already runs automatically
on every failed run** and is written to the capture's `diagnostics.json` —
read that before re-running anything. Use `diagnose_page` explicitly only
when a run succeeds but returns the wrong thing. Probes never report a form
field's value, only that one exists.

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

**A step failure says which step.** When a `ui_steps` sequence throws, the
output JSON and the capture's `meta.json` both carry `failedStep`:
`{index, of, path, action, selector, hasText, from}`. Read it before
re-running anything — it tells you the position in the *expanded* sequence
(references are inlined, so indexes shift), and `from` names the reusable
action a step came from (`generic:dismiss_overlay`) when it wasn't written
in the recipe itself. `hasText` reports only that text was supplied, never
the value, since it may be a substituted credential. `failedStep` is null
for failures that aren't step failures — a zero-result run or a timeout
waiting for cards.

**When a run fails, look before guessing.** Any failure (thrown error,
timeout, or zero results) writes a screenshot + DOM + console/network logs to
a gitignored `data/.debug/` directory and reports the path as `debugDir` in
the output JSON. Read those instead of re-deriving the recipe from scratch —
`dom.html` shows which selectors actually exist, `screenshot.png` shows
whether you got a CAPTCHA/login wall rather than the page you expected.
`node query.js debug-captures` lists recent ones. `params.noDiagnostics: true`
disables it. The capture also includes `frames/` — a rolling window of the
last few screenshots *leading up to* the failure, named by how long before it
they were taken (`frame-01-t-minus-2036ms.png`). Read them in order: that's
what separates "never loaded" from "loaded, then navigated away" or "a modal
appeared", which all look identical in the final frame alone. Window size is
`params.rollingFrames` (default 6, 0 disables) at `params.rollingIntervalMs`
(default 2000); it defaults to OFF on headed/handoff runs, where a person is
already watching and the frames would capture their own interaction.

**Recipes are versioned — use that instead of guessing what changed.** Every
`register.js` call that actually alters a recipe snapshots it as a new minor
(`v1.3`); an unchanged re-register records nothing. When a working recipe
starts failing, run `node query.js diff <target>` *before* rewriting it —
with no arguments it compares the last stable version against the current
one, which is exactly "what changed since it worked". `node query.js
versions <target>` lists the history with each version's real success rate,
and runs are tagged with the version that produced them, so a `debugDir`
capture is tied to a specific definition. Iterate freely: scaffolding minors
are auto-pruned to the last 5, and a `vN.0` is never pruned. When a fix is
confirmed against the live site, `node query.js promote <target> '<what you
verified>'` publishes it AS the next major — promoting v1.2 gives you a
stable v2.0, and iteration continues at v2.1. Do this rather than leaving a
good version indistinguishable from the scaffolding around it. `node query.js restore <target>
v2.0` puts an old definition back if an edit made things worse. Details in
README.md.

**Don't trust a recipe's `status` alone** — it's set by hand and can go
stale. `node query.js health` shows each recipe's actual success rate over
its recent runs and flags `statusDisagrees` where a recipe claims `working`
but has been failing. Check it before concluding a site broke, and prefer
fixing/re-marking a recipe over working around it silently.

No auto-detector yet for which page_type a URL is — you have to know/guess.

**Token-efficiency claims are backed by real, ongoing data, not just prose**:
every run logs its output size (`scrape_runs.output_chars`) — check
`node query.js efficiency` before repeating a "this saves tokens" claim from
memory. `npm test` (or `./test.sh` — a bare `node --test` picks up the v16 in
PATH and fails) runs the regression suite: output stays small/structured, and
failures actually leave diagnostics behind.

## Check for a primary context before changing anything that exists

More than one agent may be working here at once. Two agents editing the same
file or the same recipe will clobber each other, and each separately running
`git status`, diffing and committing burns tokens re-deriving what another
already knows.

**Before modifying existing code or an existing recipe — anything already
committed or already registered —** work out whether another session owns
that work:

- Run `ListAgents` to see other Claude sessions on this machine. One whose
  name points at what you're about to touch is a candidate owner.
- Check `git status` and `git log -1`. Uncommitted changes you didn't make,
  or a recent commit you didn't write, mean someone else is mid-task.

If a primary context exists, **do not edit in parallel — queue the change
with it.** Use `SendMessage` to describe the change (file and function, or
which recipe and what should differ, and why) and let the primary apply it.
Wait for its reply rather than editing anyway. If it's unresponsive and the
change is urgent, say so to Jacob and ask before proceeding.

If no other session is working the same area, you are the primary. Proceed
normally.

**Additive work needs none of this.** New files, new recipes and new generic
actions overwrite nothing and can proceed concurrently. The DB handles
concurrent writes safely (WAL + busy timeout), so registering a recipe while
another agent runs a scrape is fine. Editing an *existing* recipe is not
additive — it bumps that recipe's version, and two agents doing it at once
produces conflicting version history.

## Push code changes to git

Whenever you change code here, commit and push it to `origin` right away
(branch `master`). Don't wait to be asked.

**Only the primary context commits.** If another session owns the work, hand
it your changes instead of running your own commit/push cycle — one agent
staging, diffing, writing a message and pushing is enough, and duplicating
that is wasted tokens and a likely conflict.

- Check `git status` before committing, and stage only what you actually
  changed. If the working tree holds someone else's in-progress work, commit
  your own paths explicitly rather than `git add -A`.
- Never commit secrets or captured data: `data/.captures/`, `data/.sessions/`,
  `data/scrapers.db`, `data/.debug/`. All gitignored; keep it that way.
- One commit per logical change, with a message saying what changed and why.
- If a push fails (auth, conflict, diverged branch), stop and tell Jacob.
  Don't force-push or rewrite history.

Full details: README.md.
