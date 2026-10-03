# `fill_application_form` — output contract

For the `applications/` repo (and anything else) that calls the dry fill through
`./scrape.sh`. Contract id: **`fill_application_form/1`**. The code that owns it
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
| `checkbox`, `radio` | `true` / `false` (a radio cannot be set `false`; answer the other option `true`) |
| `file` | an **absolute** path to an existing file |

A missing, `null` or `""` answer leaves the field `unfilled` with `no_answer`.

Option text is **the site's**, not a natural phrasing: live Greenhouse's
phone-country picker (labelled "Country") offers `United States +1`, so the
answer `United States` fails `no_matching_option` -- and that failure's
`detail` lists the first options offered (site vocabulary, never the answer),
so the caller can correct it. Some controls then display an abbreviation
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
  "contract": "fill_application_form/1",
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
    { "index": 0, "selector": "#first_name", "label": "First Name*", "required": true, "control": "text", "outcome": "filled", "reason": null, "detail": null },
    { "index": 1, "selector": "#country", "label": "Country*", "required": true, "control": "combobox", "outcome": "failed", "reason": "no_matching_option", "detail": "3 options offered, none matches exactly" },
    { "index": 2, "selector": "input", "label": null, "required": true, "control": "text", "outcome": "unfilled", "reason": "not_user_fillable", "detail": "aria-hidden: part of a widget, not a question" },
    { "index": 3, "selector": "#cover_letter_text", "label": "Cover Letter", "required": false, "control": "textarea", "outcome": "unfilled", "reason": "no_answer", "detail": null }
  ],
  "counts": { "filled": 1, "failed": 1, "unfilled": 2, "total": 4 },
  "requiredNotFilled": ["#country"],
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
| `requiredNotFilled` | selectors of required, person-fillable fields that did not end up `filled` |
| `undescribedFields` | live fields absent from your description (person-fillable only) |
| `unknownAnswerKeys` | answer keys that match no described selector — usually a stale or hand-typed key |
| `navigatedDuringFill` | `true` means something left the page; status is then `error`. Check by hand whether anything was sent. |

The `describe_application_form` output now carries the same `formHash` on its
`forms` diagnostic, so a packet can store it and compare without re-hashing.

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
| `unsupported_control` | failed | e.g. a password field (an account: needs Jacob), a multi-select |
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
  "contract": "fill_application_form/1",
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
    { "index": 0, "selector": "#first_name", "label": "First Name*", "required": true, "control": null, "outcome": "unfilled", "reason": "blocked_by_wall", "detail": null }
  ],
  "counts": { "filled": 0, "failed": 0, "unfilled": 1, "total": 1 },
  "requiredNotFilled": ["#first_name"],
  "undescribedFields": [],
  "unknownAnswerKeys": []
}
```

`wall.phase` is `before` (nothing filled; every field `blocked_by_wall`) or
`after` (filling provoked a challenge; per-field outcomes are what happened
before it). `wall.signals` are probe names: `captcha`, `botCheck`, `loginWall`,
or `antibot:<service>`.

## Privacy

`answers` are never logged: `scrape_runs.params_json` keeps only their keys,
and `fields` is reduced to a count. Nothing in the output contains an answer.
