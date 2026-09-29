# Diagnosing a failed or wrong run

Read this when a run fails, returns nothing, or returns the wrong thing.
The rules that always apply are in `../CLAUDE.md`.

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

**When the recipe already works, don't probe — match.** `probe_card_anatomy`
(`node lab.js inside`) reports every part of a card so you can *choose* a
`child_text` selector. For a recipe that already returns records, that choice
is redundant: the values are known, so the only question is which selector
reproduces them. `node lab.js match <target> '<params>'` answers it directly —
one line per field, giving the selector, the `segment_index` when the selector
matches more than once per card, and how many cards it held for.

```
node lab.js match nodesk.co '{"search":"engineer"}'
  -> { "title": {"selector":"a.mr-2.text-sm","everyCard":true,"varies":true}, ... }
```

It runs twice (once to learn the values, once to search for them), so if the
page's card count no longer matches the record count it drops to
set-membership and says `mode: "set"` rather than comparing one card against
another card's value.

**`selector: null` is the useful answer, not a failure.** It means no
element's full text equals that value, so the value is derived — a regex
capture, a substring, an `href` — and the current extract kind should stay.
Proposing the nearest thing instead is exactly the confidently-wrong output
that made a salary get reported as a location. And a proposal is all it is:
it can find the selector producing a value you already have, but it cannot
tell you what a field you don't already extract would *mean*.

**A zero null count is not a working field.** `lab.js peek` reports how often
each field came back `null`, which catches a field that stopped extracting. It
cannot catch the more expensive fault: a field that still fills on *every* card
with the wrong *kind* of value. That recipe reports `0/57 null` and looks
healthy. Two commands answer it:

```
./dev.sh distinct <target> '<params>'      # per-field value spread
node lab.js grep <target> '<params>' '<regex>'   # what the card text says AROUND a value
```

`distinct` prints each field's distinct values with counts, and then the direct
signal: **values appearing under more than one field name**. That is what a
positional index landing on its neighbour looks like — and it has to be checked
across the whole record set rather than per record, because the drift is usually
partial. Nine of ten cards being right is what makes it invisible. A small value
set is the other tell: a field named `location` with four distinct values is
pointing at a chip, not a place.

`grep` searches the card *source text* with surrounding context, across every
card rather than the three that `lab.js raw` samples. Use it the moment a value
looks wrong, before theorising: on workingnomads.com a `salary` of `"$100"`
turned out to be a title reading `"joining reward up to USD$100"` — a signing
bonus reported as pay. The preceding theory (a range written with an en-dash)
was wrong, and one `grep` cost less than the run that disproved it.

**Don't trust a recipe's `status` alone** — it's set by hand and can go
stale. `node query.js health` shows each recipe's actual success rate over
its recent runs and flags `statusDisagrees` where a recipe claims `working`
but has been failing. Check it before concluding a site broke, and prefer
fixing/re-marking a recipe over working around it silently.

No auto-detector yet for which page_type a URL is — you have to know/guess.
