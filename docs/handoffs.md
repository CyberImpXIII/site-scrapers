# Logins, sessions and handing control to a person

Read this before automating anything behind a login, or any step a person must
do. The rules that always apply are in `../CLAUDE.md`.

**Steps that need a human mid-run**: give a `ui_steps` sequence a `handoff`
step (2FA/OTP entry, a CAPTCHA, a final "place order" confirmation — anything
the automation shouldn't do unattended). `engine.js` detects it up front and
runs the whole thing in a real, visible browser window instead of headless,
since that window is the only way control actually reaches a person mid-run
— there's no other channel back to them. It resumes automatically once
`resume_selector` (preferred) or `resume_url_includes` appears on the page,
or after `timeout_ms` (default 5 min) if neither is given. Run the call with
a generous timeout or in the background — it isn't hung, it's waiting on
them. See register.js's header comment for the step shape.

**Before** telling the user about that upcoming handoff, ask them which
capture mode to use for this specific run (this is a per-run choice, never
something to assume or bake into the recipe):
- **none** (default/safest) — capture nothing.
- **flagged** — capture only the selectors the step's `capture.fields`
  names (values the recipe author marked as reusable/non-secret — an email,
  a reference number).
- **all** — capture every form field on the page once the handoff resolves,
  *including* a password or 2FA code if one is still sitting in a field.
  Only pick this because the user explicitly chose it, never by default.

Only after they answer do you tell them a browser window is about to open
and what to do in it, then pass their choice as `captureMode` in params.
Captured values land in a gitignored temp file under `data/.captures/` and
are never printed to stdout or logged to `scrape_runs` — the result JSON's
`handoffCaptures` gives you the file path and which keys were captured, not
the values, so don't ask for or repeat the values yourself either.

**Session cookies persist across runs ON BY DEFAULT**, per `(hostname,
sessionName)` — every call loads that session's saved cookies before
navigating and saves the updated jar back afterward, so a successful login
survives to the next call without repeating a handoff. `params.session`
(default `"default"`) selects which of possibly several *parallel* sessions
to use for a hostname — e.g. two different accounts never share cookies as
long as each run passes a distinct `session` name. `params.noSession: true`
skips persistence for one call. `node query.js sessions [hostname]` lists
what's saved (metadata only, never cookie values); `node query.js
clear-session <hostname>[:sessionName]` forces a fresh login next time. If a
recipe's page only works LOGGED OUT (its signed-in DOM differs, so a saved
session silently yields 0 results), give the recipe `"session_mode": "none"`
rather than documenting "remember to pass noSession" — the engine then
enforces it regardless of the caller. A
login recipe's `handoff` combines with this for free — a still-valid session
typically means the resume condition (e.g. redirected past `/login`) is
already true the instant the handoff step starts, so no human is needed at
all; a stale session just falls through to a real handoff as normal.
