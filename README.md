# site-scrapers

One generic Puppeteer engine, driven by a SQLite database of "how to scrape
this site" recipes, instead of a bespoke JS file per website. The point is
twofold: cut token spend on repeat visits to a known site (one Bash call
returning structured JSON instead of screenshots + DOM dumps + chunked
extraction calls), and make what's already known about a site *queryable*,
so a fresh/context-less session can check `query.js` instead of needing to
remember or re-derive it.

## Architecture

- **`engine.js`** — the only execution code. Takes a hostname (+ optional
  `#page_type[:recipe_name]`) + params, looks up that recipe in the DB,
  executes it, extracts fields (if any), logs the run, prints one JSON
  object. Nothing site-specific is hardcoded here.
- **`data/scrapers.db`** (SQLite, via Node's built-in `node:sqlite`) — the
  knowledge base. Five tables:
  - `sites` — one row per `(hostname, page_type, recipe_name)` triple: how
    to navigate/act (`nav_method` + `nav_template`), a `status`
    (`working`/`broken`/`needs-review`), and free-text `notes`.
    `recipe_name` defaults to `"default"` and only needs to be set
    explicitly when a hostname has more than one recipe of the same
    `page_type` (see below). Three `page_type`s exist:
    - `listing` (default, back-compat) — a results page with repeated
      cards. Uses `card_anchor_text` to find them, extracts one record per
      card, pagination config, `result_count_regex` for a self-consistency
      check. When no literal text appears once in every card (no shared
      "Apply"/"View job" link — e.g. linkedin.com's guest search, builtin.com,
      dice.com), set `card_selector` instead: a CSS selector matching each
      card container directly. The card's first `<a>` then serves as the
      anchor for `anchor_attribute` fields. Prefer a site's own data
      attributes (`[data-testid='job-card']`) or structure
      (`div:has(> div > div > a[href^='/jobs/'])`) over generated class
      names.
    - `article` — a single-record page (e.g. a job/post detail page). Uses
      `content_selector` (defaults to `document.body`) and `nav_method:
      "direct_url"` (goto `params.url` as-is) or `"ui_steps"`.
      `content_stop_text` optionally truncates the extracted text at a
      literal marker, to cut off "related content" widgets that would
      otherwise bloat the output.
    - `action` — a repeatable, parameterized automation that isn't
      primarily about reading content: login, add-to-cart, or any other
      multi-step interaction. Executes through the *identical* code path as
      `article` (run `nav_method: "ui_steps"`, then optionally read
      `content_selector` back as a result/confirmation) — it's a distinct
      `page_type` purely so it shows up clearly in `query.js sites` and can
      be looked up by name (`#action:login`), not different engine
      behavior. A hostname commonly needs *several* action recipes at once
      (e.g. `login`, `add_to_cart`, `checkout_to_review`), which is exactly
      what `recipe_name` disambiguates. Credential-shaped values belong in
      caller-supplied params substituted into `ui_steps` at call time (like
      any other param), never written into the stored recipe itself. An
      action recipe's `action_type` must reference the `action_types` table
      (see below) — a small taxonomy so recipes converge on shared action
      kinds instead of accumulating near-duplicates. A `ui_steps` sequence
      can also include a `handoff` step for anything that needs a human mid-
      run (2FA, a CAPTCHA, a final purchase confirmation) — see "Human
      handoff" below.
  - `action_types` — the small, deliberately short taxonomy `action_type`
    values are validated against: seeded with `login`, `logout`,
    `add_to_cart`, `checkout_to_review`, `submit_form`, `search`.
    `register.js` rejects an unrecognized `action_type` for a new `action`
    recipe unless the call also includes `new_action_type_description`,
    which registers it as a deliberate new entry — the point is to make
    inventing a near-duplicate type (`add_to_cart` vs `add-to-basket`) a
    conscious choice, not an accident of free-typing a `recipe_name`. List
    it with `node query.js action-types`.
  - `site_fields` — named, enumerable fields per site, each with an
    extraction rule: `positional_segment` / `regex_anywhere` /
    `anchor_attribute` (all recipes), plus `title_regex` (matches against
    `document.title`, often cleaner than blob parsing) and `full_blob` (the
    whole extracted text, e.g. for a catch-all `description` field) —
    article/action recipes only. `anchor_attribute` can also take an
    optional CSS selector (via the `regex_pattern` column, repurposed) to
    pull the attribute off a different element within the card than the one
    `card_anchor_text` matched — e.g. the anchor that identifies a listing
    card isn't always the anchor whose `href` you actually want.
    `ancestor_first_line` (listing only) handles layouts that group several
    cards under one header, like a company name with its jobs listed
    beneath it (wellfound.com): `regex_pattern` holds a CSS selector for the
    group container, and the value is the first line of its text.
  - `scrape_runs` — an audit log of every invocation (params, success,
    result count vs. the site's own claimed count, duration, error). This
    is the reliability history — not just a static status flag.
  - `generic_actions` — a hostname-*independent* library of reusable
    puppeteer "macros": named `ui_steps` sequences any recipe can pull in
    with `run_generic_action`, for behavior that doesn't depend on the site
    (pagination, dismissing a cookie-consent banner). See "Composing
    actions" below. The built-in ones are **defined in code**
    (`lib/builtinActions.js`) and seeded into this table on open — see
    "Where the built-in library lives".
- **`register.js`** — how a newly-learned site/page/action *or* a new
  `generic_actions` library entry gets documented: pass it a JSON recipe
  (inline or a file), it upserts the right table(s). This replaces "write a
  new `sites/<hostname>.js` file." See its header comment for the
  `listing`, `article`, `action`, and `generic_action` JSON shapes.
- **`query.js`** — how to check what's already documented, without reading
  any code:
  ```
  node query.js sites                                # every known recipe (hostname+page_type+recipe_name) + status
  node query.js site hiringcafe.com                   # full recipe + fields (page_type defaults to listing, recipe_name to default)
  node query.js site hiringcafe.com#article           # same, for the article recipe
  node query.js site example.com#action:login         # a specific named action recipe
  node query.js runs hiringcafe.com#article           # recent run history / reliability
  node query.js expand example.com#action:purchase_item  # a composed recipe's run_action/run_generic_action refs, fully flattened
  node query.js expand generic:generic_login          # same, for a generic_actions library entry
  node query.js generic-actions                       # the library: name/description/action_type (no steps)
  node query.js generic-action generic_login           # one library entry, full detail including steps
  node query.js action-types                          # the action_type taxonomy
  node query.js health [recentN]                      # observed reliability per recipe vs its declared status
  node query.js efficiency                            # real output-size history per recipe
  node query.js sessions [hostname]                   # saved session jars (metadata only, never cookie values)
  node query.js clear-session <hostname>[:sessionName] # force a fresh login next run
  node query.js debug-captures                        # failed-run diagnostics dirs (screenshot/DOM/console/network)
  ```
- **`scrape.sh`** — thin wrapper around `engine.js` using the right Node
  binary (see version note below).

## Human handoff

An `action` recipe's `ui_steps` can include a `handoff` step for anything the
automation shouldn't do unattended — entering a 2FA/OTP code, solving a
CAPTCHA, clicking a final "place order" button. There's no channel from a
headless run back to a person mid-script, so `engine.js` inspects
`nav_template` up front and, if it contains a `handoff` step, launches a
real, visible Chrome window for that whole run instead of headless — the
window itself is the handoff. The person looks at it, does whatever
`reason` describes, and the script detects that on its own from the page:
give `resume_selector` (a CSS selector that only appears once the manual
step is done) and/or `resume_url_includes` (a URL substring reached after
it); tested live, both resolve as soon as the condition is met rather than
blocking for the full timeout. With neither, it just waits out `timeout_ms`
(default 300000ms / 5 min) blind, which is the least reliable option since
nothing confirms the step actually happened.

Because this blocks on a person, run it with a generous timeout (or in the
background) and say up front that a browser window is about to open and
what to do in it — it isn't hung, it's waiting. Shape:
```json
{"action":"handoff","reason":"Enter the 2FA code sent to your phone, then submit.","resume_selector":".account-nav","timeout_ms":300000}
```

**Capturing what the human types.** A handoff step can optionally declare
`capture` — a menu of CSS selectors mapped to variable names, e.g.
`{"fields":{"ACCOUNT_EMAIL":"#confirmed-email"}}` — naming what's available
to read back out of the page once the human is done (their typed value is
the one thing the recipe params didn't already supply). This is safe to
store in the recipe itself: it's only selectors and made-up names, never
values.

Whether anything is actually captured for a given *run* is a separate
decision, made at call time via `params.captureMode`, never baked into the
recipe:
- `"none"` (default/absent) — capture nothing.
- `"flagged"` — capture only what `capture.fields` names.
- `"all"` — capture every `input`/`textarea`/`select` on the page once the
  handoff resolves, *including* a password or 2FA code if one is still
  sitting in a field.

Per CLAUDE.md, Claude asks the user which mode to use for that specific run
**before** telling them about the upcoming handoff — this is a conscious,
per-run choice by the person running it, not a default this project picks
for them. Captured values are written to a gitignored, mode-600 temp file
under `data/.captures/<hostname>-<page_type>-<recipe_name>-<timestamp>.env`
and never appear in `engine.js`'s stdout or the `scrape_runs` log — the
result JSON's `handoffCaptures` field reports the file path and which keys
were captured, not the values themselves.

## Composing actions

An `action` recipe's `ui_steps` can reuse another action recipe as a
substep with `run_action`, instead of duplicating its steps inline. The
motivating case: a `login` action already exists, and a new `purchase_item`
action needs to start from an authenticated state — rather than
copy-pasting `login`'s goto/type/click/handoff sequence into every recipe
that needs it (and having to update every copy if the site's login form
changes), `purchase_item` just references it:
```json
[
  {"action":"run_action","ref":"login"},
  {"action":"goto","url":"{{product_url}}"},
  {"action":"click","selector":"#add-to-cart"},
  {"action":"click","selector":"#checkout"}
]
```
- `ref` is either a bare recipe name (`"login"`) — meaning "the same
  hostname, `page_type: action`, that `recipe_name`" — or fully qualified
  (`"other.com#action:sso_login"`) for cross-hostname composition (an SSO
  login on a different domain) or an explicit non-`action` page_type.
- Composition is **inline execution on the same page**, not a separate
  browser or session — a `handoff` or `capture` inside the referenced
  action works exactly as it would if that action ran standalone, and
  cookies/state carry through naturally without any extra wiring.
- All `run_action` references are expanded to one flat step list
  *recursively, up front, before the browser launches* — `lib/composeActions.js`'s
  `expandSteps` walks the tree and splices in each reference's own
  (possibly further-composed) steps. This is also how headed-browser
  detection sees a `handoff` nested three levels deep in a composed chain:
  it's checking the fully expanded list, not just the top-level recipe.
- Composed recipes share **one `params` object** with whatever they
  reference — there's no per-reference renaming in this first version, so a
  recipe and everything it composes need to agree on param names (e.g. both
  use `{{email}}`/`{{password}}`, not different names for the same value).
- Failure modes are caught **before anything runs**: a dangling reference,
  a referenced recipe that isn't `status: "working"`, or a reference cycle
  (direct or indirect — `A → B → A`) all raise a clear error immediately,
  with no browser launched. Verified live: a self-reference, a two-recipe
  mutual cycle, and a genuinely dangling reference each failed with a
  distinct, correct message in well under a second.
- `register.js` checks each `run_action` ref at registration time too, but
  **non-fatally** — a referenced recipe may not exist yet if you're building
  a composed recipe bottom-up (sub-actions first) or top-down (the
  composition first, sub-actions later) — and reports anything unresolved
  via `unresolvedReferences` in its response instead of blocking.
- See exactly what a composed recipe will run, fully flattened, with `node
  query.js expand <hostname>#page_type:recipe_name` — this is the fastest
  way to sanity-check a composition without executing it.

### The `generic_actions` library

`run_action` composes a *specific site's* recipe. `run_generic_action`
composes a hostname-**independent** entry from `generic_actions` instead —
a reusable puppeteer "macro" for behavior that doesn't depend on the site at
all: a heuristic generic login (find the password-type input and whatever's
immediately before it, type into both, submit), dismissing a cookie-consent
banner, an infinite-scroll "load more" loop. Use `run_action` when you're
reusing something a specific site's recipe already figured out; use
`run_generic_action` when the steps are genuinely site-agnostic and you'd
rather write them once.

```json
{"action":"run_generic_action","ref":"generic_login"}
```

Register a library entry with `"kind": "generic_action"` instead of the
usual hostname/page_type shape:
```json
{
  "kind": "generic_action",
  "name": "generic_login",
  "description": "Heuristic login: types into the first password-type input found, and the input immediately before it, then submits.",
  "action_type": "login",
  "nav_params_schema": "{\"email\":\"string\",\"password\":\"string\"}",
  "steps": [
    {"action":"type","selector":"input[type=email], input[autocomplete=username]","text":"{{email}}"},
    {"action":"type","selector":"input[type=password]","text":"{{password}}"},
    {"action":"click","selector":"button[type=submit]"}
  ]
}
```

Everything about composition works identically here: expansion is
recursive (a generic action's own steps can use `run_action` or
`run_generic_action`, including reusing *other* generic actions), cycle
detection covers this namespace exactly like the site-recipe one (verified
live — a self-referencing generic action, a two-entry mutual cycle, and a
dangling reference each failed immediately with a distinct, correct
message), and `register.js` checks references non-fatally the same way. The
one difference: a generic action has no fixed hostname of its own, so a
*bare* `run_action` ref inside one (meaning "whatever hostname eventually
calls this") can't be checked until something with a real hostname actually
invokes the chain — register.js's non-fatal check and `query.js expand
generic:<name>` both skip that specific case rather than falsely flagging
it. `action_type` is optional here (purely for discovery via `node query.js
action-types`) since some macros — dismissing a cookie banner, say — aren't
really a taxonomy "action_type" in the login/add_to_cart sense at all.

## Pagination

Listing recipes read the first page by default. To go further, a recipe
sets `pagination_method: "steps"` and a `pagination_config` ui_steps array
that runs after page 1's cards are ready and before the final extraction.
Callers opt in per call with `{"extra_pages": N}`; without it nothing extra
runs, so existing calls behave exactly as before. Two generic actions cover
the two common patterns:

- **`paginate`** — classic Next button (content is *replaced*). Each round:
  `collect` the current page's cards, click `{{next_selector}}`, wait. Ends
  early when Next is missing or disabled. Give it the site's selector with
  `with`:
  ```json
  "pagination_method": "steps",
  "pagination_config": [{"action":"run_generic_action","ref":"paginate","with":{"next_selector":"a[aria-label='Next page']"}}]
  ```
  Used by wellfound.com and builtin.com (verified: 3 pages each).
- **`infinite_scroll`** — results are *appended* as you scroll. Each round:
  scroll to the bottom, wait. No selector; the final extraction reads
  everything that piled up. Attached to linkedin.com's guest search, but
  as of 2026-09-26 LinkedIn loads no extra results inside the engine's
  browser (a manual Puppeteer test did get +10 per scroll), so it still
  returns the first 60 there. Unresolved.

Both take `wait_ms` to override the pause per round (defaults 2500 / 3000).
Collected pages and the final page are merged and de-duplicated by `href`
(or by whole record when a recipe has no `href` field). Output includes
`pagesVisited` (1 + number of `collect`s).

### Where the built-in library lives

The built-in generic actions are defined in **`lib/builtinActions.js`** and
seeded into the `generic_actions` table every time the DB opens. The split
is deliberate, and it's the same one the `action_types` taxonomy already
uses.

The DB earns its keep for *site knowledge*: per-site recipes are numerous,
discovered empirically, fixed by one-row updates, and carry job-search
queries and URLs — which is exactly why `data/scrapers.db` is gitignored.
Generic actions are the opposite: few, stable, hostname-independent, and
containing nothing private. They're library behavior, much closer to
`scroll_bottom` or `remove_element` (which are code) than to "how to scrape
hiringcafe." Keeping them only in an untracked DB meant they were
unversioned, unreviewable in a diff, absent from a fresh clone, and gone
with the file.

Seeding them *into* the DB keeps everything downstream unchanged:
`run_generic_action` resolution, cycle detection, `with` substitution,
`query.js generic-actions`, `query.js expand generic:<name>`.

- Re-seeding upserts **only** rows marked `source: 'builtin'`, so anything
  you register by hand is never touched.
- The flip side: editing a builtin's row in the DB is pointless — the next
  open overwrites it. `register.js` therefore **refuses** to register over a
  builtin name rather than letting the change silently revert later. To
  customize one, register it under a different name (that copy is
  `source: 'user'`); to change the builtin itself, edit
  `lib/builtinActions.js` — which is the point of it being code.

### Overlays and optional steps

A cookie/consent banner or interstitial modal covering the page will break
whatever step comes next. Handling escalates through a **ladder**, cheapest
and least-signalling rung first:

1. **Skip it** — remove the overlay container from the DOM. No consent
   signal of any kind, no click, no waiting on a selector timeout.
2. **Deny it** — if a banner is still there (its container wasn't one the
   removal list recognizes), click Reject / Decline / Necessary-only /
   No-thanks / Dismiss / Got-it / aria Close.
3. **Accept it** — opt-in only, and only if it still won't go.

The rungs compose with no conditional logic, because each is already a
no-op when nothing matches: if the removal clears the banner, the later
click finds nothing to click. Three generic actions expose this, and which
one a recipe references *is* the choice of what consent signal to send:

- **`dismiss_overlay`** (default) — rungs 1→2. Never clicks Accept/Agree:
  auto-accepting across every site is the least privacy-preserving option
  and fills the saved session jar with that site's tracking cookies. A
  banner offering *only* Accept is left alone.
- **`dismiss_overlay_accept`** — rungs 1→2→3. The decline pass is a separate
  earlier step rather than one combined selector list, because a selector
  list matches in DOM order, not in the order the selectors are written — a
  combined list would accept or reject depending on the site's markup order.
  Verified with Accept placed *before* Reject: it still clicks Reject.
- **`remove_overlay`** — rung 1 only, guaranteed never to click anything,
  for when a stray click might navigate or submit. `dismiss_overlay` already
  tries this same removal first, so prefer that unless you need the no-click
  guarantee.

Verified across all nine combinations of {recognized container, unknown
container with a Reject, unknown container with only Accept} × the three
actions.

One tradeoff worth knowing about skip-first: clicking Decline often writes
the site's "rejected" cookie, which — with session persistence on — can stop
the banner reappearing on later runs, whereas removing the node writes
nothing and pays the cost every run. Removal is still the default because it
sends no consent signal either way and is faster when it works.

All three are safely optional — nothing fails when there's no overlay. That
relies on a pattern worth knowing: a bare `click` with `stop_if_missing`
raises `StopRepeat`, which at the *top level* ends the entire remaining step
list. Wrapping it in `repeat` with `times: 1` catches that and continues, so
"try this, carry on regardless" is `repeat(1) { click stop_if_missing }`.

`remove_element` is the step behind `remove_overlay`: it deletes every node
matching `selector` (Puppeteer's `::-p-text()`/`::-p-aria()` work here, since
it uses `page.$$` rather than a native `querySelectorAll`), and with
`restore_scroll: true` also clears the `overflow:hidden` lock overlays
usually set on `body`/`html` — without that, removing the node leaves the
page unscrollable and silently breaks `scroll_bottom`/`infinite_scroll`
afterward. Nothing matching is a no-op, not a failure. For a site whose
overlay you've actually seen, compose `remove_element` directly with that
exact selector rather than relying on `remove_overlay`'s generic list.

The step types behind this work in any ui_steps list:
`repeat` (`times` may be a number or `{{param}}`, capped at 50),
`click` with `stop_if_missing: true` (absent/disabled element ends the
enclosing repeat; real links wait for the page load; hidden elements are
clicked by script), `collect` (listing only), `scroll_bottom`, and `wait`
with a `{{param}}` `ms` plus `default_ms`. `run_generic_action` also takes
`with`, which fills that library entry's `{{placeholders}}` for one use.

## Failure diagnostics

### Where it failed

Building a recipe is iterative, and every iteration used to replay the whole
sequence from a cold browser just to discover *where* it broke — the error
was a bare `Waiting for selector \`.foo\` failed: timeout`, with no
indication of which step that was or whether it even came from the recipe.

A step failure now carries its position. Both the output JSON and the
capture's `meta.json` include:

```json
"failedStep": {
  "index": 4, "of": 5, "path": [4],
  "action": "waitForSelector", "selector": "#never-appears",
  "hasText": false, "from": null
}
```

- `index` / `of` are positions in the **expanded** sequence. References are
  inlined before the run, so a recipe's own third step is not at index 2
  once a generic action's steps are spliced in ahead of it.
- `path` locates a step inside nested `repeat` blocks, e.g.
  `[3, "repeat#0", 1]`.
- `from` names the reusable action a step came from —
  `"generic:dismiss_overlay"`, or null when the step is written in the
  recipe itself. Expansion used to erase this entirely.
- `hasText` reports only *that* text was supplied. The value is never
  included, because it may be a substituted password or token.

`failedStep` is null when the failure wasn't a step failure — a zero-result
run, or a timeout waiting for cards to appear.


When a run fails — thrown error, timeout, or zero results — the engine
captures what the page actually looked like instead of leaving only an error
string to guess from. Each failure writes a directory under the gitignored
`data/.debug/`, reported back as `debugDir` in the output JSON:

- `screenshot.png` — full-page, at the moment of failure
- `dom.html` — the page's HTML, for checking what selectors *are* present
- `console.json` — browser console messages (capped ring buffer, timestamped)
- `network_failures.json` — failed requests, same shape
- `frames/` — the rolling window, see below
- `meta.json` — recipe identity, the error, the final URL, timestamp, and an
  index of the frames with their offsets

On by default; `params.noDiagnostics: true` skips it. Only the last 20
capture directories are kept — this is disposable debugging data, not an
audit trail (`scrape_runs` is that). List them with `node query.js
debug-captures`. Console/network listeners attach when the page is created,
so they cover the whole run, not just the instant it broke.

### The rolling window

A single final screenshot often can't distinguish "the page never loaded"
from "it loaded, then something navigated away" or "a modal appeared and ate
the click" — they all end on the same blank-looking frame. So the engine
also screenshots periodically into a bounded in-memory ring buffer and, on
failure, writes out the last few frames:

```
frames/frame-01-t-minus-2036ms.png
frames/frame-02-t-minus-72ms.png
```

Filenames carry how long before the failure each frame was taken, so the
sequence reads in order without opening `meta.json`. Frames are held in
memory and only written if the run actually fails, so a successful run costs
nothing but the periodic screenshot itself. A frame is taken immediately at
start as well as on the interval — otherwise a run that fails inside one
interval would capture only a frame milliseconds before the failure, i.e. a
duplicate of `screenshot.png`, which is the opposite of what the window is
for.

- `params.rollingFrames` — window size (default 6, `0` disables it while
  leaving the rest of the diagnostics intact).
- `params.rollingIntervalMs` — how often (default 2000).
- **Defaults to off on a headed run.** Headed means a `handoff`: a person is
  already watching the screen, the run can sit idle for ten minutes, and the
  frames would capture whatever they're doing in that window. Pass
  `rollingFrames` explicitly to override.

## Recipe versions

A recipe is a guess about someone else's HTML, so it rots. When a site
changes, the useful question is never "what does this recipe say now" but
**"what did it say when it last worked, and what did I change since?"**
Every registration answers that by snapshotting the recipe into
`recipe_versions`.

Versions are `v<major>.<minor>`:

- **Major (`vN.0`)** — a checkpoint. `node query.js promote` publishes
  whatever you currently have *as* the next major and marks it `stable`.
  Promoting v1.2 produces **v2.0**, and iteration then continues at v2.1,
  v2.2 … until the next promote closes the generation at v3.0.
- **Minor (`vN.1`, `vN.2`, …)** — every `register.js` call whose definition
  actually differs from the current version. These are the scaffolding of a
  troubleshooting session: cheap, disposable, auto-pruned.

**Major versions are never pruned** — that is the whole bargain. It holds
for `vN.0` unconditionally, including a first version you never got around
to promoting, not merely for blessed ones. Only `vN.<non-zero>` is ever
collected.

```
v1.0  STABLE   baseline
v1.1           iterate
v1.2           iterate
v2.0  STABLE   promote -- the checkpoint lands ON the major
v2.1           iterate
```

A re-register that changes nothing records nothing, so re-running
`register.js` to confirm a recipe is safe and doesn't spam the history.
What counts as "a change" is behavior only — `VERSIONED_SITE_COLUMNS` plus
the recipe's fields. `id`, `first_seen` and `last_verified` are excluded on
purpose, or every re-register would look like an edit.

```
node query.js versions hiringcafe.com          # history, which are stable, per-version run record
node query.js diff hiringcafe.com              # last stable vs current -- what changed since it worked
node query.js diff hiringcafe.com v2.0 v2.3    # any two versions
node query.js restore hiringcafe.com v2.0      # put an old definition back
node query.js promote hiringcafe.com 'verified against live site'
```

`diff` with no versions defaults to **last stable vs current**, which is the
question you actually have when something breaks. Long text fields (`notes`
runs to several hundred characters) are elided down to the differing span
plus context — printing both copies in full buries a one-word edit.

`restore` writes an old definition back over the live recipe and records
that as a *new* minor rather than rewinding history, so the version that
turned out to be wrong stays inspectable next to the one that replaced it.

**Runs are attributed to versions.** `scrape_runs` carries both a
`version_id` (FK to the definition) and a `version_label` (the text
`"v2.3"`). That means a failure — with its `debugDir` screenshot and DOM —
is tied to the exact definition that produced it, and
`node query.js versions` shows each version's success record, so "which one
was good" is evidence rather than memory.

**Pruning** keeps the most recent 5 scaffolding minors and drops older ones.
It can never reach a `vN.0` or a stable version — three generations plus ten
further edits still leaves v2.0, v3.0 and v4.0 intact
(`test/versioning.test.js`, "no amount of churn can drop a promoted
version").

Note it's a rolling window, *not* a consequence of promoting: the minors
that led to v2.0 are still there immediately after you promote, and age out
later as new edits push them past the window. So right after a promote you
can still diff the path that got you there; a few sessions later you can't.
If you want a specific intermediate step kept permanently, promote it.

Pruning clears the pruned version's `version_id` from its runs but never the
`version_label` — you lose the ability to diff that definition, never the
ability to read what ran.

Recipes that predate versioning were backfilled with a `v1.0` baseline
marked stable, since that *is* the version that has been in use. A recipe
promoted after that reads as v2.0, which is honest: generation two.

## Session persistence

Every `engine.js` run persists cookies across invocations — **on by
default**, no opt-in needed. `lib/runner.js`'s `withPage` loads a saved
cookie jar before `fn` (navigation) runs and saves the (possibly updated)
jar back afterward, keyed by `(hostname, sessionName)`. Concretely: log into
a site once via a `handoff`-based action recipe, and every later call for
that hostname — any recipe, any `page_type`, not just the one that logged in
— starts already authenticated, no repeat handoff.

- `params.session` (default `"default"`) names which session to use.
  Multiple **parallel sessions** for the same hostname — e.g. two different
  accounts — just use different names; they never share cookies. Cookies are
  read via CDP's `Network.getAllCookies` (not `page.cookies()`, which only
  sees the current page's URL) and filtered to ones actually belonging to
  that hostname before being saved. That match is **bidirectional**: a
  cookie scoped to a wildcard parent (`.example.com` covering
  `example.com`), *and* one scoped more specifically than the hostname (a
  host-only cookie on `www.example.com` when sessions are keyed by the bare
  `example.com`). The second direction was missing originally, which
  silently dropped LinkedIn's actual auth cookie — `li_at` is host-only on
  `.www.linkedin.com` while the recipe's hostname normalizes to
  `linkedin.com`, so only 5 irrelevant cookies were saved and every "reuse
  the session" run still demanded a fresh login.
- `params.noSession: true` skips persistence — load and save both — for one
  call, e.g. to test a truly clean/logged-out run without deleting the saved
  session.
- `session_mode: "none"` on the **recipe** does the same thing permanently,
  for a page that only works logged out (its signed-in DOM differs). Prefer
  this over telling callers to remember `noSession`: that failure mode is
  silent (0 cards, looks like the site changed) and depends on everyone
  reading the note first. `linkedin.com#listing` is the guest job search
  while the saved `linkedin.com` session is logged in — it returned 0 cards
  until the recipe declared `session_mode: "none"`.
- `node query.js sessions [hostname]` lists what's saved: hostname,
  sessionName, savedAt, cookie count — metadata only, never the cookie
  values. `node query.js clear-session <hostname>[:sessionName]` deletes
  one, forcing a fresh login (or a real `handoff`, if the recipe has one)
  next time.
- Files live at `data/.sessions/<hostname>__<sessionName>.json`, gitignored
  and mode 600, same handling as `data/.captures/`.

**This combines with `handoff` for free, no special-casing needed.** A
`resume_selector`/`resume_url_includes` check runs immediately when the
handoff step starts, not only on future page changes — so if a still-valid
session is loaded before a login recipe navigates, the site's own redirect
away from the login page (because you're already authenticated) typically
satisfies the resume condition instantly, and the whole run finishes with no
human involvement at all. A stale or expired session just falls through to
a real handoff as normal, and the fresh cookies that produces get saved
automatically for next time. Verified end-to-end (including parallel-session
isolation and the `noSession` opt-out) against a local test server before
relying on it against a real site.

## Workflow (for Claude to follow)

1. **Before assuming a site needs interactive discovery**, run
   `node query.js site <hostname>` (add `#article` or `#action` if you
   specifically want one of those rather than the results-listing recipe;
   add `:recipe_name` too if the hostname has more than one recipe of that
   page_type — `node query.js sites` shows what's registered). If it's there
   and `status: "working"`, skip straight to step 2.
2. **Known, working site** → `./scrape.sh <hostname>[#page_type[:recipe_name]] '<json params>'`
   (`#page_type` defaults to `listing`, `:recipe_name` defaults to
   `default`, if omitted — existing calls are unaffected). Add a trailing
   `--raw` only when debugging field extraction — it includes each record's
   source text as `_raw`, roughly doubling output size. Always check the
   `success` field in the JSON, not just exit code — `exit 0` only means
   "ran without crashing." A `documented:false` field means nothing is known
   about this site/page_type/recipe_name yet; `documented:true` +
   `success:false` means it's known but broken/needs-review right now, or
   this specific run failed (check `error`/`timedOut`/`consistencyWarning`).
3. **Unknown site, or `success:false`** → fall back to normal interactive
   Claude-in-Chrome tools for that visit.
4. **After a successful interactive session**, write a small JSON recipe
   (see shape in `register.js`'s header comment — `listing` for a
   card-repeated results page, `article` for a single-record detail/post
   page, `action` for a repeatable automation like login or add-to-cart —
   give it an explicit `recipe_name` if the hostname already has a recipe of
   that same page_type) and run `node register.js '<json>'` to document it. Inspect the
   live DOM/text first (dump a card's `outerHTML`, or an article page's
   `document.body.innerText`, via a one-off Puppeteer snippet) rather than
   guessing selectors — Tailwind/JIT-styled sites in particular have
   auto-generated class names that are more brittle than they look; prefer
   anchor-text traversal + positional/regex extraction over CSS class
   selectors where the class names look auto-generated (see
   `hiringcafe.com`'s listing recipe and its `notes` field for a worked
   example, including a real edge case — a stock-ticker badge with no
   separating space that broke the `company_name` regex — found and fixed
   as a one-row DB update, not a code change). For article recipes,
   `document.title` is often more reliable than blob-position parsing for
   title/company/location — see `title_regex` and the `hiringcafe.com`
   article recipe's `notes` for a real quirk it caught (a workplace-type
   *filter widget* on the page listing all options, which an unanchored
   regex matched instead of the job's actual value).

**Not yet built:** a third script to auto-detect which `page_type` a given
URL is (so a fresh session doesn't have to guess/know in advance whether a
link is a listing or an article page). Planned next step — deliberately
deferred so `listing`/`article` extraction could be validated independently
first.

## Why this saves tokens

Interactively: a `tabs_context_mcp` call, navigate, one or more screenshots
(images are the single most expensive line item), a `read_page`
accessibility-tree dump (can hit tens of thousands of characters before
truncation), and multiple chunked `javascript_tool` calls when a single
extraction kept getting truncated. Easily 8+ tool round trips.

Running a known recipe: one Bash call, one JSON object, no screenshots, no
DOM-tree dump. Confirmed on `hiringcafe.com`: the interactive session
extracting "entry level IT support" (remote) took ~8 tool calls; `engine.js`
reproduces the same 62-job/38-card result (now with named fields — `title`,
`salary`, `location`, `company_name`, `href`, etc., not a blob you re-parse
by eye) in a single call. Rough estimate from that comparison: ~3-4x token
reduction. The ceiling isn't higher than that because the underlying listing
text still has to enter context somewhere — what gets eliminated is the
scaffolding around it (screenshots, tree dumps, chunking retries), not the
data itself.

**Article pages save tokens for a different reason.** There's no "N cards in
one call" multiplier — a detail page is always one record either way — so
the win is entirely "skip the markup/attributes/nav-chrome, keep only
content text." Measured on a `hiringcafe.com` job-detail page: raw
`outerHTML` (roughly what a DOM/accessibility-tree dump would cost) was
176,060 chars (~44K tokens); the `article` recipe's full JSON output (8
named fields + a `description` full-text field) was 4,816 chars (~1.2K
tokens) — about a 36x cut. Most of that gap is markup/attributes, not
content: the page's own visible text (`document.body.innerText`) was 8,062
chars on that same page — but note that number is *unstable*: a lazy-loaded
"Similar jobs" widget (itself full listing-card markup for ~8 unrelated
jobs) can add 20K+ chars if it finishes loading before extraction runs,
which is why the recipe uses `content_stop_text` to truncate before it
rather than relying on a fixed wait time.

**Handoff-based actions (login, etc.) save tokens for a third, different
reason again — and it isn't "avoid screenshots," since a human still has to
click and type either way.** The win is that *waiting is free*:
`resume_selector`/`resume_url_includes` block inside the detached Puppeteer
process, not inside the calling agent's own tool-call loop, so however long
the human takes costs the agent nothing beyond the flat cost of kicking the
run off and reading back a small JSON result. Measured on the actual
`linkedin.com#action:login` handoff run in this project's own development
history: the calling agent's tool-call cost was one `AskUserQuestion`, two
short text messages, one call to start the run in the background, and one
call to read back a ~200-byte result — zero screenshots, zero DOM reads,
regardless of the 85 seconds the person spent actually logging in. The
interactive-browser-tools equivalent — even never touching the password
itself — would need repeated `screenshot`/`read_page` calls just to notice
when the person had finished, and screenshots are (per the numbers above)
the single most expensive line item; that gap holds whether the human takes
10 seconds or 10 minutes. This is a structural claim about tool-call shape,
not a benchmarked one — there's no automated way to test "how many tool
calls would the interactive equivalent have taken," since that's a fact
about the calling agent's own behavior, not something engine.js can observe.

**What *is* automatically testable: that output actually stays small and
structured, rather than silently regressing toward a raw dump.**
`scrape_runs.output_chars` logs the real, final stdout size of every run —
turning "what does calling this recipe cost to read" into an ongoing,
queryable number instead of a one-time claim frozen in this file. Query it
with `node query.js efficiency` (avg/min/max chars + a rough chars÷4 token
estimate, per recipe, from real run history). `test/efficiency.test.js` (run
with `node --test test/efficiency.test.js`, same Node as `scrape.sh`) is a
real regression suite against a local fixture server (deterministic, no live
site dependency): it asserts a listing recipe's output stays well under the
raw page's own size, that `--raw` actually produces more output than the
default (catching it silently becoming a no-op), that the `--raw` size
ratio stays in a sane range echoing the "roughly doubles" claim above rather
than drifting wildly, and that `output_chars` actually gets logged. One real
bug surfaced writing these: `execFileSync` (synchronous) blocks the whole
process it runs in — including a same-process fixture HTTP server's ability
to ever respond — so the first version of this suite deadlocked every test
at exactly Puppeteer's 30s navigation timeout; switched to async `execFile`.

## Determinism notes

- `scrape_runs` gives real reliability data over time instead of a status
  flag someone set once and forgot — surfaced by **`node query.js health`**,
  which reports each recipe's success rate over its most recent runs next to
  its declared `status`, and sets `statusDisagrees` when a recipe claims
  `working` but recent runs say otherwise. (The data was always collected;
  for a long time nothing computed it, so `sites` could show a confident
  `working` on a recipe that had been failing for weeks.) The window is
  recent-N rather than lifetime, so an old rough patch doesn't permanently
  condemn a recipe that works now.
- Concurrency: the DB opens in WAL mode with a busy timeout, because every
  run is a separate process opening the same file. Without both, two scrapes
  started at once were competing writers that failed *instantly* with
  `SQLITE_BUSY` — and since `openDb()` writes on every open (schema creation,
  migration checks, seed check) even for read-only commands, the losing
  process died before printing any JSON at all. That was the real cause of
  "N parallel scrapes all returned empty/truncated output", which had been
  written off as browser memory pressure.
- Each run logs `claimedCount` (the site's own stated result count, when
  `result_count_regex` is configured) alongside what was actually extracted,
  and flags a `consistencyWarning` if they disagree — this is the check that
  would have caught the ALA JobLIST failure mode (checkbox visibly checked,
  UI looked right, but the underlying result set never changed).
- A page-load timeout is reported explicitly (`timedOut: true`), separate
  from "genuinely zero results for a valid query" — these used to look
  identical.
- When a run fails, it leaves evidence rather than just an error string —
  see "Failure diagnostics" below.
- Partially implemented: a fixture/self-test mode. `test/fixtures/listing_server.js`
  serves a deterministic local page that the test suite extracts against, so
  the engine's own extraction can be exercised without any live site. What's
  still missing is replaying a saved snapshot *of a real site's page* through
  that site's real recipe — the thing that would separate "my extraction
  logic broke" from "the site changed". Also still missing: a caching layer
  keyed on params, worth adding if a recipe needs frequent iteration.

## Node version note

The system default `node` (in `$PATH`) is v16 — too old for current
Puppeteer (`>=18` required) and for `node:sqlite` (added in v22.5).
`scrape.sh` hardcodes a working Node 22 install under nvm
(`~/.nvm/versions/node/v22.20.0/bin/node`). If that nvm version ever gets
removed: `nvm install 22` and update the path in `scrape.sh`.

There's also a one-time "Degraded performance" warning from Puppeteer about
Rosetta translation on this machine — noisy but harmless; doesn't affect the
JSON output. `node:sqlite` separately prints an `ExperimentalWarning` on
every run — unrelated to Rosetta; it's just flagged experimental in Node —
also harmless. Both go to stderr, so `2>/dev/null` leaves clean JSON on
stdout.

## Running the tests

`npm test` (or `./test.sh`) runs the suite with the same Node as
`scrape.sh`. A bare `node --test` would use the v16 in `$PATH` and fail on
`node:sqlite`, which is why the wrapper exists. The suite is
`test/*.test.js`: `efficiency.test.js` (output stays small/structured) and
`diagnostics.test.js` (a failed run leaves diagnostics; a disabled one
doesn't). Both run against the local fixture server, so they need no network
and no live site.
