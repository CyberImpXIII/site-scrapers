# Lessons paid for once

Specific mistakes made in this project, each of which cost real time and each of
which looks reasonable until you know better. They are here because a fresh
session would otherwise rediscover them the expensive way.

The rules that always apply are in `../CLAUDE.md`. Recorded failures with their
fixes are queryable: `node failures.js common` and `node failures.js match <host>`.

---

## A wrong answer is worse than a failure

Most of the expensive bugs here produced *plausible* output rather than an error.

- `wellfound.com` reported a **salary string as a location** on cards with no
  location. The regex matched any pipe-segment containing a bullet, and
  salary/equity segments contain bullets.
- `builtin.com` reported a **timestamp as a location** on 4 of 18 cards.
- `linkedin.com` promised remote-only results via a hard-coded `f_WT=2` that the
  guest search **silently ignores** — every card was city-specific.
- `nodesk.co` accepted `{"search":"sales"}` and `{"search":"engineer"}` and
  returned **byte-identical** records, because the site filters client-side and
  never reads `?s=`.

Prefer `null` over a guess. If a field cannot be found, say so.

## `card_selector` and `card_anchor_text` are not interchangeable — one is also the READINESS signal

Adding `card_selector: "tr.job"` to remoteok.com, a recipe that was returning
50 records via `card_anchor_text: "Apply"`, dropped it to **one empty record**.
The selector was not wrong: `tr.job` matches all 50 rows on a loaded page, and
`lab.js sel` confirmed 50/50 while the recipe returned 1.

`waitForCards` polls for `card_selector` when one is set. remoteok has a
`tr.job` in the DOM *before its rows have content*, so the wait resolved
immediately and extraction ran against an unrendered page. `card_anchor_text`
waits for text that only exists once a row is real, which is why it worked.

So the choice is not only "how do I identify a card" — it is also "what
counts as the page being ready". A structural selector that matches an empty
scaffold row is a worse readiness signal than a piece of text that only
appears with real content, even though it is the better card identifier.

Symptom to recognise: a recipe returns ONE record with every field null, while
probing the same selectors against the same URL reports the full count. That
gap between the probe and the run is the tell — the probe waited, the run did
not.

## Positional extraction drifts; address elements directly

`positional_segment` assumes every card has the same parts. An optional rating,
a sponsored badge or a missing location shifts everything after it. Use
`child_text` (a CSS selector inside the card) unless the card shape is genuinely
fixed. Four recipes were bitten before that kind existed.

Note a subtlety found while testing it: an **inline** optional element merges
into its neighbour's text (`"Company 04.5"`), while a **block** element creates a
new part and shifts indices. Different bugs, different fixes.

## "It returns nothing" has four different causes

Ruled out in this order, cheapest first:

1. **The query genuinely has no matches.** `usajobs.gov` looked like a broken
   SPA for an entire investigation — selectors, walls and rendering all ruled
   out — until a human ran it and said the search showed zero results. The real
   cause was a hardcoded `rmi=true` in the template suppressing everything.
   `node audit.js fixed-params` now catches that class.
2. **A wall.** `node failures.js match <host>`, then the antibot probe.
3. **The page never rendered.** Slow SPAs need a big `ready_timeout_ms`, and
   `lab.js probe/sel --wait=MS` — the 5s default reported 0 matches for a
   selector a Workday recipe uses successfully.
4. **The selector is wrong.** Last, not first.

## Site notes go stale, and stale notes are worse than none

`ziprecruiter.com`, `glassdoor.com` and `joblist.ala.org` all carried confident
"CONFIRMED BLOCKED / Cloudflare / 503" notes that were accurate when written and
wrong months later. Those notes are what stopped anyone re-deriving three
working sites. `audit.js units` now flags a recipe whose notes claim a block
while its status says otherwise. Date every note.

## `:has()` matches ancestors too

A descendant `:has()` matches every wrapper up the tree, not just the card.
`div:has(a[data-testid=...])` matched **144 nodes where 20 were wanted** on
ziprecruiter, and counted page chrome as cards on workingnomads. Use a
direct-child `:has(> ...)`, or a tighter selector, and always check the count is
the number of cards rather than a multiple of it.

## Contention looks exactly like broken recipes

Running two live sweeps at once produced "detached Frame", "Execution context
was destroyed" and "Target closed" across five recipes that all returned records
when run alone. A false `LIAR` verdict sends someone to fix something that
works. The audits now report `INFRA` for this; re-run alone before believing it.

**A navigation timeout is the ambiguous case, and is deliberately NOT `INFRA`.**
`weworkremotely.com` failed 4 of 4 runs with "Navigation timeout of 30000 ms
exceeded" and `failedStep: null` — every one of them alongside 4 parallel engine
processes. Run alone, the same two param sets returned 27 and 25 records.

So it behaves like contention, but unlike "detached Frame" it is also exactly
what a dead URL, a site outage or a genuinely broken recipe looks like. Adding
it to `INFRA_ERRORS` would make `INFRA` a catch-all that hides real breakage —
`test/live-audits.test.js` asserts that boundary on purpose. **The rule is
procedural instead: a repeat under parallel load is not evidence about the
recipe. Re-run alone first, and only raise `ready_timeout_ms` if the solo run
also fails.**

That case also exposed a second cause worth knowing: `page.goto` had a hardcoded
30s timeout at every call site, so a recipe could declare `ready_timeout_ms`
60000 and still be cut off at 30 seconds *while navigating*. The navigation
timeout now derives from `ready_timeout_ms` (floored at 30s, so it can only
lengthen). If you see a timeout whose number does not match the recipe's own
setting, that mismatch is the finding.

## Tests that pass for the wrong reason

- `authorizeForTests()` sets a permanent global flag, so once any test file
  opened writes, **four** later assertions that a write is *refused* passed
  vacuously. Call `revokeTestAuthorization()` in a test that checks a refusal.
- A backtick inside a SQL comment broke `lib/gate.js`'s template literal, and
  **130 passing tests did not notice**, because nothing required the file. There
  is now a test that requires every library module.
- A fresh-clone test with a hand-maintained dependency list broke three times,
  once per new dependency, each time looking like a regression rather than a
  stale fixture. It derives the list now.

## Guarantees must not depend on the other side's shape

The forms probe built each field by **spreading** the object page context
returned. A spread passes through any extra key, so a `value` appearing there
would have been published — and the one thing that probe must never emit is a
field's value. Output caps had the same shape: enforced only inside
`page.evaluate`, so they depended on that code being reached. Both are now
enforced on the Node side from an explicit allowlist.

## A rule you have read is not a constraint

`CLAUDE.md` rule 4 has said "never write an inline script blob" for a long time.
The session that wrote that rule then hand-authored the same ~100-character `jq`
filter **four times in a row** while migrating four recipes, and chained
`test && audit && git status` by hand three times — a sequence the same file
tells you to run before every commit.

Neither was ignorance; both were read and agreed with. Repetition just does not
feel expensive in the moment, and each individual instance looks too small to
stop for. That is the whole failure mode.

Rule 4 is now enforced by a `PreToolUse` hook rather than stated, and the
repeated sequences are `dev.sh check` and `dev.sh inside`. The general lesson is
the one this project keeps relearning: **make the wrong thing impossible, not
discouraged** — the same reasoning as the write guard, the validation gate and
the read-only generated export. If you catch yourself typing something for the
second time, that is the signal, and the destination is already decided (a
`dev.sh` subcommand, a CLI, or a script file).

## Things that are deliberately NOT done

Each of these was considered and rejected for a stated reason. Don't quietly
reverse one.

- **No bot-detection evasion.** The launch config removes flags whose only
  function is advertising automation (`navigator.webdriver`,
  `--enable-automation`). It does **not** patch `navigator.plugins`, spoof WebGL
  strings, or install a stealth plugin. `test/runner.test.js` asserts no evasion
  flags are present, and that boundary is the point.
- **Probe *kinds* stay in code.** Only their *knowledge* (attributes, phrases,
  markers) lives in the DB. Executing JavaScript stored in a writable row would
  be arbitrary code execution from a data store.
- **Numeric thresholds stay in code.** They are tuning, not knowledge; making
  them editable invites widening them until a probe reports noise.
- **`lib/builtinActions.js` is a GENERATED export**, written read-only. The DB is
  the source of truth. Edit a builtin with `register.js`, never by editing the
  file.
- **Recipes are not committed.** `data/` holds Jacob's search history and is
  gitignored. The shared library reaches a clone through code files instead.
