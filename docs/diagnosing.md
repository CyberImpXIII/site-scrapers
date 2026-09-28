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

**Don't trust a recipe's `status` alone** — it's set by hand and can go
stale. `node query.js health` shows each recipe's actual success rate over
its recent runs and flags `statusDisagrees` where a recipe claims `working`
but has been failing. Check it before concluding a site broke, and prefer
fixing/re-marking a recipe over working around it silently.

No auto-detector yet for which page_type a URL is — you have to know/guess.
