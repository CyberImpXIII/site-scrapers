# `submit_application_form` — contract

For the `applications/` repo, which builds approve and submit on top of this
(PLAN-applications.md §3.5, §12.2 step 7). Contract id:
**`submit_application_form/1`**. The code that owns it is
`lib/submitContract.js` (`validateSubmitResult`, `checkApproval` and
`submissionHash` are exported). `test/submit.test.js` fails if this page and
the code disagree: the status/reason table is parsed and compared with the code
both ways, and every `json submit-example` block is run through the validator.

## What it is

The **only** action here that clicks an application's submit control. It is
the irreversible half of prepare-then-confirm: it runs a packet Jacob already
approved as part of a batch, and refuses anything else.

**It is LIVE-DISARMED.** `LIVE_SUBMIT_HOSTS` in `lib/submitForm.js` is empty,
so only a loopback page (the offline fixtures) can be submitted to. Every run
against a real board returns `refused` / `live_submit_disarmed` before
anything is touched. Arming a host is Jacob's decision and a reviewed code
change; `test/submit.test.js` asserts the list is empty and must change with it.

## Calling it

```
./scrape.sh 'job-boards.greenhouse.io#action:submit_application_form' @params.json
```

While that recipe is `needs-review` (it is: nothing live has been verified),
the engine also needs `"allowUnverified": true` in the params.

| key | what |
|---|---|
| `url` | the posting URL, **exactly as approved** |
| `fields` | `describe_application_form`'s `fields` for that URL, unchanged |
| `answers` | `{selector: answer}`, **exactly as approved** (same value rules as `docs/fill-output.md`) |
| `packetId` | this packet's id, as listed in the approval |
| `approval` | the batch approval, below |

The outcome signals (`confirm_text`, `confirm_url_includes`, `error_selector`,
`error_text`) are set by the **recipe**, not the caller. A recipe with neither
confirm signal is refused `bad_params`: an outcome it could not read is not run.

### The approval

```
{
  "batchId": "b-<16 hex>",                 applications' batch id
  "approvedAt": "<ISO 8601>",
  "expiresAt": "<ISO 8601>",               at most 24h after approvedAt
  "submissions": [{"packetId": "...", "submissionHash": "<64 hex>"}, ...]
}
```

`submissionHash` binds one packet's **url, form description (formHash),
answers and the bytes of every file answer**. Compute it at approve time with
the same code the action uses:

```
node submit.js hash @params.json      # params: {url, fields, answers}
→ {"success":true,"contract":"submit_application_form/1","submissionHash":"<64 hex>","descriptionHash":"<16 hex>","files":1}
```

Do not re-implement it. If anything in the packet changes after the yes — an
answer, a re-saved resume, the URL — the action refuses `packet_changed`, and it
needs a new yes.

The action checks the approval's **consistency**, not its authenticity: that
it is well formed, unexpired, names this packet and matches this submission.
That the approval came from Jacob is the approve step's job (PLAN §3.4).

## What it does, in order

Each step refuses if it cannot decide; nothing before the click can submit.

1. approval present, well formed, unexpired, names `packetId`, hash matches;
2. the ledger (`data/submit-ledger/`): this (batch, packet) was never clicked —
   **one click per (batch, packet), ever**. A retry, including after
   `unknown`, is refused `already_attempted`; a resend needs a new batch;
3. the page's host is armed (see above);
4. the page is at the approved URL (fragment ignored);
5. no wall; a wall probe that cannot run is `wall_unknown`, not clear;
6. the live form hashes to the described one, **before** anything is filled;
7. fill (`fill_application_form`'s step): done, every answer landed, nothing
   required open, no unknown key, no navigation;
8. the form still hashes the same **after** the fill (a question that appeared
   is a question nobody approved);
9. exactly one form holds the described fields and it owns exactly one
   visible, enabled submit control;
10. neither the confirmation nor the error signal is already showing.

Then the ledger is claimed, **one** click, and the page is watched (up to
`outcome_timeout_ms`, default 20000) for the confirmation or error signal.
The HTTP status plays no part.

## The result

A top-level `submit` in the engine output (the page text is dropped).
`success` is true only for `submitted` (and the run log's `result_count` is 1
then, else 0).

| key | type | what |
|---|---|---|
| `kind` | `"submit"` | |
| `contract` | `"submit_application_form/1"` | |
| `status`, `reason` | string | the table below |
| `error` | string or null | a sentence for a person; never a value |
| `clicked` | boolean | whether the submit control was clicked |
| `submitClicks` | 0 or 1 | never more |
| `packetId`, `batchId` | string or null | echoed ids |
| `submissionHash` | 64 hex or null | what this run computed |
| `descriptionHash`, `formHash` | 16 hex or null | the described form, the live one |
| `formChanged` | boolean or null | |
| `pageHost` | string or null | |
| `fill` | object or null | the `fill_application_form/2` result (`docs/fill-output.md`) |
| `wall` | object or null | `{phase, signals, advice}`, only for `blocked-attn` |
| `observed` | object or null | after a click: `{confirmation, error, formPresent, dialogs}` |
| `finalUrl` | string or null | origin + path after the click; no query, no fragment |

The result never carries an answer value.

clicked statuses: `submitted|failed|unknown` — plus `blocked-attn` with
`wall_after_submit`. For every one of those **the application may have been
sent**: never retry it (the ledger refuses anyway); a person looks.

| status | reason | clicked | what to do |
|---|---|---|---|
| `submitted` | `confirmation_seen` | yes | done: the confirmation showed and the form is gone |
| `failed` | `error_page` | yes | the board showed its error; a person reads it |
| `unknown` | `no_signal` | yes | neither signal appeared in time; check by hand |
| `unknown` | `signals_conflict` | yes | both showed; check by hand |
| `unknown` | `form_still_present` | yes | the confirmation showed but the form is still there; check by hand |
| `unknown` | `observation_error` | yes | the page could not be read after the click; check by hand |
| `blocked-attn` | `wall_before_fill` | no | a wall on the form page; an attended run, never a workaround |
| `blocked-attn` | `wall_during_fill` | no | a wall appeared while filling |
| `blocked-attn` | `wall_after_submit` | yes | a wall after the click; check by hand |
| `needs-review` | `url_changed` | no | the page is not at the approved URL |
| `needs-review` | `form_changed` | no | the live form is not the described one: describe again, new yes |
| `needs-review` | `form_changed_during_fill` | no | a question appeared while filling |
| `needs-review` | `fill_incomplete` | no | an answer did not land, or something required is open (see `fill`) |
| `needs-review` | `navigated_during_fill` | no | the page moved while filling |
| `needs-review` | `wall_unknown` | no | the wall probes could not run |
| `needs-review` | `form_not_found` | no | the described form could not be found |
| `needs-review` | `form_not_unique` | no | the described fields sit in more than one form |
| `needs-review` | `no_submit_control` | no | the form has no visible, enabled submit control |
| `needs-review` | `submit_control_not_unique` | no | more than one: which is meant cannot be known |
| `needs-review` | `signals_present_before_submit` | no | the outcome would be unreadable |
| `refused` | `no_approval` | no | nothing submits without an approval |
| `refused` | `approval_invalid` | no | malformed, over 24h, or dated in the future |
| `refused` | `approval_expired` | no | a new batch needs a new yes |
| `refused` | `bad_params` | no | a param is missing or malformed, or the recipe has no confirm signal |
| `refused` | `packet_not_in_batch` | no | this packet was not approved in this batch |
| `refused` | `packet_changed` | no | the submission is not the one approved: new yes |
| `refused` | `live_submit_disarmed` | no | the host is not armed (every real board, today) |
| `refused` | `already_attempted` | no | clicked once already under this batch: never twice |
| `refused` | `ledger_unavailable` | no | the ledger cannot be read, so a second click cannot be ruled out |
| `error` | `internal_error` | no | a fault before the click |

`needs-review` and `refused` mean nothing was sent: fix the cause, prepare
again, and (except for `live_submit_disarmed`) it needs a new yes.

## Examples

```json submit-example
{
  "kind": "submit", "contract": "submit_application_form/1",
  "status": "refused", "reason": "live_submit_disarmed",
  "error": "submitting on job-boards.greenhouse.io is not armed: LIVE_SUBMIT_HOSTS in lib/submitForm.js is Jacob's decision",
  "clicked": false, "submitClicks": 0,
  "packetId": "pkt-0001", "batchId": "b-0123456789abcdef",
  "submissionHash": "3f1c0d6e8a9b4c2d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d",
  "descriptionHash": "8c41f0e2a9d37b65", "formHash": null, "formChanged": null,
  "pageHost": "job-boards.greenhouse.io",
  "fill": null, "wall": null, "observed": null, "finalUrl": null
}
```

```json submit-example
{
  "kind": "submit", "contract": "submit_application_form/1",
  "status": "needs-review", "reason": "form_changed",
  "error": "the live form is not the one described and approved",
  "clicked": false, "submitClicks": 0,
  "packetId": "pkt-0001", "batchId": "b-0123456789abcdef",
  "submissionHash": "3f1c0d6e8a9b4c2d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d",
  "descriptionHash": "8c41f0e2a9d37b65", "formHash": "17b2e9c04d5fa318", "formChanged": true,
  "pageHost": "127.0.0.1",
  "fill": null, "wall": null, "observed": null, "finalUrl": null
}
```

```json submit-example
{
  "kind": "submit", "contract": "submit_application_form/1",
  "status": "submitted", "reason": "confirmation_seen",
  "error": null,
  "clicked": true, "submitClicks": 1,
  "packetId": "pkt-0001", "batchId": "b-0123456789abcdef",
  "submissionHash": "3f1c0d6e8a9b4c2d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d",
  "descriptionHash": "8c41f0e2a9d37b65", "formHash": "8c41f0e2a9d37b65", "formChanged": false,
  "pageHost": "127.0.0.1",
  "fill": { "kind": "fill", "note": "the full fill_application_form/2 result: docs/fill-output.md" },
  "wall": null,
  "observed": { "confirmation": true, "error": false, "formPresent": false, "dialogs": 0 },
  "finalUrl": "http://127.0.0.1:53211/greenhouse/confirmation"
}
```

## Unverified

The Greenhouse recipe's signals (`Thank you for applying`, `/confirmation`,
`[role=alert], .error`) and the assumption that its form submits as a page
navigation are **not measured on a live board** — nothing may submit one yet.
The fixture models a native form POST. See `TODO.md`.
