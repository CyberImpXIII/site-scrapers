#!/usr/bin/env node
// Documents a site (or updates its documentation) in the database.
// Call this after successfully figuring out a site interactively — it's the
// replacement for "write a new sites/<hostname>.js file."
//
// Usage:
//   node register.js '<json>'
//   node register.js path/to/site-def.json
//
// JSON shape (page_type: "listing", repeated cards — the default):
// {
//   "hostname": "example.com",
//   "page_type": "listing",              // optional, defaults to "listing"
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

const fs = require('fs');
const { openDb, upsertSite, insertField } = require('./db');

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
  const siteId = upsertSite(db, def);

  (def.fields || []).forEach((f, i) => insertField(db, siteId, f, i));

  console.log(JSON.stringify({
    success: true,
    hostname: def.hostname,
    pageType,
    siteId,
    fieldsRegistered: (def.fields || []).length,
  }));
}

main();
