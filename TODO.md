# TODO

Written 2026-09-28 for a fresh session. The rules are in `CLAUDE.md`; the
detail is in `docs/`. This file is only what is *not yet done*, with enough
context to start without re-deriving it.

Delete an item when it is done. If you disagree with one, say so rather than
quietly skipping it — several of these are decisions, not chores.

---

## Waiting on Jacob — nothing else can move these

**`indeed.com` needs one attended run.** It is the only recipe not `working`.

```
node verify.js indeed.com '{"keyword":"support"}' --attended
```

It is `blocked-attn`, which means *an agent is stuck and the next step needs a
person* — not that the site is confirmed hostile. Only an attended run can
establish `blocked` (the site needs a person **every** run). Do not retry it
unattended: that already failed, and retrying is how a wall gets mistaken for a
recipe bug. Do not attempt to work around the detection under any circumstances.

---

## 0. Raise `glassdoor.com`'s `ready_timeout_ms`

The one non-`ok` result in the 2026-09-28 `node audit.js working` sweep:
`PARTIAL` — 30 records came back but the wait for
`li[data-test="jobListing"]` expired first, so the run is logged as a failure
while carrying the data. The audit's own `why` says to raise the timeout.

Do it with `node lab.js set glassdoor.com '{"ready_timeout_ms":…,"note":"…"}'`
and confirm with one solo run. Nothing else is wrong with the recipe.

---

## 1. Make the probes narrow the answer, not just bound it

Jacob's framing, and it is the right one: *do as much procedurally as possible,
so it is deterministic and you know in advance how much comes back.* A cap says
"this will never be catastrophic". It does not say "this is the answer".

`card_anatomy` currently returns up to 40 parts × 3 samples × 120 chars (~15KB).
Migrating four recipes meant reading 12–16 parts per site and deciding. Most of
that decision is mechanically derivable.

**1a and 1b are DONE** (2026-09-28, commit `90c1397`). `node lab.js match
<target> '<params>'` finds the selector reproducing each known value, and
`card_anatomy` now sorts framework utility classes into a tail via the
`utility_class` probe-knowledge category. What remains of this section is 1c
and 1d.

### 1c. Propose fields by shape — for NEW recipes

Deterministic rules over samples the probe already holds: currency → `salary`,
relative time (`3 days ago`, `4 Hours Ago`) → `posted_ago`, a closed enum
(`Full-time|Contract|Internship`) → `commitment`, the card anchor's own text →
`title`. Output a proposed field list instead of a part list.

**Hard limit, do not cross it:** a probe can find *the selector producing a
value you already have* and *selectors matching a known shape*. It cannot decide
what a novel field **means**. Per `docs/lessons.md`, a probe that guesses field
names is exactly how a salary got reported as a location. Propose with the
evidence attached; never auto-apply.

### 1d. Exclude page chrome from card and anatomy scans

`header`, `footer`, `nav`, `aside`, and sponsored/ad containers. Not
hypothetical: `workingnomads.com` counted page chrome as cards, and a sponsored
badge is exactly the optional element that causes positional drift.

---

## 2. `jobs` is domain vocabulary in a generic contract — **DONE 2026-09-28**

`engine.js` now returns `{ records: [...] }`. Every reader goes through
`recordsOf()` in `lib/outputShape.js`, which still accepts a legacy `jobs` key
so an old saved run JSON stays readable.

**The planned three-step deprecation was dropped, on evidence.** Both reasons
are worth keeping, because they are the kind of thing a later session would
otherwise re-litigate:

1. **The external consumer named here does not exist.**
   `../scripts/dedupe_import_jobs.py` parses job-apply's markdown
   (`~/.claude-job-searches/search-*.md`) and Proficiently's `job-history.md`.
   Its own `jobs` is a local variable. It has never read engine output, and
   nothing outside this repo references `scrape.sh` or `engine.js` at all.
2. **Dual-emitting cost more than the deprecation was worth.** Emitting
   `records` and `jobs` together serialises the array twice, and
   `test/efficiency.test.js` failed on it: structured output 1961 chars
   against a 1423-char raw fixture page — the transitional state broke the
   size guarantee the engine exists to provide. Keeping an alias nobody reads
   is not worth failing that.

`test/efficiency.test.js` now asserts `jobs` is **not** emitted alongside
`records`, so re-adding the alias re-fails on the same assertion.

---

## 3. Fields left on the table

Cleanly hooked, verified present, not extracted — add if a search would use them:

- **nodesk.co**: `location` (`h5.f9.fw4` index 0, e.g. `Worldwide` / `US`) and
  `salary`. For salary use a currency-shaped regex, **not**
  `div.inline-flex.items-center` index 2 — that index shifts on cards with no
  salary, which is the drift this project keeps paying for.
- **ziprecruiter.com**: benefits (`div.flex.flex-wrap`) and the `New` /
  `Posted today` badge — both only in 3 of 8 sampled cards, so genuinely
  optional. `everyCard:false` means a field on them is null on some cards, which
  is correct, but they must never be used as a positional anchor.

---

## 4. Loose ends

- **`salesforce.wd12.myworkdayjobs.com`** is the one standing `audit.js units`
  warn: a descendant `:has()` in its `card_selector`. It was checked and the
  count is right, but it has never been written down *why*, so every session
  re-checks it. Either tighten the selector to `:has(> ...)` or record the
  verification in the recipe notes so the warning stops being re-investigated.
- **Two of the three live audits still have never been run end to end.**
  `node audit.js working` was run solo on 2026-09-28: **31 recipes, 30 `ok`,
  1 `PARTIAL` (glassdoor, section 0), no `INFRA` and no `LIAR`.** That also
  settled two things worth not re-deriving: `hiringcafe.com#listing` returned
  36 records, confirming its `DISAGREES` flag was contention from a burst of
  overlapping runs rather than a regression; and the three recipes that sat at
  `working` with zero runs under their current definition
  (`jobs.lever.co#action:describe_application_form`,
  `salesforce.wd12.myworkdayjobs.com#listing`, `stepstone.de#listing`) all
  returned records, so that status is now earned.

  Still to run, **one at a time**:
  ```
  node audit.js params         # do declared parameters actually change the result
  node audit.js fixed-params   # does a hardcoded query param suppress results
  ```
  Two at once produces browser-teardown errors that look exactly like broken
  recipes — that is what the `INFRA` verdict is for. If you see `INFRA`,
  re-run that recipe alone before concluding anything.
- **`register.js` can now add a builtin** with `"builtin": true` plus a `note`.
  Nothing else has used that path yet; `probe_card_anatomy` was the first.

---

## Standing constraints — these are not negotiable and not up for optimisation

- **Never** submit a form, apply to a job, create an account, or enter real
  credentials. Describing a form is safe; filling one is not.
- **Never** attempt to bypass bot detection. A detected wall means
  `blocked-attn` and an attended run — never a workaround.
- Credential-shaped values are caller-supplied params at run time, never written
  into a stored recipe.
- Captured handoff values live in gitignored mode-600 files under
  `data/.captures/`. Report key names only, never values, and never ask Jacob to
  repeat one.
- `data/` is gitignored and stays that way.
