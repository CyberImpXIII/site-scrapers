// "The site says it has more than this run returned" -- the listing output's
// `moreAvailable` field.
//
// Why (2026-10-09, scripts' dry sweep, scripts/TODO.md item 15): linkedin.com
// returned exactly 60 records for 45 different searches. The guest search
// page serves 60 cards and loads the rest by infinite scroll the recipe does
// not drive, so every search was silently capped at 60 while the page itself
// said "11,000+ ... Jobs in". `count: 60` with `success: true` read as "this
// search has 60 results". The site's own count (`claimedCount`, from
// `result_count_regex`) was already in the output; nothing compared the two.
//
// This compares them, generically: any recipe with a result_count_regex gets
// it, and a recipe without one gets nothing (we cannot know, so we do not
// say). Present only when the claim is a clean number strictly greater than
// what came back. Only plain integers, optionally comma-grouped and with a
// trailing "+", count: "1.234" (another locale's grouping) or "1.2K" is null
// rather than a guess at what the site meant.
//
// `atLeast` is true when the site's own number was a floor ("11,000+").

'use strict';

function parseClaimed(claimedCount) {
  if (claimedCount === null || claimedCount === undefined) return null;
  const s = String(claimedCount).trim();
  const m = /^(\d{1,3}(?:,\d{3})+|\d+)(\+?)$/.exec(s);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isSafeInteger(n) ? { n, atLeast: m[2] === '+' } : null;
}

function moreAvailable(claimedCount, returned) {
  if (!Number.isInteger(returned) || returned < 0) return null;
  const c = parseClaimed(claimedCount);
  if (!c || c.n <= returned) return null;
  return { claimed: c.n, atLeast: c.atLeast, returned };
}

module.exports = { moreAvailable, parseClaimed };
