# TODO

Written 2026-09-28 for a fresh session. The rules are in `CLAUDE.md`; the
detail is in `docs/`. This file is only what is *not yet done*, with enough
context to start without re-deriving it.

Delete an item when it is done. If you disagree with one, say so rather than
quietly skipping it — several of these are decisions, not chores.

---

## Waiting on Jacob — nothing else can move these

**~~Should `href` be resolved to an absolute URL?~~ DONE 2026-09-29** — Jacob
said make them absolute unless there was a good reason not to. There wasn't;
there were four things to handle, all handled: only standard URL attributes
are resolved (a `data-job-id` must not become a URL), an empty attribute must
not become the page's own URL, an unparseable value keeps what the site said,
and with no readable `baseURI` it degrades to the old behaviour. Resolved once
on the Node side against `document.baseURI` rather than inside each of the two
extraction paths. Verified live: dice and Ashby now absolute, Greenhouse and
Lever unchanged. `lib/urlAttrs.js`, `test/url-attrs.test.js`.

What settled it: the data-bridge session was mapping `dice.com#listing` into
Proficiently and all 30 of its `href` values were relative, so the consumer
would have had to prefix an origin defensively, per recipe, forever. The
inconsistency did not stay inside this repo — it propagated.

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

## Site primitives — slice 1 DONE, slices 2 and 3 next

Slice 1 (2026-09-28): `node primitives.js show <hostname>` / `./dev.sh page
<hostname>` pool what every recipe on a page knows. **Derived, not stored** —
see the header of `lib/primitives.js` for why, and do not add a table without
first hitting something that genuinely cannot be derived.

**Slice 2 is DONE** (2026-09-29): `node primitives.js try <url>` measures what
each generic action does on a page and records it; `forget <hostname>`
re-opens the question; `audit.js units` flags observations past 90 days.
Original wording kept below for the reasoning.

Two things it turned up that are worth acting on:

- **`jobs.lever.co`'s board has a consent dialog no recipe handles.**
  `dismiss_overlay` measured `changed` (dialogs 1 -> 0, elements -14) on
  `https://jobs.lever.co/palantir`. The listing recipe works anyway, so it is
  not urgent — but it is an unhandled overlay on a page we scrape, and the
  kind of thing that starts failing after a redesign. Compose
  `dismiss_overlay` into that recipe, or record why not.
- **The other ATS boards have not been tried.** Running `try` against the
  Greenhouse and Ashby boards, and against the posting pages, would probably
  turn up the same class of thing. Cheap: one command per page.

### Slice 2 — record what is NOT derivable

Slice 1 can only report actions a *recipe* already uses. The two things it
cannot answer are the interesting ones:

- **An action tried speculatively.** "Does `dismiss_overlay` do anything on
  this page?" has no answer unless a recipe already references it. Running the
  diagnostic actions against a page and recording the outcome is what makes
  primitives predictive rather than retrospective.
- **A page with no recipe at all.** Probing before writing the first recipe is
  exactly when the guesswork is worst, and today that knowledge has nowhere
  to live.

This is where storage becomes necessary, so it also needs the three gates
slice 1 avoided: a write path through a sanctioned CLI, a claim that is
**earned by a run** (an action "works here" only if a run says so — the rule
`status` already follows), and **dating plus a staleness audit**, because a
primitive asserting `dismiss_overlay` works on a page that has since changed is
precisely the "stale notes are worse than none" failure in `docs/lessons.md`.

Keep the identity function as the only definition of "same page"
(`lib/pageIdentity.js`) — a second notion of page identity is how the two
silently stop merging.

**Slice 3 is DONE** (2026-09-29): `./dev.sh plan <url|hostname>` orders the
actions worth trying on a page, and `audit.js repeats` no longer reports
already-factored shapes. What is deliberately still open is below, under
"page similarity".

One finding worth acting on: **`probe_card_candidates` under-performs on
Greenhouse's compact rows.** On `job-boards.greenhouse.io/splice` it proposed
`p x5` where the working recipe uses `tr.job-post` x7. A Greenhouse row is a
title plus a location, so it is probably falling under `repeated_structure`'s
average-text-length floor — the same floor that correctly rejects nav lists.
Worth checking whether that threshold can distinguish them.

### Slice 3 — conditional priority for generic actions

The goal Jacob stated: try the actions most likely to work here *first*, so
recipe-building gets more programmatic and finds failure points earlier.

Half of it exists. `audit.js repeats` (`findRepeatedSequences`) already finds
step sequences duplicated across recipes, which is the "what should become a
new generic action" question. What is missing is the ranking input, which is
slice 2's data: for a page of this shape, which actions have worked before.

Worth noting before building: ranking needs a notion of page *similarity*, not
just page identity — "an ATS posting page" is the useful class, and identity is
exact. That is a real design question, not a chore.

## 0d. `audit.js fixed-params` compares COUNTS, which a filter can pass blind

Run for the first time on 2026-09-29 — it was the last of the three live
audits never executed. Three recipes have a hardcoded query param; all three
came back clean, meaning none of them suppresses results. That part is a real
answer.

Two things it cannot currently see:

- **A filter that changes WHICH results you get without changing HOW MANY is
  invisible.** dice reported 34 records with `filters.workplaceTypes=Remote`
  and 33 without, which reads as "the filter does nothing" — but every one of
  30 records in a separate run was `Remote` or `Remote or <place>`, so it is
  filtering exactly as intended. The counts were similar by coincidence.
  `auditParameters` already solved this: it compares record IDENTITY via
  `ids()`, not counts. This audit should do the same.
- **A page-size cap makes the comparison meaningless.** linkedin reported
  60 vs 60 and ziprecruiter 20 vs 20 — both are almost certainly the page
  size, not the effect of the filter. With identity comparison this would
  resolve itself; with counts it cannot.

Neither is urgent: no recipe is currently suppressing results, which is the
failure this audit exists to catch (usajobs' hardcoded `rmi=true`). But an
`ok` from it is weaker evidence than it looks.

Fixed in the same run: the audit reported only FINDINGS, so its first-ever
output of "0" could not be told apart from "it checked nothing". It now names
every recipe it examined with the two counts, the way `auditWorking` and
`auditParameters` already do.

## 0c. A listing record cannot carry a PAGE-level fact (2026-09-29)

Found while handing the Greenhouse recipe to the data-bridge session. On an
ATS board the company is a property of the PAGE, not of any card — the board
IS the company — so `job-boards.greenhouse.io#listing` emits `title`,
`location`, `href` and no company at all. Same for Lever, Ashby, joblist,
workingnomads.

Listing extraction is card-scoped: `child_text` looks inside a card,
`regex_anywhere` runs against a card's text. Neither can reach a page-level
fact, so there is nowhere for "the company" to live in a record.

What a consumer can do today, and why it is not good enough:

- The engine output has **no params echo**. Checked the whole top level:
  `success, documented, timedOut, url, claimedCount, consistencyWarning,
  count, pagesVisited, records, handoffCaptures, sessionUsed, recipeVersion,
  debugDir`. The input is not in there.
- `url` carries the slug — `https://job-boards.greenhouse.io/splice` — so the
  caller can take the last path segment. Deterministic, no injection needed.
- **But the slug is not the company name.** `universalaudio` is "Universal
  Audio", `job-boards.greenhouse.io/splice` is "Splice". The page title has
  the real one (`<title>Jobs at Universal Audio</title>`). A slug in a
  human-readable column reads as a bug.

There IS precedent for surfacing a page-level fact: `claimedCount` already
does it, via `result_count_regex`. So the shape of the fix is known — a
page-level field kind, extracted once per run rather than once per card,
landing at the top level or copied onto every record. Worth doing if a second
consumer needs it; not worth inventing for one.

## 0b. Concerns carried out of slices 1-2 (2026-09-29)

Not bugs — things that are true, that I would want the next session to know
before trusting or extending this.

- **The card probe proposes selectors the audit warns about.** On the Lever
  board `probe_card_candidates` offered `div:has(div[data-qa="btn-apply"])`,
  and `audit.js units` flags a descendant `:has()` as over-matching ancestors.
  One part of the system recommends what another flags. It happened to match
  exactly 20, the same as the recipe's own selector, so it was right here —
  but the probe should either prefer `:has(> ...)` or say the count needs
  checking. Currently it says neither.
- ~~A trial makes one page request per action.~~ **WITHDRAWN — this was not a
  concern, and getting it wrong twice is the useful part.** Measured: 60.5s
  for 8 actions on the Lever board, 13.8s for one. The first version called
  that "minutes per page"; the second, told that the page never enters
  context, kept the entry alive by reaching for request volume and bot
  detection instead. Neither holds. 8 sequential loads is ordinary browsing,
  and one minute of headless Puppeteer costs nothing that matters — see
  "Wall clock is not a cost" in `CLAUDE.md`. The per-action page load buys
  independence between trials, which is worth having; there is nothing to
  optimise here.
- **An observation is filed against a page TEMPLATE but measured on one URL.**
  The Lever board findings come from `/palantir`. Another company's board
  could have a different consent state or size. Recording it as a property of
  `https://jobs.lever.co/{{company}}` is an approximation — a reasonable one,
  but if two trials of the same page disagree, that is why, and
  `times_observed` resetting is the signal.
- **`reported` does not distinguish "found what you need" from "characterised
  the page".** `diagnose_antibot: reported` and `probe_card_candidates:
  reported` rank identically on outcome alone. Section 3's ranking has to read
  the summary, not just the outcome, and currently does so only loosely.
- **Staleness is a single global 90 days.** A job board changes far more often
  than a Workday tenant. Fine as tuning; wrong as a universal.
- **`matchesEntryTemplate` treats `{{param}}` as exactly one path segment**, so
  a template whose placeholder spans slashes will not match its own URLs.
  Correct for every recipe here; worth knowing before adding one that is not.
- **Two internal scaffolding recipes now exist** (`lab-prober.internal`,
  `primitive-trial.internal`). `./dev.sh clean` removes them and
  `./dev.sh health` shows them; they are harmless but they are noise in
  `query.js sites`.
- **`try` has no `dev.sh` wrapper**, unlike every other repeated read here, so
  its JSON is what you get.

## 0. Seams found but NOT yet gated (2026-09-28)

Found while gating the hook layer, under the "Gate the seams" directive in
`CLAUDE.md`. Each is a place where a mistake would be **silent**, which is why
they are worth writing down rather than leaving to be rediscovered. None is
currently checked.

The last three were noticed mid-session, called "worth noting", and then not
written down until Jacob asked whether anything had been left out — which is
its own lesson: **an item flagged in conversation and not written to this file
does not exist.** Write it here when you see it, not at the end.

- **Probe-knowledge categories are consumed by string.** `lib/probes.js` reads
  `probeKnowledge('card_anatomy', 'utility_class')`,
  `probeKnowledgeGrouped('card_anatomy', 'field_shape')`,
  `probeKnowledge('repeated_structure', 'ad_container'|'generated_class')` and
  `probeKnowledge('forms', 'stable_attr')`. A typo in either argument returns
  `[]` and the feature **quietly does nothing** — no error, no empty-result
  warning, just a probe that stops ranking or proposing. Wanted: a test that
  every category a consumer names has rows, and every category with rows is
  named by a consumer. This is the same shape as the `nav_params_schema`
  parameter-never-read check `audit.js` already does for recipes.
- **`lib/outputShape.js` is meant to be the only way to read a run's records**,
  so that dropping the legacy `jobs` key stays a one-line change. Nothing stops
  a new reader going back to `r.jobs` or `r.count` directly. Wanted: an
  `audit.js` rule flagging those reads outside `lib/outputShape.js`.
- **`AUDIT-VERIFIED[<rule>]` waivers name a rule id** that must match one an
  audit rule actually emits. A waiver for a misspelled or retired id sits in the
  notes forever, waiving nothing, and reads as though the finding was handled.
  Wanted: an `audit.js` rule flagging a waiver whose id no rule emits.
- **`lib/gate.js` treats a severity DOWNGRADE as a new finding.** It
  fingerprints findings as `severity|unit|problem` and flags anything in
  `after` that was not in `before`. So a change that improves a finding from
  `error` to `warn` produces a string that was not there previously, counts as
  `introducedFindings`, and gets **rolled back for making things better**. Not
  hypothetical — it is why `dev.sh waive` attaches a waiver without touching
  severity, which is a workaround rather than a fix. Wanted: compare on
  `unit|problem` and only count a finding as introduced when its severity got
  *worse*. Flagged mid-session and then not recorded, which is why it is here.
- **`lab.js probe` reports `prober run failed: undefined`** when the underlying
  run fails without setting `error` — hit for real on a 404 board slug. The one
  thing the message must carry is why, and it carries the word "undefined".
  Wanted: fall back to the run's `failedStep`, `timedOut` or final URL, and say
  "the page did not load" rather than printing a missing field.
- **`register.js` takes a bare path; `lab.js set` requires `@path`.** Two CLIs
  in the same repo reading a JSON file two different ways, which cost one
  failed call this session (`register.js @file.json` → "Bad JSON: Unexpected
  token '@'"). Wanted: accept both spellings in both, or reject the wrong one
  with a message naming the right one.
- **The four `CLAUDE.md` copies** are kept in sync by a prose instruction
  ("Keeping these rules in sync"), which is exactly the arrangement that had
  already drifted for the hooks. Wanted: a check that the shared sections agree
  by meaning. Harder than the hook check, because each file legitimately carries
  tool-specific sections too — so it needs a marker delimiting the shared block.

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
  overlapping runs rather than a regression — **`./dev.sh health` will keep
  showing `DISAGREES` on it until those five failures age out of the 10-run
  window, so do not investigate it again on the strength of that flag**; and
  the three recipes that sat at
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
