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
// JSON shape (page_type: "listing", repeated cards — the default):
// {
//   "hostname": "example.com",
//   "page_type": "listing",              // optional, defaults to "listing"
//   "recipe_name": "default",            // optional, defaults to "default" -- see above
//   "display_name": "Example Job Board",
//   "status": "working",                 // or "broken" / "needs-review"
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
// {
//   "hostname": "example.com",
//   "page_type": "action",
//   "recipe_name": "login",
//   "action_type": "login",
//   "nav_template": "[{\"action\":\"goto\",\"url\":\"https://example.com/login\"},{\"action\":\"type\",\"selector\":\"#email\",\"text\":\"{{email}}\"},{\"action\":\"type\",\"selector\":\"#password\",\"text\":\"{{password}}\"},{\"action\":\"click\",\"selector\":\"#submit\"},{\"action\":\"handoff\",\"reason\":\"Enter the 2FA code sent to your phone, then submit.\",\"resume_selector\":\".account-nav\"}]",
//   "...": "(the rest of the shape is the same as the plain example below)"
// }
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

const fs = require('fs');
const { openDb, upsertSite, insertField, listActionTypes, getActionType, insertActionType } = require('./db');

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

  const pageType = def.page_type || 'listing';

  if (!def.hostname || !def.nav_method || !def.nav_template) {
    console.log(JSON.stringify({
      success: false,
      error: 'Required: hostname, nav_method, nav_template',
    }));
    process.exit(1);
  }

  if (pageType === 'listing' && !def.card_anchor_text) {
    console.log(JSON.stringify({
      success: false,
      error: 'page_type "listing" also requires card_anchor_text',
    }));
    process.exit(1);
  }

  const db = openDb();

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

  const siteId = upsertSite(db, def);

  (def.fields || []).forEach((f, i) => insertField(db, siteId, f, i));

  console.log(JSON.stringify({
    success: true,
    hostname: def.hostname,
    pageType,
    recipeName: def.recipe_name || 'default',
    siteId,
    fieldsRegistered: (def.fields || []).length,
  }));
}

main();
