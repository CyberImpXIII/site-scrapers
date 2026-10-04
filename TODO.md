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

## fill_application_form (PLAN-applications phase 1) — Greenhouse DONE 2026-10-03, open items

Built: `fill_application_form` builtin + `job-boards.greenhouse.io#action:fill_application_form`
(`working`, earned by a live verify on the discord posting with fake text answers,
no upload). Contract `docs/fill-output.md`, gated by `test/fill.test.js` (offline
fixture `test/fixtures/ats/`). Open:

- **Multi-option questions are groups (DONE 2026-10-03, contract `/2`).** Reported by
  the applications agent: Greenhouse twitch/jobs/8623401002 `question_37220519002[]`
  described as 6 checkboxes, each `required:true`, no question text, so no answer
  could make the packet ready. Confirmed live; Lever (palantir) was worse: id-less
  options shared one `input[name=…]` selector, so `selector_not_unique` on every
  option. Fixed in `lib/probes.js` (`group` {name, question, required, size};
  option `required:false`; `hasValue` = checked; id-less options get a
  value-qualified selector, else an `:nth-child` path), `lib/fillForm.js` (`requiredGroupsNotFilled`, group read from
  the live page after the fill), `lib/formHash.js` (required hashed as field OR
  group, so stored GREENHOUSE descriptions do not flip `formChanged`). Gated by
  `test/option-groups.test.js` (both shapes in fixture `?groups=1`). Live after
  the fix: twitch 59 fields, the question's 6 options grouped with its text,
  formHash `c2094073540661d7` unchanged; Lever palantir 56 fields, 0 duplicate
  selectors (was a 33-option language question on one selector), 4 groups with
  their question text. Not yet run live: a FILL against either. Open:
  (a) a stored LEVER description DOES flip formChanged (its option selectors
  changed); that is correct -- those options could not be answered anyway --
  but applications must re-describe; (b) the question text is found by
  fieldset/legend, role=group, then a climb to the nearest non-option text: on
  an unknown layout it may be `null` (honest) or, if two questions share an
  ancestor with no other field between, take the wrong neighbour's text --
  unmeasured beyond Greenhouse/Lever; (c) Ashby measured only with a single
  checkbox, no group seen yet; (d) `requiredNotFilled` is capped at 50, and the
  validator's "group options are also in requiredNotFilled" check would
  misfire past that cap. **Reported to the coordinator**: applications reconciles
  against `fill_application_form/1` and must re-run against `/2`.

- **UNCONFIRMED SUSPICION: rolling screenshots break the Ashby entry click.** The 15s
  entry window (4124cda) fixed Lever: 5/5 live runs gave 56 fields. Ashby supabase
  with default `scrape.sh` still gave 0 fields on 5 of 16 runs (13 otherwise); with
  `rollingFrames:0` 13/13 gave 13, and a trace script without rolling capture 5/5.
  The failing runs were FAST (18-21s vs 25-42s) and stayed on the posting URL: the
  button was present and clicked, nothing opened. Suspect `lib/debug.js`
  `startRollingCapture` (`page.screenshot` every 2s, maybe a re-layout under
  Rosetta) racing Ashby's client-side click handler. Probe that settles it: 20 runs
  each of `{"rollingFrames":0}` vs default, interleaved, alone on the machine. If
  confirmed, decide whether rolling capture should pause around a click step. Since
  2026-10-03 such a run reports `broken`/`inconclusive` under verify.js instead of
  `working` (lib/describeVerdict.js), so it is no longer silent there.
- **describe 0-field verdict (DONE 2026-10-03, lib/describeVerdict.js).** A recipe typed
  `describe_form` is judged on described fields, in verify.js AND the engine's
  logged `result_count`. Limits left open: (a) keyed on the declared action_type, so
  a describer typed otherwise escapes it -- gated by `test/describe-verdict.test.js`
  over the stored recipes; (b) ">= 1 field" is a floor -- a posting page carrying a
  newsletter form would pass; (c) OLD `scrape_runs` rows from 0-field describes still
  carry result_count 1, so `definitionHasPassingRun` stays true for those definitions
  and a 0-field verify reads `inconclusive`, not `broken`, until the definition
  changes. Telemetry is not rewritten. (d) a describe that hits a wall reports no
  wall: 0 fields leaves no debugDir capture for verify.js to read.
  No flips: live `verify.js --dry` after the change gave Greenhouse twitch 59 fields,
  Lever palantir 56, Ashby supabase 13/13/13, all `working`; offline audit clean.
  Approval note: the coordinator relayed Jacob's "and 0-field fix"; it was not in
  the quoted "Jacob's words" this session received.
- **addon-bench and tools/setup hook copies: DECLARED 2026-10-03** (check-hooks.sh,
  gated in test/hooks.test.js: drift, a missing twin, and the whole folder gone each
  fail for both). Declared locations are now checked at ANY depth (`all_locations`:
  find depth 4 UNION every declared dir), and `--sync` uses the same set. All 10
  copies logic-identical; every copy's own test-*.sh passes from addon-bench and
  tools/setup. Both CLAUDE.md copies added to the rules-sync list (the top level
  had added them during the same session). Still open, NOT ours:
  (a) the brief said knowledge-base has "its own check-hooks.sh with the same
  DECLARED list" -- it has none (`grep -rn DECLARED knowledge-base` is empty; its
  `./dev.sh hooks` checks only its own folder). Its `./dev.sh sync` compares its
  CLAUDE.md list to the top level's, so it now needs `../addon-bench/CLAUDE.md` and
  `../tools/setup/CLAUDE.md`. Reported via the dispatcher 2026-10-03.
  (b) unverified, observed by heading grep only: `emailTools/CLAUDE.md` has no
  "## Report a problem in someone else's code" heading, and
  `scriptingTools/data-bridge` and `scripts` have no "## Gate the seams" heading;
  they may carry the rule under another heading. Settle: read each file's
  sections. The rules-sync test checks the LIST only, not that each copy carries
  the shared sections.
- **register.js builtin edits now export before the gate's tests** (the test
  subprocesses re-seed from the file, so they were judging the OLD version). Gated
  only by the open_apply_form edit that exposed it (3 failures before, 92/0 after);
  no automated test drives a builtin edit end to end, since that writes the real
  export. The rollback re-export was probed once by hand: reinstating the old default
  was rejected (3 failures), and the DB row and the export were both left unchanged.
- **This machine runs x64 node under Rosetta** (Puppeteer prints a "Degraded
  performance" warning on every launch). Slower page loads widen every timing race
  above. Jacob's to decide (an arm64 node); not changed here.
- **Live file upload unverified.** The fixture proves `#resume` upload; the live run
  answered text and comboboxes only. Next live verify should attach a fake .txt.
- **Multi-select comboboxes unsupported** (one answer string = one option). No
  Greenhouse field seen needing it yet; a `multi-value` readback exists, the fill does not.
- **The phone-country picker is labelled just "Country"** on live Greenhouse and its
  options carry the dial code (`United States +1`). A caller matching on the label
  will answer `United States` and get `no_matching_option` (detail lists offers).
  deep-work should know; it is in the doc.
- **describe output changed shape** (lib/probes.js): ids/names are `CSS.escape`d
  (`#\34 033064002`), fields gain `role`/`ariaHidden`, forms gain
  `formHash`/`totalFields`/`truncated`, forms cap 40 -> 80 (`MAX_FORM_FIELDS`;
  card anatomy keeps `MAX_FIELDS` 40). Any consumer that
  string-matched old selectors breaks; none known.
- **Debug captures may hold filled values.** A failed fill run's screenshot/HTML in
  `data/` (gitignored) shows what was typed. Not redacted; decide whether a fill
  should skip debug capture.
- **Lever/Ashby**: slots are commented in `test/fixtures/ats/server.js`
  (`ATS_FIXTURES`); add a fixture there and the per-ATS tests run for it.
- **Greenhouse form hashes shifted once on 2026-10-03** (captcha exclusion + upload
  labels, both fixed that day, fixture-tested). Discord posting 8815116002: was
  `d0bf2718bad97856` (and `8ac1c3261efa20e3` without the late captcha), now
  `8312cdf56c2724f3` in 2 of 2 live describes, 32 fields, `captchaFieldsExcluded: 1`.
  A packet prepared before then reads `formChanged=true` once (the cautious
  direction); re-describe. The "Resume/CV*" part of the report did NOT reproduce
  there: the group is `aria-required="false"` with no `*`, so `required:false` is
  right for that posting; the label ("Attach" for both uploads) was the real bug.
- **`test-prefer-recipes.sh` flake: not reproduced on a clean tree** (2026-10-03):
  5 of 5 solo runs and 4 of 4 runs while `./dev.sh test` ran alongside all passed.
  It picks its hosts from `query.js sites` live, so the likeliest cause of the one
  failure is the DB changing under it (a gated register.js mid-rollback, which
  flips rows and re-exports builtins) rather than the hook. Unconfirmed; if it
  recurs, record which cases and what `query.js sites` returned at that moment.
- **Delegation hooks**: this session started with no "Jacob's words" (SubagentStart
  `quote-words.sh` not wired; `./.claude/agents.sh wiring`). Reported to dispatcher.

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

- ~~Lever board consent dialog~~ **DECIDED 2026-10-03: not composed**, reason in the
  recipe notes (v1.1, verify: `working`, 319 records). Non-modal dialog, read-only
  recipe, 319 DOM cards = 319 records with it on screen; composing would force
  url_param -> ui_steps for no measured gain.
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

## 0f. New recipe requested: bandcamp.com article (release date) — LOW PRIORITY

Asked for by the `gmailsenderscript` session on Jacob's behalf, 2026-09-29. Not
urgent; nothing is blocked on it.

`emailTools`' Bandcamp digest currently labels its date column "email date",
because Bandcamp's notification emails carry no release date. The release date
is on the album/track page, so this is an `article` recipe.

- **Input**: album or track URLs, e.g. `https://artist.bandcamp.com/album/slug`
  or `/track/slug`. Already absolute and stripped of `?from=` tracking, so no
  cleanup step is needed.
- **Wanted**: release date. Pages read "released September 25, 2026", and
  "releases <date>" for a pre-order — so a released/pre-order flag is part of
  the answer, not a nice-to-have: the same field means different things and a
  consumer sorting by date would treat a future release as an old one.
- **Nice to have**: artist, label, tags.
- **Volume**: the digest can hold thousands of albums (9,228 releases in
  Jacob's inbox), so it is called per album on demand or in batches, never all
  at once. Worth confirming Bandcamp's rate tolerance before any batch use —
  and note the standing rule: a detected wall is a result to report, not an
  obstacle to route around.
- **Consumer**: `emailTools/bandcamp_digest.py`. Jacob also wants that digest
  to move toward a recipe + data-bridge design, so it may end up called through
  data-bridge rather than directly. Build the recipe to stand alone either way.
- **Hostname note**: every artist is its own subdomain (`artist.bandcamp.com`),
  so one recipe cannot be keyed by hostname per artist. Register it under
  `bandcamp.com` and confirm the `prefer-recipes` hook's subdomain matching
  covers `*.bandcamp.com` — it matches a subdomain against a recipe host, which
  is the case this needs, but it has not been exercised in this direction.

## 0e. Recipe defects found by bridging 11 recipes into Proficiently (2026-09-29)

Found by the data-bridge session consuming these recipes for real, which is a
better test than any audit here — it reads the VALUES, not just whether a run
returned rows. Ordered by how wrong the output is, not by effort.

**A derived value must not be a free-form parameter.** `glassdoor.com`'s
`kw_end` has to equal `7 + slug.length` (it is Glassdoor's keyword offset,
`KO7,<end>`). Get it wrong and the run **succeeds with fewer results**:
`slug=support kw_end=99` returns 5 records, `kw_end=14` returns 30, both
`success:true`, no warning. `nav_params_schema` was also NULL, so the engine's
own error — "check nav_params_schema" — pointed at nothing, and a consumer
reasonably concluded the recipe had drifted. Schema written (v1.6), which is a
warning, not a fix. **The fix is a computed param**: the engine substitutes
only caller-supplied values, so there is no way to express "this one is
derived". Worth adding — this recipe cannot be used correctly by anyone who
has not read the note.

**`ziprecruiter.com` has no job link.** Its only URL field is `company_href`,
pointing at the company's job list rather than the posting. Honestly named, so
nothing is lying — but the recipe cannot answer "where is this job", and the
bridge had to carry no url at all. `docs/lessons.md` names this exact shape (an
href pointing at a company page while being read as a job link) as one of the
expensive bugs. Check whether a per-card posting href is extractable; if it is
not, say so in the notes so the next person stops looking. **ANSWERED
2026-09-29: it is not, and the notes now say so.** The SERP is a two-pane
layout — the title is a `div`, not an anchor, and clicking a card loads the
posting into the right-hand pane rather than navigating, so a posting URL does
not exist in the list markup. Evidence rather than inference:
`div.job_result_two_pane_v2 a[href]` counts 80 across 20 cards, which is
exactly the company and location anchors at two each and nothing else. Getting
a posting URL would need a per-card click, which a listing recipe cannot do.
`company_href` stays honestly named and **must not** be mapped as a job link.

**`remoteok.com` emits two dirty fields and is missing one.**
- `title` keeps a trailing badge: `"Customer Support & Success Specialist VERIFIED"`.
- `posted_ago` is not a date, it is a concatenated blob:
  `"🇨🇦 Canada 🔒🇺🇸 United States 🔒💰 $50k - $70k\t\t 26d"`.
- No `location`, although it is plainly inside that blob.
This is positional extraction drifting across a multi-part cell. `lab.js match`
exists for exactly this: the values are known, so the selectors are findable
rather than guessable.

**`jobspresso.co` has no company name**, only `company_blurb`:
`"Hopper Hopper uses big data to predict flight and hotel prices..."` — the
name doubled and run into prose. Deriving "Hopper" from that is a guess, so it
was left unbridged. **DONE 2026-09-29 (v1.4, verified `working`, 30 records)** —
`div.job_listing-company strong` is the name alone and
`span.job_listing-company-tagline` the tagline alone; they were one blob only
because the field was positional. Every other field on this recipe was
positional too and is now addressed directly.

**`workingnomads.com` and `joblist.ala.org` emit only `title` and `href`.** No
company at all, which makes them unbridgeable where a company is required.
Both are thin recipes that were never finished rather than broken ones.
**workingnomads DONE 2026-09-29 (v1.8, verified `working`, 57 records)** — it
was never thin: `div[data-testid="card-company"]` was sitting there unused, and
`title`, `location`, `commitment`, `experience_level` and `salary` all came out
too. It is the recipe that forced `child_text value_pattern` (shape addressing;
see the commit), because its chips are optional and no index identifies them.
Doing it the obvious way first produced two **wrong** values that no null count
would have shown — `commitment: "Freelance"` and `experience_level:
"Executive"` read out of TITLES by a blob regex — so this one is also the
worked example for why `lab.js distinct` and `lab.js grep` now exist.
**`joblist.ala.org` DONE 2026-09-29 (v1.9) but NOT re-verified — see below.**
Also never thin: the old `card_selector` matched the innermost wrapper around
the title link, so the card's entire text *was* the title and
`probe_card_anatomy` reported it as having no text-bearing children at all. The
real card is three levels up, `div:has(> div > div > a[href*="/job/"])`, with
clean hooks (`div.job-company-row`, `div.job-location`, `div.job-posted-date`).
All four ancestor levels report the same count of 28, so counting cannot tell
them apart — the text *sample* is what does, via `lab.js sel`. A run returned
**25 records with all seven fields non-null**.

Two things left open, deliberately:
- **Do not run `verify.js` on it yet.** Right after that run the site stopped
  serving its list on ten consecutive attempts, having served it roughly one in
  three before, following ~15 requests in a short window. That reads as rate
  limiting, and a verify against a rate-limited site would record a verdict of
  `broken` against a definition that demonstrably returns 25 full records.
  Leave it alone, then verify. (Not routed around: no retry loop, no backoff
  trickery, no UA change.)
- **`labels` is unconfirmed.** It came back non-null on all 25, but the anatomy
  probe found the badge spans on only 1 of 8 sampled cards. Either the first
  page is genuinely all-Preferred (it is sorted that way) or the field is
  picking up something that is not a per-card badge. `./dev.sh distinct
  joblist.ala.org '{}'` settles it: one distinct value across every record
  means it is not a per-card field and should be dropped.

**This site is ~1-in-3 flaky even when healthy**, which is recorded in its
notes. An empty result here is a retry, not breakage — and that is worth
remembering before anyone reads a failure as a regression.

Not defects, recorded so they are not re-investigated: `glassdoor.com` is
genuinely `working` (30 records throughout — the report of it returning
nothing was the `kw_end` footgun above), and `usajobs.gov` returning
"Andersen Air Base, Guam" is correct behaviour for a recipe with no remote
filter, which is the consumer's to handle.

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

**Added 2026-10-02 (check-hooks twin set):**
- `check-hooks.sh` fail-open runs each script WITHOUT its registered
  arguments, on purpose (`agent-watch.sh spawn|stop` would write into the top
  level's agent ledger). So a hook that fails CLOSED only in one mode is not
  caught here; that is its owner's `test-<hook>.sh` to cover.
- The top-level CLAUDE.md says the three scraper hooks live in **two** copies;
  the checker finds **six** (top level, site-scrapers, emailTools, scripts,
  scriptingTools/chronjobScheduler, scriptingTools/data-bridge), all in step.
  Prose belongs to the dispatcher; reported in the 2026-10-02 handback.
  Now **seven** with `knowledge-base` (2026-10-02), all declared in
  `DECLARED` in `check-hooks.sh`; the top-level prose still needs the count.
  **Ten** as of 2026-10-03 (+ applications, addon-bench, tools/setup).
- `addon-bench/candidates/graphify/work/src/emailTools/.claude/hooks` holds a
  fourth-level copy of the twins (a benchmark's work tree, depth 7). Discovery
  does not reach it and it is not declared, on purpose: it is a fixture, not a
  tool folder. If addon-bench ever runs a session from there, its hooks are
  unchecked.

**Added 2026-10-02 (hooks resolved the wrong repo; browser-ok race) -- OPEN until synced:**
- Two looser identity rules failed in turn. "Any dev.sh" (tests) took
  knowledge-base; "dev.sh AND engine.js" (hooks AND tests, ec9f889) took
  scriptingTools/data-bridge, so data-bridge's LIVE prefer-recipes.sh allowed
  builtin.com (exit 0; 2 from here). Now identified by package.json name.
  Resolution faults FAIL the hook tests instead of skipping.
- The hook test wrote and deleted the live `data/.browser-ok`: 3 of 4
  concurrent runs failed here, and every run deleted any real override. Now a
  private `SS_BROWSER_OK` (honoured by the hook and `dev.sh browser-ok`).
- Gated: `check-hooks.sh` section 4 runs every prefer-recipes.sh copy on a
  covered host (it flags data-bridge today); mock-workspace tests in
  `test/hooks.test.js` (fixtures in `test/fixtures/hook-workspace/`).
- **The other six copies are NOT synced**: all four hook files drift until
  they are (top level still holds the pre-ec9f889 tests). `--sync` writes into
  other owners' folders, so it is left to a dispatch. Delete this item once
  `./dev.sh hooks` is clean again.
- Not probed: troubleshooting.sh per location (no blocked-attn recipe in the
  real DB to probe with). Its find_repo is the same code as prefer-recipes',
  and the mock-workspace test covers it, but check-hooks does not run it live.
- Unconfirmed: both tests hardcode `NODE_BIN=$HOME/.nvm/versions/node/v22.20.0`.
  A machine without that exact node would get empty `sites` and skip (now
  loudly). Probe: run with that path absent.

**Added 2026-10-02 (DECLARED hook locations):**
- Workspace vs standalone is decided by ONE marker, the top level's
  `.claude/agents.manifest.json` (the harness's roster file). If harness moves
  or renames it, every run here flips to standalone: absent copies become
  `UNCHECKED` (counted in the last line) instead of ERROR. Loud, not silent,
  but weaker. Nothing tells harness this file is load-bearing here -- report it.
- Unconfirmed suspicion: on a standalone clone, discovery still `find`s every
  `.claude/hooks` up to depth 4 under the PARENT folder. Cloned into `~`, that
  would pick up `~/.claude/hooks` and anything else nearby as "copies" and may
  raise false ERRORs. Probe: copy the repo to a scratch parent holding an
  unrelated `.claude/hooks/foo.sh` and run `./check-hooks.sh`. Possibly limit
  discovery to DECLARED locations in standalone mode.

**Added 2026-10-02 (batch-yes application rule):**
- The application rule ("one yes covers a presented batch") is restated in
  four places here: `CLAUDE.md` Absolute constraints (authoritative),
  `docs/recipes.md` (describe_form passage), the `open_apply_form` description
  in `lib/builtinActions.js`, and the Standing constraints at the foot of this
  file. Nothing checks they agree; the per-application wording survived one
  rewrite already (06df444). Wanted: fold into the CLAUDE.md-sync check below,
  or point the three restatements at CLAUDE.md instead of paraphrasing it.

Found while gating the hook layer, under the "Gate the seams" directive in
`CLAUDE.md`. Each is a place where a mistake would be **silent**, which is why
they are worth writing down rather than leaving to be rediscovered. None is
currently checked.

The last three were noticed mid-session, called "worth noting", and then not
written down until Jacob asked whether anything had been left out — which is
its own lesson: **an item flagged in conversation and not written to this file
does not exist.** Write it here when you see it, not at the end.

- **The gate races its own verification tests over the live DB.** `guardedChange`
  applies the mutation and *then* runs the scoped test files — and several of
  those files (`page-identity`, `primitives`, `audit`) assert against the real
  `data/scrapers.db` rather than a fixture. So the gate's own write is in flight
  while the tests that are meant to validate it walk the same rows. Observed
  2026-09-29 applying a note to `joblist.ala.org`: the *identical* input rolled
  back on three attempts and passed on two, with `introducedFindings: []` and
  `actionTests.failed: 0` on the passing ones. The same nine files run alone
  pass 5 times out of 5. **A gate that intermittently rejects a valid change is
  worse than no gate**, because the failure teaches you to re-run it until it
  passes — which is exactly the habit a gate exists to prevent. One contributing
  cause is already fixed (`page-identity` was counting other files' `127.0.0.1`
  fixtures as live data); the structural one is not. The fix is for live-DB
  tests to run against a copy, or for the gate to test outside the mutation
  window. Note also that **every rejected attempt still bumps the version** —
  the joblist note went v1.6 → v1.8 before it landed — so retrying leaves
  history churn behind.
- **`lab.js`'s prober registers itself as `action_type: 'login'` and performs no
  login** (`lab.js:91`). It is there only to satisfy the action-type taxonomy
  gate, which has no category for a read-only diagnostic. So the taxonomy — the
  thing that exists to make an action's purpose a deliberate choice — carries a
  false entry, and anyone auditing action types sees a login recipe that never
  logs in. Either add a `diagnose` type or exempt the internal prober; do not
  leave a wrong value in the data whose whole job is to be right. Found while
  trying to register a scratch diagnostic recipe and being correctly refused.
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

- ~~`salesforce.wd12` descendant `:has()` warn~~ already recorded: an
  `AUDIT-VERIFIED` waiver in its notes (2026-09-28: 20 matches = 20 title anchors,
  `li` do not nest there), printed by `./dev.sh check` as `OK/W`. Nothing to do.
- **The three live audits have all been run solo.**
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

  **Confirmed by the reporter, 2026-09-29.** The `gmailsenderscript` session
  owns that runner and says it was running 4 engine processes at once, which is
  the contention signature exactly; its runner is now sequential and its TODO
  corrected. It also expects **`weworkremotely.com`'s 4-of-4 navigation
  timeouts came from the same parallel runs — likely contention, unconfirmed**,
  with a sequential re-run in progress to settle it. Do not act on that report
  as a recipe fault until the sequential result lands. This is the second time
  a parallel-load failure has been read as a regression by two sessions, which
  is the argument for §0b's open question of whether `health` should discount a
  tight failure cluster rather than leaving every reader to spot it.

  The one `PARTIAL` (glassdoor) is fixed: `ready_timeout_ms` 30000 → 50000, and
  it now runs `success=true` at 30 records. Extraction was never the problem —
  same just-past-the-deadline race already recorded on builtin.com,
  weworkremotely.com and the Workday tenant.

  `node audit.js params` was also run solo on 2026-09-28: **26 recipes, 11
  `ok`, 0 genuine `INERT`, 9 `UNVALIDATABLE`, 5 false `INCONCLUSIVE`.** Both
  non-`ok` groups turned out to be audit defects rather than recipe faults, and
  both are now fixed — see section 5.

  `node audit.js fixed-params` run solo 2026-10-03: 12 ui_steps recipes audited,
  3 with a hardcoded param, all `ok` -- dice 34 with / 30 without, linkedin 60/60,
  ziprecruiter 20/20. Same caveat as section 0d: it compares counts, so 60/60 and
  20/20 are page-size caps, not proof the filter is inert or harmless.

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

- **Job applications are prepare-then-confirm** (Jacob, 2026-10-02): fill the
  form, upload documents, answer the questions, then stop and present the
  prepared batch (applications, roles, companies, and each irreversible step:
  the submit, any account creation). One explicit yes covers exactly the batch
  presented; anything prepared after it needs its own yes. Nothing submits
  unattended. Never create an account, submit anything else, or enter real
  credentials without him. CLAUDE.md "Absolute constraints" is authoritative.
- **Never** attempt to bypass bot detection. A detected wall means
  `blocked-attn` and an attended run — never a workaround.
- Credential-shaped values are caller-supplied params at run time, never written
  into a stored recipe.
- Captured handoff values live in gitignored mode-600 files under
  `data/.captures/`. Report key names only, never values, and never ask Jacob to
  repeat one.
- `data/` is gitignored and stays that way.
