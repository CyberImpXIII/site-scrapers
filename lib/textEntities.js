// Decoding HTML entities a site left in its VISIBLE text.
//
// Found 2026-10-09 (scripts' dry sweep, scripts/TODO.md item 15): builtin.com
// shows the PNC Bank title "Software Engineer Lead (ETL/Regulatory Risk &amp;
// Compliance)" -- the literal five characters `&amp;` on screen, because the
// site encoded the title twice. Text fields are read from innerText /
// textContent, which the browser has ALREADY decoded once, so an entity that
// survives into an extracted value is that double encoding, never markup. It
// would have been written into job-history.md as-is.
//
// Decoded here, on the Node side, once, after extraction (the same place and
// for the same reason as lib/urlAttrs.js). Rules, each chosen so the decode
// can never invent a value:
//   - ONE level only: `&amp;amp;` becomes `&amp;`, not `&`. The browser
//     already removed one level; removing exactly one more is the double
//     encoding we can see, and anything deeper is a guess.
//   - only the XML five, `&nbsp;` and numeric references. Anything else is
//     left exactly as the site wrote it: a name we would have to look up is a
//     value we might get wrong.
//   - never an attribute field (`anchor_attribute`): getAttribute is decoded by
//     the parser too, and a URL with `&amp;` in its query is not ours to
//     rewrite (lib/urlAttrs.js resolves it as written).
// The caller reports how many values changed (`entitiesDecoded` in a listing
// run's output), so a decode is visible rather than silent.
// test/text-entities.test.js.

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

const ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos|nbsp));/g;

function codePointOrNull(n) {
  if (!Number.isInteger(n) || n <= 0 || n > 0x10ffff) return null;
  if (n >= 0xd800 && n <= 0xdfff) return null; // a lone surrogate is not a character
  return String.fromCodePoint(n);
}

// One string, one level. A reference that does not name a real character is
// left as written.
function decodeEntitiesOnce(s) {
  if (typeof s !== 'string' || !s.includes('&')) return s;
  return s.replace(ENTITY, (whole, dec, hex, name) => {
    if (name) return NAMED[name];
    const ch = codePointOrNull(dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16));
    return ch === null ? whole : ch;
  });
}

// Decodes every TEXT field of every record, in place. `fields` are the
// recipe's definitions, so this knows which keys came from an attribute.
// Returns { values, fields } -- how many values changed and which field names
// they were in -- or null when nothing changed.
function decodeTextFields(records, fields) {
  const textFields = (fields || [])
    .filter((f) => f && f.field_name && f.extract_kind !== 'anchor_attribute')
    .map((f) => f.field_name);
  let values = 0;
  const touched = new Set();
  for (const record of records || []) {
    if (!record || typeof record !== 'object') continue;
    for (const name of textFields) {
      const v = record[name];
      if (typeof v !== 'string') continue;
      const d = decodeEntitiesOnce(v);
      if (d !== v) {
        record[name] = d;
        values += 1;
        touched.add(name);
      }
    }
  }
  return values ? { values, fields: [...touched].sort() } : null;
}

module.exports = { decodeEntitiesOnce, decodeTextFields };
