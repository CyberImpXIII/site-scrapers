#!/usr/bin/env node
// Documents a site (or updates its documentation) in the database.
// Call this after successfully figuring out a site interactively — it's the
// replacement for "write a new sites/<hostname>.js file."
//
// Usage:
//   node register.js '<json>'
//   node register.js path/to/site-def.json
//
// A hostname can hold more than one recipe. What disambiguates a recipe is
// (hostname, page_type, recipe_name) together — "recipe_name" defaults to
// "default" when omitted, so existing single-recipe-per-page_type callers
// are unaffected. Give it an explicit name when a site has more than one
// recipe of the same page_type, e.g. two "action" recipes on the same
// hostname: {"page_type":"action","recipe_name":"login",...} and
// {"page_type":"action","recipe_name":"add_to_cart",...}. Look them up with
// engine.js/query.js via "<hostname>#<page_type>:<recipe_name>".
//
// Session cookies persist across runs ON BY DEFAULT, per (hostname,
// sessionName) — mostly a call-time concern, with one recipe-level
// exception: "session_mode": "none" (see below). Every engine.js run loads
// that session's saved cookies before
// navigating and saves the (possibly updated) jar back afterward, so a
// successful login survives to the next call without repeating a handoff —
// see "Human handoff" in README.md for how that combines with a `handoff`
// step. params.session (default "default") names which of possibly several
// PARALLEL sessions to use for a hostname, e.g. two different accounts:
// {"session": "work_account"} vs {"session": "personal_account"} never
// share cookies. params.noSession: true skips persistence entirely for one
// call. Inspect what's saved with `node query.js sessions [hostname]`
// (metadata only — hostname/sessionName/savedAt/cookieCount, never cookie
// values) and force a fresh login with `node query.js clear-session
// <hostname>[:sessionName]`.
//
// "session_mode": "none" — set this on a recipe whose page only works
// LOGGED OUT, i.e. its signed-in DOM differs enough that a persisted
// session breaks extraction. The engine then skips loading and saving a
// session for that recipe regardless of what the caller passes. Use it
// instead of documenting "remember to pass noSession" in
// nav_params_schema: that failure mode is silent (0 cards, looks like the
// site changed) and depends on every caller reading the note first. Real
// case: linkedin.com#listing is the logged-out guest job search, and the
// saved linkedin.com session (from linkedin.com#action:login) is logged in
// — it returned 0 cards until that recipe declared session_mode:"none".
// Omit the field (NULL) for the normal case.
//
// JSON shape (page_type: "listing", repeated cards — the default):
// {
//   "hostname": "example.com",
//   "page_type": "listing",              // optional, defaults to "listing"
//   "recipe_name": "default",            // optional, defaults to "default" -- see above
//   "display_name": "Example Job Board",
//   "status": "working",                 // or "broken" / "needs-review" / "blocked"
//     "blocked" means the recipe works but the SITE needs a human every run
//     (CAPTCHA, login wall, 2FA) -- nothing to fix, so do not re-derive it.
//   "nav_method": "url_param",           // or "ui_steps"
//   "nav_template": "https://example.com/?q={{query}}",
//   "nav_params_schema": "{\"query\":\"string, required\"}",
//   "pagination_method": "none",
//   "card_anchor_text": "View job",      // required for page_type: "listing"
//   "card_min_text_len": 80,
//   "ready_timeout_ms": 20000,
//   "result_count_regex": "([\\d,]+) results",
//   "notes": "free text",
//   "fields": [
//     {"field_name":"title","extract_kind":"positional_segment","segment_index":1,"example_value":"IT Support Specialist"},
//     {"field_name":"href","extract_kind":"anchor_attribute","attribute_name":"href"}
//   ]
// }
//
// anchor_attribute + regex_pattern (listing only): regex_pattern is repurposed
// as an optional CSS selector, queried within the card, when the
// card_anchor_text element isn't the link you want the attribute from (e.g.
// card_anchor_text="View Company Profile" marks the card, but the real job
// link is a different <a> inside it: {"field_name":"href","extract_kind":
// "anchor_attribute","attribute_name":"href","regex_pattern":"a[href^='/remote-jobs/']"}).
// Omit it to read the attribute off the matched anchor itself (default).
//
// card_selector (listing only, instead of card_anchor_text): a CSS selector
// matching each card container directly, for sites where no literal text
// appears once in every card (no shared "Apply"/"View job" link). The card's
// first <a> is then used as the anchor for anchor_attribute fields, e.g.
// "card_selector": "[data-testid='job-card']".
//
// child_text (listing only): the text of a named element INSIDE the card.
//   regex_pattern is a CSS selector; segment_index optionally picks the nth
//   match (default 0, negative counts from the end).
// {"field_name":"title","extract_kind":"child_text","regex_pattern":"h2"}
//
//   PREFER THIS OVER positional_segment whenever a card's shape varies.
//   positional_segment splits the card's text on " | " and takes the Nth piece,
//   which assumes every card has the same parts. Cards routinely do not: an
//   optional company rating, a sponsored badge, a missing location. Everything
//   after the variable part shifts by one, silently, and the record stays
//   plausible while being wrong — a location reported as "2 Days Ago", or a
//   salary string reported as a location. That happened on four sites before
//   this kind existed. Addressing the element directly is immune: a missing
//   element yields null instead of shifting its neighbours.
//
// ancestor_first_line (listing only): for layouts that group several cards
// under one header (e.g. a company name with its jobs listed beneath it).
// regex_pattern is a CSS selector for the group container; the value is the
// first line of that container's text:
// {"field_name":"company_name","extract_kind":"ancestor_first_line","regex_pattern":"div.rounded.border"}
//
// JSON shape (page_type: "article", one record per page, e.g. a detail/post page):
// {
//   "hostname": "example.com",
//   "page_type": "article",
//   "status": "working",
//   "nav_method": "direct_url",          // goto params.url as-is; or "ui_steps"
//   "nav_template": "{{url}}",           // caller passes {"url": "https://example.com/post/123"}
//   "content_selector": null,            // CSS selector for the content container; null/omitted = document.body
//   "content_stop_text": "Related posts",// optional: truncate text at first occurrence (cuts off recommendation widgets etc.)
//   "card_min_text_len": 200,            // reused as: min chars before content_selector is considered "loaded"
//   "ready_timeout_ms": 20000,
//   "notes": "free text",
//   "fields": [
//     {"field_name":"title","extract_kind":"title_regex","regex_pattern":"^(.+?) \\|"},
//     {"field_name":"body","extract_kind":"full_blob"}
//   ]
// }
// extract_kind for article fields: "regex_anywhere" | "positional_segment" |
// "anchor_attribute" (against content_selector's own attributes) | "title_regex"
// (matches against document.title) | "full_blob" (the whole extracted text).
//
// JSON shape (page_type: "action", a repeatable, parameterized automation --
// login, add-to-cart, or any other multi-step interaction that isn't
// primarily about reading content). Executes identically to "article"
// (ui_steps, then an optional post-action read of the resulting page) --
// it's a separate page_type purely for organization/discovery (so
// `query.js sites` and `#action:` lookups read clearly), not different
// engine code. credential-shaped values (passwords, tokens, etc) belong in
// caller-supplied params (substituted at run time via {{key}} in nav_template
// ui_steps), never written into nav_template/notes/fields where they'd be
// persisted in the DB.
//
// "action_type" is REQUIRED and must name an entry in the action_types
// table (a small, deliberately-short taxonomy -- see `node query.js
// action-types`). This is the guardrail against inventing near-duplicate
// action kinds (e.g. "add_to_cart" on one site and "add-to-basket" on
// another meaning the same thing): register.js rejects an unrecognized
// action_type unless the JSON also includes
// "new_action_type_description", which explicitly registers it as a new
// taxonomy entry. Prefer reusing an existing action_type; only add a new
// one when the existing list genuinely doesn't fit. "recipe_name" is
// separate and still free-form/per-hostname -- it's fine (expected, even)
// for recipe_name to be more specific than action_type, e.g. two recipes
// both action_type:"login" -- recipe_name:"login_email" and
// recipe_name:"login_google_oauth" -- for the same site.
//
// ui_steps 'handoff' step: pauses the sequence for a human to complete a step
// the automation shouldn't do unattended -- a 2FA/OTP code, a CAPTCHA, a
// final "place order" confirmation, anything like that. engine.js detects a
// handoff step in nav_template up front and launches a real, visible browser
// window for the whole run instead of headless (there's no other channel
// back to a person mid-run). Resumption is read off the page itself, never
// signaled through the process: give `resume_selector` (a CSS selector that
// only appears once the manual step is done) and/or `resume_url_includes` (a
// URL substring reached after it); with neither, it just waits out
// `timeout_ms` (default 300000 = 5 min) blind, which is the least reliable
// option. Because this blocks on a human, run it with a generous timeout (or
// in the background) and tell them up front that a browser window is about
// to open and what to do in it:
// {"action":"handoff","reason":"Enter the 2FA code sent to your phone, then submit.","resume_selector":".account-nav","timeout_ms":300000}
//
// A login action's handoff combines with session persistence for free: since
// session cookies load before navigation and resume_selector/
// resume_url_includes are checked immediately (not just on future changes),
// a still-valid saved session typically means the resume condition is
// already true the moment the handoff step starts -- e.g. navigating to a
// login URL while already authenticated gets auto-redirected past it -- so
// the run finishes with no human involvement at all. A stale/expired
// session naturally falls through to a real handoff, and the fresh cookies
// that produces get saved automatically for next time. Nothing about the
// recipe needs to special-case this.
//
// Optional `capture` on a handoff step: a menu of what's available to read
// back out of the page once the human is done (their typed value is the one
// thing the recipe params don't already know) -- e.g.
// {"fields":{"ACCOUNT_EMAIL":"#confirmed-email","REFERENCE_NUMBER":"#ref"}}.
// This is safe to store: it's only CSS selectors and made-up variable names,
// never values. Whether anything actually gets captured for a given run is a
// SEPARATE, per-call decision via params.captureMode ("none" [default] |
// "flagged" [only the selectors in `capture.fields`] | "all" [every input/
// textarea/select on the page, INCLUDING password/2FA fields if still
// filled in]) -- never bake captureMode into the stored recipe. Per
// CLAUDE.md, ask the user which mode to use for that specific run before
// telling them about the upcoming handoff. Captured values are written to a
// gitignored, mode-600 temp file under data/.captures/ and never appear in
// engine.js's stdout or scrape_runs -- the result JSON's `handoffCaptures`
// reports the file path and which keys were captured, not the values.
// {
//   "hostname": "example.com",
//   "page_type": "action",
//   "recipe_name": "login",
//   "action_type": "login",
//   "nav_template": "[{\"action\":\"goto\",\"url\":\"https://example.com/login\"},{\"action\":\"type\",\"selector\":\"#email\",\"text\":\"{{email}}\"},{\"action\":\"type\",\"selector\":\"#password\",\"text\":\"{{password}}\"},{\"action\":\"click\",\"selector\":\"#submit\"},{\"action\":\"handoff\",\"reason\":\"Enter the 2FA code sent to your phone, then submit.\",\"resume_selector\":\".account-nav\"}]",
//   "...": "(the rest of the shape is the same as the plain example below)"
// }
//
// ui_steps 'run_action' step: reuses ANOTHER action recipe as a substep,
// instead of duplicating its steps inline -- e.g. a "purchase_item" action
// composing the existing "login" action rather than copy-pasting its
// goto/type/click/handoff sequence. {"action":"run_action","ref":"login"} —
// bare ref means "same hostname, page_type 'action', that recipe_name";
// "other.com#action:sso_login" is the fully-qualified form, for
// cross-hostname composition (an SSO login on a different domain) or an
// explicit non-'action' page_type. All run_action references are expanded
// to a flat step list up front, before the browser launches, and run
// inline on the SAME page (not a separate browser/session) — a
// nested handoff or capture inside a referenced action works exactly as it
// would standalone. engine.js fails fast, before launching anything, on a
// dangling reference, a referenced recipe that isn't status:"working", or a
// reference cycle. Composed recipes share ONE params object — there's no
// per-reference renaming yet, so e.g. a composed "purchase_item" and the
// "login" it calls must agree on using {{email}}/{{password}}, not
// different names for the same value. register.js checks (non-fatally —
// a referenced recipe may not exist yet if you're building bottom-up or
// top-down) that each run_action ref resolves, and warns via
// `unresolvedReferences` in its response if not. Inspect exactly what a
// composed recipe will run with `node query.js expand
// <hostname>#action:<recipe_name>`.
// {
//   "hostname": "example.com",
//   "page_type": "action",
//   "recipe_name": "purchase_item",
//   "action_type": "checkout_to_review",
//   "nav_template": "[{\"action\":\"run_action\",\"ref\":\"login\"},{\"action\":\"goto\",\"url\":\"{{product_url}}\"},{\"action\":\"click\",\"selector\":\"#add-to-cart\"},{\"action\":\"click\",\"selector\":\"#checkout\"}]",
//   "...": "(the rest of the shape is the same as the plain example below)"
// }
//
// ui_steps 'remove_element' step: deletes every node matching `selector`
// rather than interacting with it —
// {"action":"remove_element","selector":"#cookie-banner","restore_scroll":true}
// Puppeteer's ::-p-text()/::-p-aria() selectors work here (it uses page.$$,
// not a native querySelectorAll inside evaluate). `restore_scroll` also
// clears the overflow:hidden lock overlays usually set on body/html —
// without it, removing the node leaves the page unscrollable and silently
// breaks a later scroll_bottom/infinite_scroll. Matching nothing is a
// no-op, not a failure. Mainly used by the remove_overlay generic action,
// which clears a consent banner WITHOUT clicking accept or reject (no
// consent signal either way); compose this step directly with an exact
// selector for a site whose overlay you have actually seen.
//
// Making any step optional: a `click` with stop_if_missing raises
// StopRepeat, which at the TOP level ends the whole remaining step list —
// so an optional dismissal would silently skip everything after it. Wrap it
// in a repeat to scope that: {"action":"repeat","times":1,"steps":[ ...the
// optional click... ]} means "try it, carry on regardless". Every
// overlay-handling generic action is built this way.
//
// ui_steps 'run_generic_action' step: like run_action, but reuses a named
// entry from the generic_actions LIBRARY instead of another site's recipe —
// a recurring, hostname-independent puppeteer "macro" (a heuristic generic
// login, dismissing a cookie-consent banner, an infinite-scroll "load more"
// loop) any recipe can pull in with just a name, no hostname involved:
// {"action":"run_generic_action","ref":"dismiss_cookie_banner"}. Expanded
// and cycle-checked the same way and at the same time as run_action (a
// generic action's own steps can themselves use run_action/
// run_generic_action, recursively). Register one with "kind":
// "generic_action" instead of a hostname/page_type shape:
// {
//   "kind": "generic_action",
//   "name": "generic_login",
//   "description": "Heuristic login: types into the first password-type input found, and the input immediately before it, then submits.",
//   "action_type": "login",              // optional -- categorization only, for discovery via `node query.js action-types`/`generic-actions`
//   "nav_params_schema": "{\"email\":\"string\",\"password\":\"string\"}",
//   "steps": [
//     {"action":"type","selector":"input[type=email], input[autocomplete=username]","text":"{{email}}"},
//     {"action":"type","selector":"input[type=password]","text":"{{password}}"},
//     {"action":"click","selector":"button[type=submit]"}
//   ]
// }
// "steps" may be given as a native JSON array (as above) or as a JSON
// string, same flexibility as nav_template elsewhere. Manage the library
// with `node query.js generic-actions` (list) and `node query.js
// generic-action <name>` (one, full detail).
// Paging through results (listing only): set "pagination_method": "steps"
// and "pagination_config" to a ui_steps array, run after the first page's
// cards are ready and before the final extraction. Normally that's just the
// generic 'paginate' library action, told this site's "Next" button:
//   "pagination_method": "steps",
//   "pagination_config": [{"action":"run_generic_action","ref":"paginate","with":{"next_selector":"a[aria-label='Next']"}}]
// Callers then opt in per call with {"extra_pages": 2} (3 pages total);
// without it the repeat runs 0 times, so the recipe behaves exactly as a
// one-page search. `with` fills the generic action's {{placeholders}} for
// this one use; anything left unfilled comes from the caller's params.
//
// Step types used for this (usable in any ui_steps list):
//   {"action":"repeat","times":"{{extra_pages}}","steps":[...]}   loops the
//     inner steps; times may be a number or a {{param}}; capped at 50.
//   {"action":"click","selector":"...","stop_if_missing":true}     if the
//     element is absent or disabled (last page), ends the enclosing repeat
//     instead of failing the run.
//   {"action":"collect"}   listing only: saves the current page's cards;
//     all collected pages plus the final page are merged, de-duplicated by
//     href (or by whole record when there's no href field).
//   {"action":"scroll_bottom"}   scrolls to the bottom (lazy-loaded content,
//     below-the-fold "Show more" buttons).
//   {"action":"wait","ms":"{{wait_ms}}","default_ms":2500}   ms may be a
//     {{param}}; default_ms applies when it resolves blank.
//
// {
//   "hostname": "example.com",
//   "page_type": "action",
//   "recipe_name": "login",              // required in practice whenever a hostname has >1 action recipe
//   "action_type": "login",              // required for page_type "action" -- must match action_types, or pair with new_action_type_description
//   "status": "working",
//   "nav_method": "ui_steps",
//   "nav_template": "[{\"action\":\"goto\",\"url\":\"https://example.com/login\"},{\"action\":\"type\",\"selector\":\"#email\",\"text\":\"{{email}}\"},{\"action\":\"type\",\"selector\":\"#password\",\"text\":\"{{password}}\"},{\"action\":\"click\",\"selector\":\"#submit\"},{\"action\":\"waitForSelector\",\"selector\":\".account-nav\"}]",
//   "nav_params_schema": "{\"email\":\"string\",\"password\":\"string, pass at call time only, never stored\"}",
//   "content_selector": ".account-nav",  // what to read back afterward, to both confirm success and report a result
//   "card_min_text_len": 5,
//   "ready_timeout_ms": 15000,
//   "notes": "free text",
//   "fields": [
//     {"field_name":"logged_in_as","extract_kind":"full_blob"}
//   ]
// }
//
// VERSIONING: every call that actually changes a recipe snapshots it as a
// new MINOR version (v1.0 -> v1.1), reported back as `version`. Registering
// an identical definition records nothing, so re-running this to confirm a
// recipe is safe and won't spam the history. Add "stable": true to also
// promote — publishing this definition AS the next MAJOR (v1.2 -> a stable
// v2.0), reported back as `promotedStable`. Only set it for a definition
// you have actually verified against the live site, since a vN.0 is
// permanent while scaffolding minors are pruned to the most recent 5. To compare or roll
// back, use `node query.js diff|restore|versions`. See README.md
// "Recipe versions".

// node:sqlite emits an ExperimentalWarning on every run, which lands on
// stderr and makes this tool's output awkward to pipe into jq. Real warnings
// are not expected here and would be noise in a machine-read stream.
process.removeAllListeners('warning');


const fs = require('fs');
const {
  openDb,
  upsertSite,
  insertField,
  listActionTypes,
  getActionType,
  insertActionType,
  upsertGenericAction,
  getGenericAction,
  snapshotVersionIfChanged,
  promoteVersion,
  definitionHasPassingRun,
  getSite,
} = require('./db');
const { checkUnresolvedRefs } = require('./lib/composeActions');
const { authorize } = require('./lib/writeGuard');

function registerGenericAction(db, def) {
  if (!def.name || !def.steps) {
    console.log(JSON.stringify({ success: false, error: 'kind "generic_action" requires name and steps' }));
    process.exit(1);
  }

  // Refuse to write over a builtin. The row would update and appear to
  // work, then be silently reverted by the next openDb() re-seed from
  // lib/builtinActions.js — a change that vanishes later is worse than one
  // rejected now. Customizing a builtin means forking it under a new name;
  // changing the builtin itself means editing lib/builtinActions.js, which
  // is the point of it living in code.
  // A builtin CAN now be edited here, because the DB is the source of truth and
  // lib/builtinActions.js is a generated export of it. That used to be refused:
  // the file was authoritative, so a DB edit silently reverted on the next
  // open. Flipping the direction means a change to shared library behaviour
  // goes through the gate like everything else — audits, subaction and
  // dependent validation, the suites covering them, rollback on regression —
  // and the export is rewritten from the result so a clone still gets it.
  const existing = getGenericAction(db, def.name);
  const isBuiltin = existing?.source === 'builtin';
  if (isBuiltin && !def.note) {
    console.log(JSON.stringify({
      success: false,
      error: `"${def.name}" is a BUILTIN — part of the shared library that every recipe can reference. ` +
        'Editing it is allowed but needs a "note" saying why: it gates the change, becomes the change_log ' +
        'summary, and is the only record of why shared behaviour moved.',
      dependents: require('./lib/gate').dependentsOf(db, def.name),
    }));
    process.exit(1);
  }

  const stepsJson = typeof def.steps === 'string' ? def.steps : JSON.stringify(def.steps);
  let parsedSteps;
  try {
    parsedSteps = JSON.parse(stepsJson);
  } catch (e) {
    console.log(JSON.stringify({ success: false, error: `Bad steps JSON: ${e.message}` }));
    process.exit(1);
  }
  if (!Array.isArray(parsedSteps)) {
    console.log(JSON.stringify({ success: false, error: '"steps" must be a JSON array' }));
    process.exit(1);
  }

  if (def.action_type) {
    const known = getActionType(db, def.action_type);
    if (!known) {
      if (!def.new_action_type_description) {
        console.log(JSON.stringify({
          success: false,
          error: `action_type "${def.action_type}" isn't in the action_types taxonomy. Reuse an existing one if it fits, or add ` +
            '"new_action_type_description" to the JSON to register it as a deliberate new type.',
          existingActionTypes: listActionTypes(db),
        }));
        process.exit(1);
      }
      insertActionType(db, def.action_type, def.new_action_type_description);
    }
  }

  // callerHostname is null here — a generic action has no fixed hostname
  // until something invokes it, so a bare run_action ref inside it can't be
  // checked yet (checkUnresolvedRefs skips those, doesn't flag them).
  const unresolvedReferences = checkUnresolvedRefs(db, parsedSteps, null);

  // A generic action is library code: a change to it is a change to every
  // recipe and action that references it. dismiss_overlay alone is depended on
  // by another action and seven recipes, so the blast radius is validated in
  // both directions -- the SUBACTIONS it pulls in, and the DEPENDENTS it would
  // break. The action is a single row with no version history, so the gate is
  // given an explicit snapshot/restore pair to roll back with.
  const { guardedChange, validateGenericAction, dependentsOf, testFilesFor } = require('./lib/gate');
  const existingRow = getGenericAction(db, def.name);
  const dependents = dependentsOf(db, def.name);

  let genericActionId;
  const gated = guardedChange(db, {
    target: `generic:${def.name}`,
    summary: def.note || `register generic action ${def.name}`,
    scope: 'generic_action',
    snapshot: () => (existingRow ? { ...existingRow } : { absent: true, name: def.name }),
    restore: snap => {
      if (snap.absent) {
        db.prepare('DELETE FROM generic_actions WHERE name = ?').run(snap.name);
      } else {
        upsertGenericAction(db, {
          name: snap.name,
          description: snap.description,
          action_type: snap.action_type,
          nav_params_schema: snap.nav_params_schema,
          steps: snap.steps,
        });
      }
    },
    // The action itself plus everything downstream of it: a change that leaves
    // this action valid but breaks a dependent is still a broken change.
    extraFindings: () => {
      const row = getGenericAction(db, def.name);
      const out = row ? validateGenericAction(db, def.name, row.steps) : [];
      for (const name of dependents.actions) {
        const dep = getGenericAction(db, name);
        if (dep) out.push(...validateGenericAction(db, name, dep.steps));
      }
      return out;
    },
    extraTestFiles: () =>
      testFilesFor({ generic: [def.name, ...dependents.actions], site: dependents.recipes }),
    mutate: () => {
      genericActionId = upsertGenericAction(db, {
        name: def.name,
        description: def.description,
        action_type: def.action_type,
        nav_params_schema: def.nav_params_schema,
        steps: stepsJson,
      });
      if (isBuiltin) {
        // Keep it a builtin. The export is regenerated AFTER the gate returns,
        // not here: guardedChange writes the change_log row after mutate(), so
        // exporting inside mutate() stamped every action with the PREVIOUS
        // change note -- the reason would always lag one edit behind.
        db.prepare("UPDATE generic_actions SET source = 'builtin' WHERE name = ?").run(def.name);
      }
    },
  });

  // Now that the change is logged, regenerate the export so each action's
  // stamped reason matches the change that actually produced it.
  if (isBuiltin && gated.ok) {
    authorize(`export builtins after ${def.name}`, () => require('./lib/exportBuiltins').exportBuiltins(db));
  }

  console.log(JSON.stringify({
    success: gated.ok,
    kind: 'generic_action',
    name: def.name,
    genericActionId,
    unresolvedReferences,
    subactions: (() => {
      try {
        return require('./lib/gate').referencedActions(JSON.parse(stepsJson)).generic;
      } catch {
        return [];
      }
    })(),
    dependents,
    gate: {
      findingsBefore: gated.findingsBefore,
      findingsAfter: gated.findingsAfter,
      introducedFindings: gated.introducedFindings,
      tests: gated.actionTests,
      rolledBack: gated.rolledBack,
      ...(gated.rollbackNote ? { rollbackNote: gated.rollbackNote } : {}),
    },
    ...(gated.ok
      ? {}
      : { error: 'this change introduced the findings above and was rolled back — fix them, then retry' }),
  }));
  if (!gated.ok) process.exit(1);
}

function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.log(JSON.stringify({ success: false, error: 'Usage: node register.js \'<json>\' | node register.js <path.json>' }));
    process.exit(1);
  }

  let raw;
  if (fs.existsSync(arg)) {
    raw = fs.readFileSync(arg, 'utf8');
  } else {
    raw = arg;
  }

  let def;
  try {
    def = JSON.parse(raw);
  } catch (e) {
    console.log(JSON.stringify({ success: false, error: `Bad JSON: ${e.message}` }));
    process.exit(1);
  }

  if (def.kind === 'generic_action') {
    registerGenericAction(openDb(), def);
    return;
  }

  const pageType = def.page_type || 'listing';

  if (!def.hostname || !def.nav_method || !def.nav_template) {
    console.log(JSON.stringify({
      success: false,
      error: 'Required: hostname, nav_method, nav_template',
    }));
    process.exit(1);
  }

  // Reject unknown enum values rather than storing them. A typo'd page_type
  // ("listng") used to register happily and then fail confusingly at run
  // time: it skipped the page_type-specific validation below, fell through
  // engine.js's article/action branch into the LISTING path with no card
  // selector, and was invisible to `query.js site <hostname>` (which
  // defaults to page_type "listing"). Same idea for the other two: catch it
  // here, not after launching a browser.
  const VALID_PAGE_TYPES = ['listing', 'article', 'action'];
  const VALID_NAV_METHODS = ['url_param', 'ui_steps', 'direct_url'];
  const VALID_STATUSES = ['working', 'broken', 'needs-review', 'blocked', 'blocked-attn'];

  if (!VALID_PAGE_TYPES.includes(pageType)) {
    console.log(JSON.stringify({
      success: false,
      error: `Unknown page_type "${pageType}". Use one of: ${VALID_PAGE_TYPES.join(', ')}.`,
    }));
    process.exit(1);
  }

  if (!VALID_NAV_METHODS.includes(def.nav_method)) {
    console.log(JSON.stringify({
      success: false,
      error: `Unknown nav_method "${def.nav_method}". Use one of: ${VALID_NAV_METHODS.join(', ')}.`,
    }));
    process.exit(1);
  }

  if (def.status !== undefined && !VALID_STATUSES.includes(def.status)) {
    console.log(JSON.stringify({
      success: false,
      error: `Unknown status "${def.status}". Use one of: ${VALID_STATUSES.join(', ')}.`,
    }));
    process.exit(1);
  }

  // "blocked" is a claim about the SITE — that a person is genuinely required
  // every run — and like "working" it is not an agent's to assert. It is
  // reached programmatically: `verify.js` sets it when the failure sweep
  // identifies a wall, or when `verify.js --attended` shows that a person
  // present was sufficient. Left hand-settable, it would become the
  // comfortable place to park anything hard.
  //
  // "blocked-attn" is the opposite: it stays freely settable because it is the
  // cautious direction (it parks work instead of claiming success) and because
  // nothing can detect "the agent is out of moves". The asymmetry is
  // deliberate — cheap to enter, earned to leave.
  if (def.status === 'blocked') {
    console.log(JSON.stringify({
      success: false,
      error:
        '"status": "blocked" cannot be set by hand — it asserts that a person is required every run, which has to come ' +
        'from a run. Register as "needs-review" (or "blocked-attn" with notes, if you are stuck), then: ' +
        `node verify.js ${def.hostname}#${pageType}:${def.recipe_name || 'default'} '<params>' sets "blocked" ` +
        'automatically when it detects a wall, and --attended sets it when a person being present was enough.',
    }));
    process.exit(1);
  }

  // "blocked-attn" means work has stopped until the user participates, so it
  // has to say WHAT is needed. A bare status would leave them to rediscover
  // the dead end that produced it, which defeats the purpose of the state.
  if (def.status === 'blocked-attn' && !(def.notes || '').trim()) {
    console.log(JSON.stringify({
      success: false,
      error:
        'status "blocked-attn" requires notes saying what is needed from the user — what was tried, what the obstacle is, ' +
        'and what specifically only they can supply or decide. Without that the status is just a dead end with no handle on it.',
    }));
    process.exit(1);
  }

  if (def.session_mode !== undefined && def.session_mode !== null && !['default', 'none'].includes(def.session_mode)) {
    console.log(JSON.stringify({
      success: false,
      error: `Unknown session_mode "${def.session_mode}". Use "none" (recipe must run logged out) or omit it.`,
    }));
    process.exit(1);
  }

  if (pageType === 'listing' && !def.card_anchor_text && !def.card_selector) {
    console.log(JSON.stringify({
      success: false,
      error: 'page_type "listing" also requires card_anchor_text or card_selector',
    }));
    process.exit(1);
  }

  const db = openDb();

  // "working" is a claim about reality, so it has to come from reality. An
  // earlier parallel run registered 16 recipes as working; four returned
  // nothing at all, one of them annotated "SCAFFOLD v0: exploratory first
  // guess". Nothing checked, so nothing stopped it.
  //
  // It is now only accepted when the recipe's CURRENT definition already has
  // a run that extracted records, which only verify.js can produce. A first
  // registration therefore cannot be "working" — there is nothing to have
  // passed yet. Marking a recipe broken or needs-review stays free: those
  // claims are safe to be wrong in the cautious direction.
  if (def.status === 'working') {
    const existing = getSite(db, def.hostname, pageType, def.recipe_name || 'default');
    if (!existing || !definitionHasPassingRun(db, existing.id)) {
      console.log(JSON.stringify({
        success: false,
        error:
          '"status": "working" cannot be set by hand — it has to be earned by a run that actually extracted records. ' +
          `Register this as "needs-review", then run: node verify.js ${def.hostname}#${pageType}:${def.recipe_name || 'default'} '<params>'. ` +
          'A passing run sets the status itself. (If the definition changed since it last passed, it needs re-verifying — that is the point.)',
        hint: 'node lab.js new <hostname> prints the whole build-and-verify sequence.',
      }));
      process.exit(1);
    }
  }

  if (pageType === 'action') {
    if (!def.action_type) {
      console.log(JSON.stringify({
        success: false,
        error: 'page_type "action" also requires action_type (see `node query.js action-types` for the existing taxonomy).',
        existingActionTypes: listActionTypes(db),
      }));
      process.exit(1);
    }
    const known = getActionType(db, def.action_type);
    if (!known) {
      if (!def.new_action_type_description) {
        console.log(JSON.stringify({
          success: false,
          error: `action_type "${def.action_type}" isn't in the action_types taxonomy. Reuse an existing one if it fits, or add ` +
            '"new_action_type_description" to the JSON to register it as a deliberate new type.',
          existingActionTypes: listActionTypes(db),
        }));
        process.exit(1);
      }
      insertActionType(db, def.action_type, def.new_action_type_description);
    }
  }

  if (def.pagination_method === 'steps') {
    const cfg = typeof def.pagination_config === 'string' ? def.pagination_config : JSON.stringify(def.pagination_config);
    let parsed;
    try {
      parsed = JSON.parse(cfg);
    } catch (e) {
      console.log(JSON.stringify({ success: false, error: `pagination_method "steps" needs pagination_config as a JSON ui_steps array: ${e.message}` }));
      process.exit(1);
    }
    if (!Array.isArray(parsed)) {
      console.log(JSON.stringify({ success: false, error: 'pagination_config must be a JSON array of ui_steps' }));
      process.exit(1);
    }
    def.pagination_config = cfg;
  }

  // Non-fatal: a run_action/run_generic_action ref may point at something
  // that doesn't exist yet (building composed recipes bottom-up or
  // top-down are both fine) — warn, don't block. engine.js does the real,
  // fatal check at run time.
  let unresolvedReferences = [];
  if (def.nav_method === 'ui_steps') {
    try {
      const steps = JSON.parse(def.nav_template);
      if (Array.isArray(steps)) unresolvedReferences = checkUnresolvedRefs(db, steps, def.hostname);
    } catch {
      /* malformed nav_template JSON isn't this check's job — ui_steps execution will surface it */
    }
  }
  if (def.pagination_method === 'steps') {
    unresolvedReferences = unresolvedReferences.concat(
      checkUnresolvedRefs(db, JSON.parse(def.pagination_config), def.hostname)
    );
  }

  // A dangling reference is a WARNING (building bottom-up is legitimate), but a
  // reference to an action that exists and is BROKEN is not: the recipe would
  // fail at run time inside code it did not write, which is the hardest kind of
  // failure to attribute. Validated before writing anything, and the suites
  // covering those actions are run too — most of what a composed recipe
  // actually does lives in the actions it pulls in.
  let referencedActions = { generic: [], site: [] };
  let actionFindings = [];
  let actionTests = null;
  if (def.nav_method === 'ui_steps') {
    const { referencedActions: findRefs, validateReferencedActions, testFilesFor, runTestFiles } = require('./lib/gate');
    try {
      referencedActions = findRefs(JSON.parse(def.nav_template));
    } catch {
      /* malformed nav_template is surfaced elsewhere */
    }
    // Only actions that actually resolve are validated; a not-yet-created one
    // is already covered by unresolvedReferences as a warning.
    const existing = {
      generic: referencedActions.generic.filter(n => getGenericAction(db, n)),
      site: [],
    };
    actionFindings = validateReferencedActions(db, existing, def.hostname).filter(f => f.startsWith('error|'));
    if (actionFindings.length) {
      console.log(JSON.stringify({
        success: false,
        error: 'a generic action this recipe references is itself broken, so the recipe would fail at run time inside code it does not own',
        brokenReferencedActions: actionFindings,
        hint: 'fix the action (lib/builtinActions.js for a builtin) before registering a recipe that depends on it',
      }));
      process.exit(1);
    }
    if (existing.generic.length) {
      actionTests = runTestFiles(testFilesFor(existing));
      if (actionTests.failed > 0) {
        console.log(JSON.stringify({
          success: false,
          error: `${actionTests.failed} test(s) covering the generic actions this recipe references are failing`,
          failures: actionTests.failures.slice(0, 5),
          files: actionTests.files,
          hint: 'those actions are what this recipe would actually run — fix them first, or the recipe inherits their breakage',
        }));
        process.exit(1);
      }
    }
  }

  const siteId = upsertSite(db, def);

  (def.fields || []).forEach((f, i) => insertField(db, siteId, f, i));

  // Snapshot AFTER the fields are written — upsertSite clears and the
  // caller re-inserts them, so versioning inside upsertSite would capture a
  // recipe with no fields. Only records a version when the definition
  // actually changed, so a no-op re-register doesn't spam the history.
  const version = snapshotVersionIfChanged(db, siteId, { note: def.version_note });
  // "stable": true says this definition is known-good, so publish it as the
  // next major -- a permanent vN.0 checkpoint, never reachable by pruning.
  const promoted = def.stable ? promoteVersion(db, siteId, { note: def.version_note }) : null;

  console.log(JSON.stringify({
    success: true,
    hostname: def.hostname,
    pageType,
    recipeName: def.recipe_name || 'default',
    siteId,
    fieldsRegistered: (def.fields || []).length,
    unresolvedReferences,
    referencedActions: referencedActions.generic.length ? referencedActions.generic : undefined,
    actionTests: actionTests ? { passed: actionTests.passed, failed: actionTests.failed, files: actionTests.files } : undefined,
    version: version ? `v${version.major}.${version.minor}` : null,
    promotedStable: promoted ? `v${promoted.major}.${promoted.minor}` : null,
  }));
}

// register.js IS a sanctioned path: it runs the enum checks, the action-type
// taxonomy check and the earned-status gate before writing.
authorize('register.js', main);
