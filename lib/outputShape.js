// The one accessor for a run's extracted records.
//
// `jobs` was domain vocabulary sitting in a generic contract. engine.js
// returned `{ jobs: [...] }` for EVERY listing recipe, so scraping a product
// catalogue got its rows back under `jobs` — the same class of leak as the
// `record_nouns` one already fixed, except this one was in the output contract
// rather than a probe, which is why it spread to three source files.
//
// `records` is now canonical and `jobs` is an alias kept while readers migrate.
// Every reader goes through this function, so removing the alias is a one-line
// change here instead of a hunt through everything that consumed a run.
//
// Order matters: `records` wins, so a result carrying both (which is every
// listing run during the transition) is read from the canonical key, and the
// alias can be deleted without changing what any reader sees.
function recordsOf(result) {
  if (!result) return [];
  if (Array.isArray(result.records)) return result.records;
  if (Array.isArray(result.jobs)) return result.jobs;
  // An article/action run is one record rather than a list. Callers that ask
  // "what did this run extract" want the same answer in both shapes.
  if (result.article) return [result.article];
  return [];
}

// How many records a run produced.
//
// `count` is the engine's own number and the authoritative one when it is
// positive. The fallback is what matters: an ARTICLE run puts its single record
// in `article` and leaves `count` at 0, so anything reading `count` alone
// concludes an article recipe returned nothing. auditWorking special-cased that
// and auditParameters did not, which produced five false INCONCLUSIVE verdicts
// in one sweep — each reading as "your probe URLs are dead" rather than "this
// audit measured the wrong field". One function so the two cannot drift again.
function countOf(result) {
  if (!result || typeof result !== 'object') return 0;
  if (Number.isFinite(result.count) && result.count > 0) return result.count;
  return recordsOf(result).length;
}

module.exports = { recordsOf, countOf };
