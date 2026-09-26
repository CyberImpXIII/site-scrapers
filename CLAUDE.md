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

1. `node query.js site <hostname>[#page_type[:recipe_name]]` — check if known
   first. `node query.js sites` lists every registered recipe (all
   hostnames/page_types/recipe_names) if you're not sure what's there.
2. Known + `working` → `./scrape.sh <hostname>[#page_type[:recipe_name]] '<json params>'`
   (article/action recipes take whatever params their `nav_params_schema`
   documents — often `{"url": "<full page url>"}` for article, or credentials/
   inputs substituted into `ui_steps` for action). Check the `success` field,
   not exit code. Add trailing `--raw` only when debugging extraction
   (roughly doubles output size) — omit it otherwise.
3. `documented:false` → nothing known. `documented:true, success:false` →
   broken/needs-review, or this run failed — check `error`/`timedOut`/
   `consistencyWarning`.
4. Unknown or broken → fall back to interactive browser tools.
5. Whenever navigating to a page to *do* something for the user — not just
   to scrape a listing/article — confirm with the user whether they'd like
   that action stored as a reusable, adjustable recipe (`page_type: action`)
   before moving on, rather than assuming a one-off interactive pass is
   fine. Don't ask this for read-only listing/article lookups.
6. After a successful interactive session (and the user said yes to step 5,
   for actions), document it: `node register.js '<recipe json>'` (all three
   JSON shapes are in register.js's header comment). Give it an explicit
   `recipe_name` if the hostname already has a recipe of the same page_type.

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
