// Resolving extracted URL attributes to absolute URLs.
//
// `anchor_attribute` used to return `getAttribute(name)` verbatim, so a
// record's `href` was absolute when the site wrote it absolute (Greenhouse)
// and relative when it did not (dice, Ashby). A caller could not use
// `record.href` without knowing which site produced it, and the inconsistency
// did not stay in this repo: every consumer had to prefix an origin
// defensively, per recipe, forever. dice returns 30 of 30 relative.
//
// Resolved on the NODE side, once, rather than inside each page.evaluate:
// there are two extraction paths (listing cards and article) and putting a
// copy of this in both is the duplication that drifts. Against
// `document.baseURI` rather than the page URL, because a page carrying a
// <base> tag resolves its own links against that and we should agree with the
// browser.
//
// ONLY URL-BEARING ATTRIBUTES. `anchor_attribute` can pull any attribute —
// `data-job-id`, `aria-label` — and resolving one of those against a base
// would turn an id into a URL. That is a wrong value rather than a missing
// one, which is the failure this project treats as worst, so the list is an
// allowlist of the standard HTML URL attributes and nothing is guessed.
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'poster', 'cite', 'data']);

function isUrlAttribute(name) {
  return URL_ATTRS.has(String(name || '').toLowerCase());
}

/**
 * One extracted value. Returns it unchanged unless it is a non-empty string
 * that resolves — an empty attribute must NOT become the page's own URL, and
 * anything unparseable keeps the raw value rather than being dropped.
 */
function resolveUrlValue(raw, base) {
  if (typeof raw !== 'string') return raw;
  if (!raw.trim()) return raw;
  if (!base) return raw;
  try {
    return new URL(raw, base).href;
  } catch {
    return raw; // a malformed value is the site's, and losing it tells us less
  }
}

/**
 * Resolves every field extracted from a URL-bearing attribute, in place.
 * `fields` are the recipe's field definitions, so this knows which of a
 * record's keys came from an attribute and which attribute it was.
 */
function resolveUrlFields(records, fields, base) {
  const urlFields = (fields || [])
    .filter(f => f.extract_kind === 'anchor_attribute' && isUrlAttribute(f.attribute_name))
    .map(f => f.field_name);
  if (!urlFields.length || !base) return records;
  for (const record of records || []) {
    if (!record || typeof record !== 'object') continue;
    for (const name of urlFields) {
      if (name in record) record[name] = resolveUrlValue(record[name], base);
    }
  }
  return records;
}

module.exports = { URL_ATTRS, isUrlAttribute, resolveUrlValue, resolveUrlFields };
