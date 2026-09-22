# site-scrapers

One generic Puppeteer engine, driven by a SQLite database of "how to scrape
this site" recipes, instead of a bespoke JS file per website. The point is
twofold: cut token spend on repeat visits to a known site (one Bash call
returning structured JSON instead of screenshots + DOM dumps + chunked
extraction calls), and make what's already known about a site *queryable*,
so a fresh/context-less session can check `query.js` instead of needing to
remember or re-derive it.

## Architecture

- **`engine.js`** — the only scraping code. Takes a hostname + params, looks
  up that site's recipe in the DB, executes it, extracts fields, logs the
  run, prints one JSON object. Nothing site-specific is hardcoded here.
- **`data/scrapers.db`** (SQLite, via Node's built-in `node:sqlite`) — the
  knowledge base. Three tables:
  - `sites` — one row per hostname: how to navigate there (`nav_method` +
    `nav_template`), how to detect a loaded results page
    (`card_anchor_text`), pagination config, a `status`
    (`working`/`broken`/`needs-review`), and free-text `notes`.
  - `site_fields` — named, enumerable fields per site (e.g. `title`,
    `salary`, `location`, `href`), each with an extraction rule
    (`positional_segment` / `regex_anywhere` / `anchor_attribute`).
  - `scrape_runs` — an audit log of every invocation (params, success,
    result count vs. the site's own claimed count, duration, error). This
    is the reliability history — not just a static status flag.
- **`register.js`** — how a newly-learned site gets documented: pass it a
  JSON recipe (inline or a file), it upserts `sites` + `site_fields`. This
  replaces "write a new `sites/<hostname>.js` file."
- **`query.js`** — how to check what's already documented, without reading
  any code:
  ```
  node query.js sites                # every known site + status
  node query.js site hiringcafe.com  # full recipe + fields for one site
  node query.js runs hiringcafe.com  # recent run history / reliability
  ```
- **`scrape.sh`** — thin wrapper around `engine.js` using the right Node
  binary (see version note below).

## Workflow (for Claude to follow)

1. **Before assuming a site needs interactive discovery**, run
   `node query.js site <hostname>`. If it's there and `status: "working"`,
   skip straight to step 2.
2. **Known, working site** → `./scrape.sh <hostname> '<json params>'`. Add a
   trailing `--raw` only when debugging field extraction — it includes each
   record's source text as `_raw`, roughly doubling output size.
   Always check the `success` field in the JSON, not just exit code —
   `exit 0` only means "ran without crashing." A `documented:false` field
   means nothing is known about this site yet; `documented:true` +
   `success:false` means it's known but broken/needs-review right now, or
   this specific run failed (check `error`/`timedOut`/`consistencyWarning`).
3. **Unknown site, or `success:false`** → fall back to normal interactive
   Claude-in-Chrome tools for that visit.
4. **After a successful interactive session**, write a small JSON recipe
   (see shape in `register.js`'s header comment) and run
   `node register.js '<json>'` to document it. Inspect the live DOM first
   (dump a card's `outerHTML` via a one-off Puppeteer snippet) rather than
   guessing selectors — Tailwind/JIT-styled sites in particular have
   auto-generated class names that are more brittle than they look; prefer
   anchor-text traversal + positional/regex extraction over CSS class
   selectors where the class names look auto-generated (see
   `hiringcafe.com`'s recipe and its `notes` field for a worked example,
   including a real edge case — a stock-ticker badge with no separating
   space that broke the `company_name` regex — found and fixed as a
   one-row DB update, not a code change).

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
