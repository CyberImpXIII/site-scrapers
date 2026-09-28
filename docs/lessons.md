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
