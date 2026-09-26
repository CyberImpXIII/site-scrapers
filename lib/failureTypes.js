// The failure taxonomy, deliberately SMALL.
//
// The point of recording failures is to notice that a new one is the same
// as an old one. That only works if two people describing the same problem
// reach for the same label — so this is a closed vocabulary, seeded from
// code and enforced at write time, exactly like action_types. A free-text
// `symptom` field carries the specifics; the type carries the shape.
//
// Adding a genuinely new type is allowed but deliberate (see
// register.js's `new_failure_type_description` escape hatch). Resist it:
// "cookie_wall" alongside "consent_overlay" is how a taxonomy stops being
// able to answer "have we seen this before".
//
// Lives in code rather than only in the DB so a fresh clone still has the
// vocabulary — data/failures.db is gitignored, same as scrapers.db.

const FAILURE_TYPES = [
  ['selector_not_found',
    'A selector that used to match now matches nothing. The classic site-redesign break; also what a typo looks like on a first attempt.'],
  ['selector_ambiguous',
    'A selector matches, but the wrong nodes or too many — extraction returns junk rather than nothing. Harder to spot than selector_not_found because the run often "succeeds".'],
  ['layout_change',
    'The page still works but its structure moved: cards regrouped, fields reordered, content nested a level deeper. Distinct from selector_not_found in that the fix is usually re-deriving the card shape, not editing one selector.'],
  ['bot_block',
    'CAPTCHA, bot-detection interstitial, rate limit, or an outright block page. Do not try to defeat these — record the site and back off.'],
  ['auth_required',
    'A login wall, an expired session, or content that silently differs when signed out. Often shows up as empty_result until you look at the DOM.'],
  ['consent_overlay',
    'A cookie/consent/privacy banner covering content or locking scroll. Usually fixed by composing dismiss_overlay rather than by changing selectors.'],
  ['slow_render',
    'The content does arrive, but later than ready_timeout_ms allowed. Intermittent by nature — a cold headless launch is slower than a warm one.'],
  ['empty_result',
    'The page loads and nothing errors, but zero records come back. An SPA that never hydrated, a query with genuinely no matches, or a signed-out view — the DOM capture tells them apart.'],
  ['navigation_failed',
    'goto() failed or landed somewhere unexpected: a dead URL, a redirect race, a network error.'],
  ['pagination_broken',
    'Page one works but going further does not — the Next control moved, infinite scroll stopped appending, or later pages repeat page one.'],
  ['extraction_wrong',
    'Cards are found correctly but a field parses wrong: a regex over-matches, a positional segment shifted, an attribute moved.'],
  ['param_shape_wrong',
    'The recipe is fine; the caller passed params in a shape nav_params_schema did not describe. Recording these matters because the fix is a caller change, not a recipe change.'],
];

module.exports = { FAILURE_TYPES };
