# `fill_application_form` — output contract

For the `applications/` repo (and anything else) that calls the dry fill through
`./scrape.sh`. Contract id: **`fill_application_form/2`**. The code that owns it
is `lib/fillContract.js` (`validateFillResult` is exported — use it, or port it).
`test/fill.test.js` fails if this page and the code disagree: the reason table
below is parsed and compared with the code both ways, and both JSON examples
are run through the validator.

## What it does

A **dry fill**. Fills fields and attaches files on an application form, then
stops. It **never clicks the submit control, never presses Enter, and never
navigates**. Submitting is a separate, consented step that does not exist here.

## Calling it

```
./scrape.sh 'job-boards.greenhouse.io#action:fill_application_form' @params.json
```

`params.json` (pass large params as a file, not on the command line):

| key | what |
|---|---|
| `url` | the posting URL — the same one given to `describe_application_form` |
| `fields` | the `fields` array from `describe_application_form`'s `forms` diagnostic, **unchanged**. The whole `forms` object is also accepted. |
| `answers` | object: **key = a field's `selector` exactly as described**, value = the answer |

Answer value by control (the `control` it is reported as):

| control | answer |
|---|---|
| `text`, `textarea` | string (a number is accepted). A newline is allowed only in a `textarea`. |
| `select`, `combobox` | the option's visible text, matched **exactly** (case and spacing ignored), or a native `<select>` option `value` |
| `select`, `combobox` described `multiple: true` | a **list** of those (`["Saw", "Level"]`): the whole set to end up chosen. A one-element list is accepted by any select/combobox; a longer list on a control that takes one fails `answer_type_mismatch` and chooses nothing. `[]` is `no_answer`. |
| `checkbox`, `radio` | `true` / `false` (a radio cannot be set `false`; answer the other option `true`) |
| `file` | an **absolute** path to an existing file |

A missing, `null` or `""` answer leaves the field `unfilled` with `no_answer`.

**Several options** (added 2026-10-04, same contract id: the output shape is
unchanged, only a list answer is newly accepted). `describe_application_form`
marks such a field `multiple: true` -- a native `<select multiple>`, or a
react-select combobox whose value container is `--is-multi`
(`lib/multiSelect.js`; the fill uses the same test). The list is the whole set:

- a `<select multiple>` ends up with exactly those options selected (any
  preselected one not in the list is deselected); one entry that matches no
  option fails the field `no_matching_option` and **nothing** is changed;
- a combobox has each option chosen in turn and read back from its chips. If
  it already shows an option that is NOT in the list, it fails
  `unsupported_control` before anything is touched (removing an option is not
  supported). If entry k fails, the field fails with that entry's reason and
  `detail` says how many were chosen before it -- **those stay chosen**.
- Measured on the offline fixture only: no live Greenhouse field taking
  several options has been seen yet.

Option text is **the site's**, not a natural phrasing: live Greenhouse's
phone-country picker (labelled "Country") offers `United States +1`, so the
answer `United States` fails `no_matching_option` -- and that failure's
`detail` lists the first options offered (site vocabulary, never the answer),
so the caller can correct it. When the typed answer leaves the control's own
filter (or search) with nothing to show -- a made-up value, say -- the detail
is instead "the control offered no options for the typed answer (its own
filter or search found none)": the list was read, it was empty, and no option
text is listed. (Before 2026-10-05 that read "0 options offered, none matches
exactly", which was mistaken for a fault in reading the list.) Some controls then display an abbreviation
(`+1`); that counts as `filled` with `detail` "the control shows an
abbreviation of the chosen option", but only when the abbreviation was not
already displayed before the choice.

## Where the result is

Top-level **`fill`** in the engine output. `success` is `fill.status === "done"`.
A fill does not return `article` (it is `null`): the page text would echo the
chosen options back.

## Result shape

```json
{
  "kind": "fill",
  "contract": "fill_application_form/2",
  "status": "done",
  "error": null,
  "dryRun": true,
  "wallCheck": "clear",
  "wall": null,
  "formHash": "3f0c9a1b2d4e5f60",
  "descriptionHash": "3f0c9a1b2d4e5f60",
  "formChanged": false,
  "navigatedDuringFill": false,
  "fields": [
    { "index": 0, "selector": "#first_name", "label": "First Name*", "required": true, "group": null, "control": "text", "outcome": "filled", "reason": null, "detail": null },
    { "index": 1, "selector": "#country", "label": "Country*", "required": true, "group": null, "control": "combobox", "outcome": "failed", "reason": "no_matching_option", "detail": "3 options offered, none matches exactly" },
    { "index": 2, "selector": "input", "label": null, "required": true, "group": null, "control": "text", "outcome": "unfilled", "reason": "not_user_fillable", "detail": "aria-hidden: part of a widget, not a question" },
    { "index": 3, "selector": "#cover_letter_text", "label": "Cover Letter", "required": false, "group": null, "control": "textarea", "outcome": "unfilled", "reason": "no_answer", "detail": null },
    { "index": 4, "selector": "#question_3003\\[\\]_0", "label": "Alpha", "required": false, "group": "question_3003[]", "control": null, "outcome": "unfilled", "reason": "no_answer", "detail": null },
    { "index": 5, "selector": "#question_3003\\[\\]_1", "label": "Beta", "required": false, "group": "question_3003[]", "control": null, "outcome": "unfilled", "reason": "no_answer", "detail": null }
  ],
  "counts": { "filled": 1, "failed": 1, "unfilled": 4, "total": 6 },
  "requiredNotFilled": ["#country", "#question_3003\\[\\]_0", "#question_3003\\[\\]_1"],
  "requiredGroupsNotFilled": [
    { "name": "question_3003[]", "question": "Which platforms have you used?*", "selectors": ["#question_3003\\[\\]_0", "#question_3003\\[\\]_1"] }
  ],
  "undescribedFields": [],
  "unknownAnswerKeys": []
}
```

| key | meaning |
|---|---|
| `status` | `done` (the fill ran; read per-field outcomes) · `blocked-attn` (a wall; see below) · `error` (bad input, or the page navigated mid-fill; `error` says which) |
| `wallCheck` | `clear` · `wall` · `unknown` (a wall probe could not run — not proof of no wall) |
| `fields` | **exactly one entry per described field, in the described order** (`index` = position in your `fields`). Never fewer, never more. |
| `fields[].outcome` | `filled` · `failed` (tried, did not land; `reason` says why) · `unfilled` (not tried; `reason` says why) |
| `fields[].detail` | human-readable, **never contains an answer**. Not a stable vocabulary — branch on `reason`. |
| `formHash` | fingerprint of the live form when the fill started (`lib/formHash.js`, 16 hex) |
| `descriptionHash` | the same fingerprint of the `fields` you passed |
| `formChanged` | `formHash !== descriptionHash`: the form is not the one that was described. **Send the packet back to review** (PLAN §3.5). `null` if the live form could not be read. |
| `fields[].group` | the `group.name` of the multi-option question this field is one option of (see below), else `null` |
| `requiredNotFilled` | selectors of required, person-fillable fields that did not end up `filled`, **plus every option of a required question with no option ticked**. Empty = nothing required is open. |
| `requiredGroupsNotFilled` | each required multi-option question with no option ticked after the fill, once: `{name, question, selectors}` |
| `undescribedFields` | live fields absent from your description (person-fillable only) |
| `unknownAnswerKeys` | answer keys that match no described selector — usually a stale or hand-typed key |
| `navigatedDuringFill` | `true` means something left the page; status is then `error`. Check by hand whether anything was sent. |

The `describe_application_form` output now carries the same `formHash` on its
`forms` diagnostic, so a packet can store it and compare without re-hashing.

### Multi-option questions (new in `/2`)

Checkboxes or radios sharing a `name`, two or more, are one QUESTION. In the
description each option is its own field, `label` is the option's own text, and
it carries `group`:

```json
{ "selector": "#question_3003\\[\\]_1", "type": "checkbox", "name": "question_3003[]", "label": "Beta",
  "required": false, "hasValue": false,
  "group": { "name": "question_3003[]", "question": "Which platforms have you used?*", "required": true, "requiredEvidence": "group aria-required", "size": 3 } }
```

- **The question text is `group.question`**, never in `label`. `null` if no
  question text could be found near the options (say so; do not guess one).
- **Required-ness is the group's.** An option's own `required` is `false`;
  `group.required` says whether the question must be answered. (Greenhouse puts
  `required` on every option, which read as "tick all of them".)
- **Answer by choosing options**: `{ "<option selector>": true }` for each
  option to tick. Ticking ANY one answers a required question. Options not
  answered stay `unfilled`/`no_answer`, and that is fine.
- `hasValue` on an option is whether it is ticked.
- An option with no `id` (Lever) gets a selector qualified by its `value`
  attribute (`input[name="cards[…][field0]"][value="Yes"]`), or, with no value
  attribute either (Lever's checkboxes), by its position (an `:nth-child` path
  still anchored on the name), so each option is answerable on its own.
- `requiredCount` on the `forms` diagnostic counts a required question once.

**A description stored under `/1`** has no `group`, and every Greenhouse option
`required: true`. Its `formHash` still matches a live read (the hash reads
`required` as "the field, or its question, is required"), so it is not flagged
`formChanged` -- but the fill cannot know the options form one question and lists
every unticked one in `requiredNotFilled`. **Re-describe** to get groups.

**"Did it work" for verification** (`verify.js`, and a fair default for callers):
`status == "done"`, `counts.filled > 0` and `counts.failed == 0`.

## Reason codes

| reason | outcome | means |
|---|---|---|
| `no_answer` | unfilled | no answer given (missing, null or "") |
| `not_user_fillable` | unfilled | aria-hidden widget internals (e.g. react-select's `requiredInput` mirror) |
| `blocked_by_wall` | unfilled | a wall was found before filling; nothing was touched |
| `not_attempted` | unfilled | the run stopped before this field (bad `answers`, or a navigation) |
| `invalid_selector` | failed | the selector is not valid CSS, or the description has none |
| `not_found` | failed | an answer was given but nothing matches on the live page |
| `selector_not_unique` | failed | more than one element matches; refused rather than guess |
| `hidden_control` | failed | not visible to a person (a honeypot looks exactly like this) |
| `submit_control` | failed | the field is a button, or a click would have hit a submit control |
| `disabled` | failed | disabled or read-only |
| `unsupported_control` | failed | e.g. a password field (an account: needs Jacob), a multi-option combobox already holding an option the answer leaves out |
| `answer_type_mismatch` | failed | wrong answer type for the control (see the answer table) |
| `multiline_in_single_line` | failed | a newline in a single-line field — typing it is Enter, which submits |
| `exceeds_maxlength` | failed | longer than the field's `maxlength` |
| `no_matching_option` | failed | no option's text equals the answer (a prefix is not a match) |
| `ambiguous_option` | failed | more than one option matches |
| `cannot_uncheck_radio` | failed | `false` for a radio |
| `file_not_found` | failed | no file at that path |
| `value_did_not_stick` | failed | filled, but reading it back does not match (or focus was stolen) |
| `error` | failed | anything unexpected; `detail` has the message |

## Walls: `blocked-attn`

A login, CAPTCHA or bot wall (the same `antibot` / `blockers` probes the rest of
the engine uses) is checked **before** anything is touched, and again after.
Nothing is ever done to get past one. Treat `blocked-attn` as "Jacob needs to
look": do not retry unattended.

```json
{
  "kind": "fill",
  "contract": "fill_application_form/2",
  "status": "blocked-attn",
  "error": null,
  "dryRun": true,
  "wallCheck": "wall",
  "wall": {
    "phase": "before",
    "signals": ["loginWall"],
    "advice": "A login, CAPTCHA or bot wall is on the page. Nothing was (further) filled and nothing was attempted against it. This needs Jacob: an attended run, or his decision about an account. Do not retry unattended."
  },
  "formHash": null,
  "descriptionHash": "3f0c9a1b2d4e5f60",
  "formChanged": null,
  "navigatedDuringFill": false,
  "fields": [
    { "index": 0, "selector": "#first_name", "label": "First Name*", "required": true, "group": null, "control": null, "outcome": "unfilled", "reason": "blocked_by_wall", "detail": null }
  ],
  "counts": { "filled": 0, "failed": 0, "unfilled": 1, "total": 1 },
  "requiredNotFilled": ["#first_name"],
  "requiredGroupsNotFilled": [],
  "undescribedFields": [],
  "unknownAnswerKeys": []
}
```

`wall.phase` is `before` (nothing filled; every field `blocked_by_wall`) or
`after` (filling provoked a challenge; per-field outcomes are what happened
before it). `wall.signals` are probe names: `captcha`, `botCheck`, `loginWall`,
or `antibot:<service>`.

## Screenshot

Opt-in, per run: pass `"fillScreenshot": true` beside `url`, `fields` and
`answers`. After the fill (and its readback) the engine takes one full-page
PNG of the form as it then stands -- a screenshot and nothing else: no click,
no key, nothing that could submit. It is reported in a top-level
**`fillScreenshot`**, a sibling of `fill`, **not inside it** (the `fill` keys
are unchanged; the contract id stays `/2`). `fillScreenshot` is present exactly
when `fill` is:

| value | when |
|---|---|
| `null` | not asked for (`fillScreenshot` absent, `null` or `false`) |
| `{"path": "/abs/…/data/.fills/<stamp>__<host>__<pid>.png", "error": null}` | taken |
| `{"path": null, "error": "<why>"}` | asked for and not taken (a bad param value, or the page could not be captured). Never a guess. |

Keys of the object: `path`, `error` -- nothing else (`lib/fillScreenshot.js`
`validateFillScreenshot`; test/fill-screenshot.test.js holds this section,
the code and a real run to each other).

**The image shows the filled answers.** That is why it is never taken by
default. The file is mode 0600 in `data/.fills/` (0700, gitignored), and only
the newest 50 are kept: **copy it into your own private store if you keep
it**; the path is not permanent.

## Privacy

`answers` are never logged: `scrape_runs.params_json` keeps only their keys,
and `fields` is reduced to a count. Nothing in the output contains an answer
-- except, when asked for, the screenshot FILE that `fillScreenshot.path`
names (above); the output itself carries only the path.
