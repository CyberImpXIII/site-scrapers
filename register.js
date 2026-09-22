#!/usr/bin/env node
// Documents a site (or updates its documentation) in the database.
// Call this after successfully figuring out a site interactively — it's the
// replacement for "write a new sites/<hostname>.js file."
//
// Usage:
//   node register.js '<json>'
//   node register.js path/to/site-def.json
//
// JSON shape:
// {
//   "hostname": "example.com",
//   "display_name": "Example Job Board",
//   "status": "working",                 // or "broken" / "needs-review"
//   "nav_method": "url_param",           // or "ui_steps"
//   "nav_template": "https://example.com/?q={{query}}",
//   "nav_params_schema": "{\"query\":\"string, required\"}",
//   "pagination_method": "none",
//   "card_anchor_text": "View job",
//   "card_min_text_len": 80,
//   "ready_timeout_ms": 20000,
//   "result_count_regex": "([\\d,]+) results",
//   "notes": "free text",
//   "fields": [
//     {"field_name":"title","extract_kind":"positional_segment","segment_index":1,"example_value":"IT Support Specialist"},
//     {"field_name":"href","extract_kind":"anchor_attribute","attribute_name":"href"}
//   ]
// }

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

  if (!def.hostname || !def.nav_method || !def.nav_template || !def.card_anchor_text) {
    console.log(JSON.stringify({
      success: false,
      error: 'Required: hostname, nav_method, nav_template, card_anchor_text',
    }));
    process.exit(1);
  }

  const db = openDb();
  const siteId = upsertSite(db, def);

  (def.fields || []).forEach((f, i) => insertField(db, siteId, f, i));

  console.log(JSON.stringify({
    success: true,
    hostname: def.hostname,
    siteId,
    fieldsRegistered: (def.fields || []).length,
  }));
}

main();
