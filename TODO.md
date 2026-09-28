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

## 1. Make the probes narrow the answer, not just bound it

Jacob's framing, and it is the right one: *do as much procedurally as possible,
so it is deterministic and you know in advance how much comes back.* A cap says
"this will never be catastrophic". It does not say "this is the answer".

`card_anatomy` currently returns up to 40 parts × 3 samples × 120 chars (~15KB).
Migrating four recipes meant reading 12–16 parts per site and deciding. Most of
that decision is mechanically derivable.

### 1a. Match known values — fully deterministic, do this first

For a **migration**, the answer is already known: `node lab.js peek <target>`
prints the values the current recipe produces. So the step is a *search*, not a
report — **find the minimal selector whose text equals this value in every
card**. One line per field, no judgement, and provably correct because it is
validated against output that already exists.

This would have replaced every judgement call made on builtin.com, nodesk.co,
wellfound.com and ziprecruiter.com. Rough shape:

```
node lab.js match <target> '<params>'
  -> { title: "a.mr-2.text-sm", company: "h3.f8.fw4", ... }
```

Cost comparison measured while doing it by hand: page HTML ~500KB, raw
`lab.js inside` ~6KB, hand-filtered with jq ~1.2KB, and this would be ~200B.

### 1b. Rank semantic over utility — do NOT exclude

Most of what `card_anatomy` reports is framework noise. On builtin.com the top
of the list was `div.col-12.col-lg-7`, `div.d-flex.align-items-start`,
`div.d-none.d-xl-block` — pure Bootstrap — while the two real hooks were
`div.left-side-tile-item-2` and `-3`.

**Sort semantic-first and collapse the utility ones into a short tail. Do not
drop them.** On builtin.com `div.d-flex.align-items-start` is the *only* hook
for four fields (time, locations, salary, level); excluding utility classes
would have left nothing. This is a ranking problem, not a filtering one.

The vocabularies belong in `failures.db` as a new probe-knowledge category
(`utility_class`), **not in code** — same reason the build-hash patterns live
there: meeting a new framework should be a data change. Seed with Bootstrap
(`d-flex`, `col-*`, `fs-*`, `mb-*`, `gap-*`, `justify-*`), Tailwind (`flex`,
`items-*`, `px-*`, `text-*`, `w-full`, `space-x-*`), Bulma (`is-*`, `has-*`).

Add it via `node failures.js` — see `lib/probeKnowledge.js` for the baseline
shape and the reasoning about what is knowledge vs. tuning.

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

## 2. `jobs` is domain vocabulary in a generic contract

`engine.js:1106` returns `{ jobs: [...] }` for **every** listing recipe. Scrape
a product catalogue and the records come back under `jobs`. Same class as the
`record_nouns` leak already fixed, but this one is in the contract: `audit.js`
and `lab.js` read `r.jobs` — 27 references across three source files plus three
test files.

Sequencing (it is a breaking change, so do not do it in one step):
1. Emit `records` as canonical **and** keep `jobs` as an alias.
2. Move every reader to `records`.
3. Drop `jobs` in a separate commit.

Check `../scripts/dedupe_import_jobs.py` before step 3 — it consumes this output
and lives outside this repo.

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
- **Live audits have never been run end to end.** Their verdict logic is now
  tested offline (`test/live-audits.test.js`), but the real sweeps take minutes
  and need a network:
  ```
  node audit.js working        # does every "working" recipe still return records
  node audit.js params         # do declared parameters actually change the result
  node audit.js fixed-params   # does a hardcoded query param suppress results
  ```
  **Run them one at a time.** Two at once produces browser-teardown errors that
  look exactly like broken recipes — that is what the `INFRA` verdict is for. If
  you see `INFRA`, re-run that recipe alone before concluding anything.
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
