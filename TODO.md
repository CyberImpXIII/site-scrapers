# TODO

Written 2026-09-28 for a fresh session. The rules are in `CLAUDE.md`; the
detail is in `docs/`. This file is only what is *not yet done*, with enough
context to start without re-deriving it.

Delete an item when it is done. If you disagree with one, say so rather than
quietly skipping it — several of these are decisions, not chores.

---

## Waiting on Jacob — nothing else can move these

**Should `href` be resolved to an absolute URL?** An output-contract change, so
it is his call rather than one to make late in a session.

`anchor_attribute` returns the raw attribute, so a recipe's `href` is absolute
when the site writes it absolute (Greenhouse) and relative when it does not
(Ashby: `/linear/c21af93e-…`). A caller cannot use `record.href` directly
without knowing which site produced it, which is the kind of inconsistency that
gets discovered by a broken fetch rather than by reading the docs.

The fix is one line in `engine.js`'s extraction — resolve URL-bearing
attributes against `document.baseURI`, which is what the DOM's own `el.href`
property does. It would change the output of every recipe whose site uses
relative links, so it needs: a decision that absolute is the contract, a sweep
of the recipes it changes, and `test/efficiency.test.js`'s `'/job/1'` assertion
updated to the absolute form.

**Is a parameterised Workday-tenant recipe worth building?** The big unlock for
the pro-audio and AV manufacturers, and it needs a design decision first.

None of Sennheiser, Audio-Technica, Shure, Rode, Neumann, Genelec, ADAM Audio,
PreSonus, Behringer, SSL, Blackmagic, Ross Video, Wheatstone, Riedel, Evertz,
AJA, Atomos, Teradek, Sound Devices, Lectrosonics, Clear-Com or Biamp has a
Greenhouse or Lever board — checked with `./dev.sh board`. They are on
enterprise ATSes, mostly Workday, which is where the roles closest to Jacob's
current AV/broadcast support work actually live.

The obstacle is structural, not a matter of effort: the recipe DB is keyed by
`(hostname, page_type, recipe_name)`, and every Workday tenant has its OWN
hostname — `<tenant>.<wdN>.myworkdayjobs.com`, with a different `wdN` shard and
a different career-site path per employer. So the one-recipe-per-ATS trick that
worked for Greenhouse, Lever and Ashby cannot apply as-is. The options, none
free:

1. One registered recipe per tenant, all sharing the field definitions. Honest
   and works today; `salesforce.wd12.myworkdayjobs.com#listing` is already this.
   Costs a registration per employer and duplicates the definition N times,
   which `audit.js repeats` exists to complain about.
2. Allow a wildcard/templated hostname so one recipe covers
   `*.myworkdayjobs.com` with tenant and site as params. The clean answer, but
   it touches recipe lookup, `parseSiteArg`, and the uniqueness key.
3. Treat it as an `article`-style recipe taking a full `url`, losing listing
   extraction.

Option 2 is the real fix and is a genuine feature, not a chore — hence it is
here rather than done.

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

**Section 1 is DONE** (2026-09-28). `node lab.js match <target> '<params>'`
finds the selector reproducing each known value (1a); `card_anatomy` sorts
framework utility classes into a tail via the `utility_class` category (1b);
it proposes a field name from a known value shape, and declines rather than
guessing, via `field_shape.<name>` (1c); and `repeated_structure` sorts
header/footer/nav/aside and ad containers last via `ad_container` (1d).

All four vocabularies are DATA in `lib/probeKnowledge.js`, so meeting a new
framework or date format is a row rather than a release. **All three of the new
ones rank rather than filter**, which is the one thing not to "simplify" later:
a utility class is sometimes a card's only hook, and a site whose list really
does live in an `<aside>` must still be reported. Both properties have tests
asserting the thing is still present, separately from the tests asserting its
position.

The original wording of 1c and 1d is kept below, because the reasoning is worth
more than the checkbox.

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

## 2b. ATS board listings — DONE 2026-09-28, and what they cover

Greenhouse, Lever and Ashby each had `#article` and
`#action:describe_application_form` but no `#listing`, so a single posting could
be read while a company's openings could not be enumerated. All three now have
one, parameterised by company slug — one recipe per ATS, because the slug is the
only thing that differs between employers.

| target | verified on | also tested |
|---|---|---|
| `job-boards.greenhouse.io#listing` | splice | discord (49), universalaudio (5) |
| `jobs.lever.co#listing` | palantir (321) | spotify (81) |
| `jobs.ashbyhq.com#listing` | supabase (55) | linear (30) |

`./dev.sh board <company> ...` finds a slug. It only checks Greenhouse, Lever
and Breezy, because those are the only ones where a missing slug is
distinguishable — Ashby serves a byte-identical shell for every slug, Recruitee
redirects unknown slugs to its marketing site, and Workable echoes the slug back
capitalised. An Ashby slug can only be confirmed by running the recipe.

**Universal Audio is on Greenhouse** and is the one pro-audio maker found this
way — 5 openings, one of them remote. Every other audio/AV manufacturer checked
is on an enterprise ATS; see the Workday item at the top.

Two things worth not rediscovering:

- **A Greenhouse board can be fully custom.** `job-boards.greenhouse.io/figma`
  matches nothing — `tr.job-post`, `table tr` and `.job-post` all return 0 —
  because Figma replaced the hosted board with its own app (1.74MB against
  splice's 39KB). Zero records means "custom board", not "wrong slug".
- **The Ashby `commitment` field was wrong before it was right**, in the way
  this repo keeps paying for. It read the last bullet-segment of the details
  blob: correct on supabase's 3-segment blob (`Full time`), wrong on linear's
  4-segment one, where it confidently reported `Remote` for all 30 records. It
  matches the employment-type words themselves now. A regex anchored to `$` is
  positional extraction wearing a different hat.

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

  The one `PARTIAL` (glassdoor) is fixed: `ready_timeout_ms` 30000 → 50000, and
  it now runs `success=true` at 30 records. Extraction was never the problem —
  same just-past-the-deadline race already recorded on builtin.com,
  weworkremotely.com and the Workday tenant.

  `node audit.js params` was also run solo on 2026-09-28: **26 recipes, 11
  `ok`, 0 genuine `INERT`, 9 `UNVALIDATABLE`, 5 false `INCONCLUSIVE`.** Both
  non-`ok` groups turned out to be audit defects rather than recipe faults, and
  both are now fixed — see section 5.

  Still to run:
  ```
  node audit.js fixed-params   # does a hardcoded query param suppress results
  ```
  Never two at once: contention produces browser-teardown errors that look
  exactly like broken recipes, which is what the `INFRA` verdict is for. If you
  see `INFRA`, re-run that recipe alone before concluding anything.

## 5. Nine recipes still can't have their parameters proven

`node audit.js params` reports `UNVALIDATABLE` for these — they declare
parameters but have no `param_probe_values`, so rule 5 is unenforced on them:

- `indeed.com#listing` — blocked anyway, so this is moot until section 0 above.
- `job-boards.greenhouse.io` (`#article`, `#action:describe_application_form`),
  `jobs.ashbyhq.com` (both), `jobs.lever.co` (both) — the parameter is a `url`,
  so two contrasting values are just two live postings. Those expire, which is
  why nobody has added them; a pair of long-lived postings would fix six
  recipes at once.
- `linkedin.com#action:login` and `facebook.com#action:login` — the declared
  parameter is `captureMode`. **Do not add probe values for these.** Validating
  would mean running a login twice, and `captureMode: "all"` exists precisely
  to read credentials out of a page. `audit.js` should exempt a login action's
  `captureMode` instead of asking for it; until it does, the `UNVALIDATABLE`
  on those two is correct and should stay.

Two defects behind that same sweep are already fixed (2026-09-28):

- **Article recipes were counted as zero.** `auditParameters` and
  `auditFixedParams` read `r.count`, which an article run leaves at 0 while
  putting its record in `article`. Every article recipe therefore looked like
  it returned nothing on both runs — 5 false `INCONCLUSIVE`s, each of which
  reads as "your probe URLs are dead". Both now use `countOf()` from
  `lib/outputShape.js`, which is also what `auditWorking` had open-coded.
- **`remoteok.com` was a false `INERT`.** Its probe tags were
  `customer-support` and `support`, and the site redirects the second to the
  first, so the two were synonyms for one filter. `INERT` claims the recipe
  ignores its parameters and would have sent someone to re-derive a working
  recipe. `auditParameters` now checks whether both runs ended on the same
  final url and reports `INCONCLUSIVE` naming that url instead. Probe values
  swapped to `customer-support` / `design`.
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
