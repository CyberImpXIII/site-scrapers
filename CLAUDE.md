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
just keyed by name instead of hostname. Register one with `node register.js`
using `{"kind":"generic_action","name":...,"steps":[...]}` instead of the
usual hostname/page_type shape (see register.js's header comment for the
full example). Browse the library with `node query.js generic-actions`
(list) or `node query.js generic-action <name>` (one, full detail);
`node query.js expand generic:<name>` flattens one the same way `expand`
does for a site recipe. Reach for a generic action instead of a site-
specific `run_action` when the steps genuinely don't depend on the site
(heuristic element-finding, not exact selectors) — a `run_action` reference
to a specific site's recipe is still the right call when you're reusing
something that recipe already figured out for that one site.

No auto-detector yet for which page_type a URL is — you have to know/guess.

**Token-efficiency claims are backed by real, ongoing data, not just prose**:
every run logs its output size (`scrape_runs.output_chars`) — check
`node query.js efficiency` before repeating a "this saves tokens" claim from
memory. `test/efficiency.test.js` (`node --test test/efficiency.test.js`,
same Node as `scrape.sh`) is a real regression suite guarding that output
stays small/structured rather than silently regressing toward a raw dump.

Full details: README.md.
