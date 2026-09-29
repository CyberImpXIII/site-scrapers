// Per-field value distributions, for catching a field that quietly holds
// ANOTHER field's kind of value.
//
// Null counts (lab.js peek) catch a field that stopped extracting. They do not
// catch the more expensive fault: a positional field that still fills on every
// card but points one element off, so `location` holds "Part-time" on the cards
// where an element was absent and everything after it shifted up. Coverage is
// 0/57 null and the recipe looks healthy.
//
// Two signals here:
//   distinctByField  -- a positional field whose value set is small and looks
//                       like an enum is usually pointing at a chip, not at the
//                       thing it is named for.
//   crossFieldValues -- the direct one: the SAME string appearing under two
//                       different field names across the record set. Per-record
//                       comparison would miss it, because drift is usually
//                       partial (only the cards missing an optional element).

// Values longer than this are prose (a blurb, a description) rather than a
// category, so their distribution says nothing and printing them buries the
// fields whose distribution does matter.
const MAX_INTERESTING_LEN = 60;

function normalise(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') return String(v);
  const s = v.trim();
  return s === '' ? null : s;
}

// Distinct non-null values per field, most frequent first.
function distinctByField(records, { limit = 8 } = {}) {
  const byField = new Map();
  for (const r of records || []) {
    for (const [field, raw] of Object.entries(r || {})) {
      const v = normalise(raw);
      if (v === null) continue;
      if (!byField.has(field)) byField.set(field, new Map());
      const counts = byField.get(field);
      counts.set(v, (counts.get(v) || 0) + 1);
    }
  }
  const out = {};
  for (const [field, counts] of byField) {
    const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    out[field] = {
      distinct: sorted.length,
      // A field with ONE distinct value across many records is either a genuine constant
      // or a selector that matched the same node every time -- worth seeing.
      top: sorted.slice(0, limit).map(([value, n]) => ({ value, n })),
      truncated: Math.max(0, sorted.length - limit),
    };
  }
  return out;
}

// Values that appear under more than one field name. Each entry is a candidate
// drift: two fields reading the same element, or a positional index landing on
// its neighbour's element on some cards.
function crossFieldValues(records, { maxLen = MAX_INTERESTING_LEN } = {}) {
  const fieldsByValue = new Map();
  for (const r of records || []) {
    for (const [field, raw] of Object.entries(r || {})) {
      const v = normalise(raw);
      if (v === null || v.length > maxLen) continue;
      if (!fieldsByValue.has(v)) fieldsByValue.set(v, new Map());
      const fields = fieldsByValue.get(v);
      fields.set(field, (fields.get(field) || 0) + 1);
    }
  }
  const shared = [];
  for (const [value, fields] of fieldsByValue) {
    if (fields.size < 2) continue;
    shared.push({
      value,
      fields: [...fields].sort((a, b) => b[1] - a[1]).map(([field, n]) => ({ field, n })),
    });
  }
  // Most-shared first: a value under three field names is a louder signal than
  // one under two.
  return shared.sort((a, b) => b.fields.length - a.fields.length || a.value.localeCompare(b.value));
}

module.exports = { distinctByField, crossFieldValues, MAX_INTERESTING_LEN };
