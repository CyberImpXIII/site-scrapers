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
  knowledge base. Three tables:
  - `sites` — one row per `(hostname, page_type, recipe_name)` triple: how
    to navigate/act (`nav_method` + `nav_template`), a `status`
    (`working`/`broken`/`needs-review`), and free-text `notes`.
    `recipe_name` defaults to `"default"` and only needs to be set
    explicitly when a hostname has more than one recipe of the same
    `page_type` (see below). Three `page_type`s exist:
    - `listing` (default, back-compat) — a results page with repeated
      cards. Uses `card_anchor_text` to find them, extracts one record per
      card, pagination config, `result_count_regex` for a self-consistency
      check.
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
  - `scrape_runs` — an audit log of every invocation (params, success,
    result count vs. the site's own claimed count, duration, error). This
    is the reliability history — not just a static status flag.
- **`register.js`** — how a newly-learned site/page/action gets documented:
  pass it a JSON recipe (inline or a file), it upserts `sites` +
  `site_fields`. This replaces "write a new `sites/<hostname>.js` file." See
  its header comment for the `listing`, `article`, and `action` JSON shapes.
- **`query.js`** — how to check what's already documented, without reading
  any code:
  ```
  node query.js sites                                # every known recipe (hostname+page_type+recipe_name) + status
  node query.js site hiringcafe.com                   # full recipe + fields (page_type defaults to listing, recipe_name to default)
  node query.js site hiringcafe.com#article           # same, for the article recipe
  node query.js site example.com#action:login         # a specific named action recipe
  node query.js runs hiringcafe.com#article           # recent run history / reliability
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

## Determinism notes

- `scrape_runs` gives real reliability data over time (e.g. "3/3 recent runs
  succeeded, avg 34s") instead of a status flag someone set once and forgot.
- Each run logs `claimedCount` (the site's own stated result count, when
  `result_count_regex` is configured) alongside what was actually extracted,
  and flags a `consistencyWarning` if they disagree — this is the check that
  would have caught the ALA JobLIST failure mode (checkbox visibly checked,
  UI looked right, but the underlying result set never changed).
- A page-load timeout is reported explicitly (`timedOut: true`), separate
  from "genuinely zero results for a valid query" — these used to look
  identical.
- Not yet implemented: a fixture/self-test mode (replay a saved HTML
  snapshot instead of hitting the live site, to separate "my extraction
  logic broke" from "the site is down") and a caching layer keyed on
  params. Worth adding if a site's recipe needs iterating on frequently.

## Node version note

The system default `node` (in `$PATH`) is v16 — too old for current
Puppeteer (`>=18` required) and for `node:sqlite` (added in v22.5).
`scrape.sh` hardcodes a working Node 22 install under nvm
(`~/.nvm/versions/node/v22.20.0/bin/node`). If that nvm version ever gets
removed: `nvm install 22` and update the path in `scrape.sh`.

There's also a one-time "Degraded performance" warning from Puppeteer about
Rosetta translation on this machine — noisy but harmless; doesn't affect the
JSON output. `node:sqlite` itself prints an `ExperimentalWarning` on every
run for the same reason — also harmless.
