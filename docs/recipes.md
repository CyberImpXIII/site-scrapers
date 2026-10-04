# Building and fixing recipes

Read this before creating a recipe or changing one that exists.
The rules that always apply are in `../CLAUDE.md`.

## Iterating on a recipe that is not yet `working`

The engine refuses to run anything whose status is not `working`, which would
otherwise be a deadlock: a recipe could never earn the status it is required to
have. Pass `{"allowUnverified": true}` to run a candidate while building it.
`lab.js` and `verify.js` pass it for you.

## Declaring parameters

`nav_params_schema` is JSON documenting what a caller may pass, keyed by param
name. It is a promise: `audit.js units` flags a parameter no step references,
and flags a `{{placeholder}}` the schema does not document. Say what a value is
for and what shape it takes — a caller has nothing else to go on.

If a site cannot actually filter on something, do not describe it as if it can.
`linkedin.com#listing` promised remote-only results for months while returning
city-specific roles.

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

**Job applications go through a handful of ATS platforms**, and they are
standardized enough that one shape covers them. `open_apply_form` gets a
posting to the point where its form is on screen (dismiss overlay →
optional Apply click → wait → dismiss again), and `describe_form` reports
every field with selector, type, label and whether it is required. Together
they hand you a structured form description to decide what to enter.
Give such a recipe `action_type: "describe_form"`: verify.js then judges it on
the fields it described, so a run that never got past the posting page (0
fields) is not `working` -- judged on page text, Lever and Ashby stayed
`working` while describing nothing (`lib/describeVerdict.js`). Verified against real Greenhouse, Lever and Ashby postings, whose recipes
are now byte-identical 3-step definitions. **Neither action fills or submits
anything.** Applications are prepare-then-confirm (CLAUDE.md, Absolute
constraints): an agent may fill the form, upload documents and answer the
questions, but **nothing ever submits unattended** — a submit step may exist
only behind Jacob's explicit yes to a presented batch that listed that
application (one yes covers exactly the batch shown; anything prepared later
needs its own), such as an attended handoff.

Required-ness is reported with `requiredEvidence`, because Greenhouse and
Lever mark it only with a `*`/`✱` in the label and leave the HTML attribute
off. Trusting the attribute alone understated a 32-field form as almost
entirely optional. A file input inside a `role=group` takes that group's
`aria-labelledby` text as its label and its `aria-required` as evidence
(`group aria-required`): Greenhouse's own `<label>` for an upload is the
hidden "Attach" of its button, identical for resume and cover letter.
CAPTCHA response fields (`g-recaptcha-response`, `h-captcha-response`,
`cf-turnstile-response`) are left out of `fields` and of `formHash` and
counted in `captchaFieldsExcluded`: reCAPTCHA injects its textarea late, and
it made the same form hash differently between reads.

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
