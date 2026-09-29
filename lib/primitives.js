// Site primitives: everything known about a PAGE, gathered across every recipe
// that targets it.
//
// The problem: `sites` is keyed per recipe, so building a second recipe on a
// page someone already characterised starts from nothing. Three pages already
// carry two recipes each (an ATS posting with an `article` that reads it and an
// `action` that describes its apply form) and each pair was discovered twice.
//
// DERIVED, NOT STORED — deliberately, for now. Everything here already exists
// in scrapers.db and failures.db; a table would be a second copy of it, and a
// second copy needs a write path, a gate, and a staleness policy to stop it
// disagreeing with the source. None of that is worth paying before the shape
// has proven itself. Storage becomes necessary at the point we record something
// NOT derivable — a probe result for a page with no recipe yet, or a generic
// action tried speculatively — which is the next slice, not this one.
//
// So: no migration, no write path, and nothing can go stale, because there is
// nothing to go stale. `node primitives.js` reads it fresh every time.

const { entryUrlFor, pageKeyFor, describePageKey, groupByPage } = require('./pageIdentity');
const { referencedActions } = require('./gate');

const DEFAULT_READY_TIMEOUT = 20000;

// What a recipe's own columns and steps say about the PAGE, as opposed to about
// the recipe. Each flag is something the next person building here would
// otherwise rediscover by running into it.
function flagsFor(recipes) {
  const flags = {};
  const note = (k, v) => { if (v !== undefined && v !== null && v !== false) flags[k] = v; };

  const steps = recipes.flatMap(r => {
    if (r.nav_method !== 'ui_steps') return [];
    try { return JSON.parse(r.nav_template) || []; } catch { return []; }
  });
  const stepActions = new Set();
  const walk = list => {
    for (const s of Array.isArray(list) ? list : []) {
      if (s && s.action) stepActions.add(s.action);
      if (s && Array.isArray(s.steps)) walk(s.steps);
    }
  };
  walk(steps);

  const slowest = Math.max(0, ...recipes.map(r => Number(r.ready_timeout_ms) || 0));
  if (slowest > DEFAULT_READY_TIMEOUT) {
    note('slowRender', `needs ${slowest}ms — probing at the 5s default reports zero of everything`);
  }
  // session_mode "none" is the one worth surfacing: it means the page only
  // works LOGGED OUT, and a saved session silently returns nothing.
  const noSession = recipes.find(r => r.session_mode === 'none');
  if (noSession) note('mustBeLoggedOut', 'session_mode:"none" — a saved session makes this return 0 records');

  const paginated = recipes.find(r => r.pagination_method && r.pagination_method !== 'none');
  if (paginated) note('paginates', paginated.pagination_method);

  const carded = recipes.find(r => r.card_selector || r.card_anchor_text);
  if (carded) {
    note('cardSelector', carded.card_selector || undefined);
    note('cardAnchorText', carded.card_anchor_text || undefined);
  }
  if (stepActions.has('handoff')) note('needsAPersonMidRun', 'a handoff step runs this headed');

  const blocked = recipes.filter(r => r.status === 'blocked' || r.status === 'blocked-attn');
  if (blocked.length) note('blocked', blocked.map(r => `${r.page_type}:${r.recipe_name}=${r.status}`).join(', '));

  return flags;
}

// Parameters any recipe on this page accepts, and the values known to work.
// Pooled across recipes on purpose: a second recipe on the same page usually
// takes the same input as the first, and that is exactly the guesswork worth
// removing.
function paramsFor(recipes) {
  const declared = {};
  const known = {};
  for (const r of recipes) {
    const target = `${r.page_type}:${r.recipe_name}`;
    try {
      const schema = r.nav_params_schema ? JSON.parse(r.nav_params_schema) : null;
      if (schema && typeof schema === 'object') for (const [k, v] of Object.entries(schema)) declared[k] = v;
    } catch { /* a malformed schema is audit.js's problem, not this view's */ }
    try {
      const probes = r.param_probe_values ? JSON.parse(r.param_probe_values) : null;
      if (Array.isArray(probes) && probes.length) known[target] = probes;
    } catch { /* same */ }
  }
  return { declared, knownWorkingValues: known };
}

// Generic actions the recipes on this page pull in, with the evidence that they
// work HERE rather than in general.
//
// This is the cheap half of "which generic actions are functional on this
// page": an action referenced by a recipe whose status is `working` has
// demonstrably run against this page. It says nothing about actions never
// tried, which is what the next slice adds.
function actionsFor(recipes, health) {
  const byAction = new Map();
  for (const r of recipes) {
    let steps = [];
    if (r.nav_method === 'ui_steps') {
      try { steps = JSON.parse(r.nav_template) || []; } catch { steps = []; }
    }
    if (r.pagination_config) {
      try { steps = steps.concat(JSON.parse(r.pagination_config) || []); } catch { /* ignore */ }
    }
    const target = `${r.hostname}#${r.page_type}:${r.recipe_name}`;
    const stat = health.find(h => `${h.hostname}#${h.page_type}:${h.recipe_name}` === target);
    for (const ref of referencedActions(steps).generic) {
      if (!byAction.has(ref)) byAction.set(ref, { action: ref, viaRecipes: [], evidence: 'referenced only' });
      const entry = byAction.get(ref);
      entry.viaRecipes.push(`${r.page_type}:${r.recipe_name}`);
      // "Earned" in the same sense `status` is: a run extracted records from a
      // definition that pulls this action in.
      if (r.status === 'working') {
        const rate = stat && stat.successRate !== null ? ` (${stat.recentOk}/${stat.recentRuns} recent runs)` : '';
        entry.evidence = `ran here via a working recipe${rate}`;
      }
    }
  }
  return [...byAction.values()].sort((a, b) => a.action.localeCompare(b.action));
}

// Builds the primitive for one page from recipes already grouped onto it.
function buildPrimitive(pageKey, recipes, { health = [], failures = [] } = {}) {
  const first = recipes[0];
  return {
    page: describePageKey(pageKey),
    hostname: first.hostname,
    entryUrl: entryUrlFor(first),
    recipes: recipes.map(r => ({
      target: `${r.hostname}#${r.page_type}:${r.recipe_name}`,
      pageType: r.page_type,
      status: r.status,
      lastVerified: r.last_verified,
    })),
    flags: flagsFor(recipes),
    params: paramsFor(recipes),
    genericActions: actionsFor(recipes, health),
    // What has broken on this HOST before. Host-scoped rather than page-scoped
    // because that is how failures are recorded, and a wall or a slow render is
    // usually a property of the site rather than of one URL.
    knownFailures: failures.map(f => ({
      type: f.failure_type,
      symptom: f.symptom,
      resolution: f.resolution || null,
      occurrences: f.occurrences,
      lastSeen: f.last_seen,
    })),
  };
}

// Every page, newest-characterised first is not meaningful here, so: ordered by
// how much is known about them (recipe count), then hostname.
function allPages(sites, opts = {}) {
  const { pages, unkeyed } = groupByPage(sites);
  const built = [...pages.entries()].map(([key, recipes]) =>
    buildPrimitive(key, recipes, {
      health: opts.health || [],
      failures: (opts.failuresByHost || {})[recipes[0].hostname] || [],
    })
  );
  built.sort((a, b) => b.recipes.length - a.recipes.length || a.hostname.localeCompare(b.hostname));
  return { pages: built, unkeyed };
}

module.exports = { buildPrimitive, allPages, flagsFor, paramsFor, actionsFor, pageKeyFor };
