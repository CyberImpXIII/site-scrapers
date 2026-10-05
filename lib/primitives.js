// Site primitives: everything known about a PAGE, gathered across every recipe
// that targets it.
//
// The problem: `sites` is keyed per recipe, so building a second recipe on a
// page someone already characterised starts from nothing. Three pages already
// carry two recipes each (an ATS posting with an `article` that reads it and an
// `action` that describes its apply form) and each pair was discovered twice.
//
// DERIVED, NOT STORED — deliberately, for now. Everything here already exists
// in the recipe DB and failures.db; a table would be a second copy of it, and a
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

// Folds MEASURED outcomes in beside the ones inferred from recipes.
//
// The two are different kinds of evidence and are labelled as such. A recipe
// referencing an action says it is used here; a trial says what it actually
// did. Where both exist the measurement is the stronger claim, so it leads --
// but the inference is kept, because "a working recipe depends on this" is
// worth knowing even when a trial found no measurable change.
function mergeObservations(fromRecipes, observations) {
  const { isStale, ageInDays } = require('./observations');
  const byAction = new Map(fromRecipes.map(a => [a.action, { ...a }]));

  for (const o of observations) {
    if (o.kind !== 'generic_action') continue;
    const entry = byAction.get(o.subject) || { action: o.subject, viaRecipes: [] };
    entry.measured = {
      outcome: o.outcome,
      detail: o.detail,
      observedAt: o.observed_at,
      ageDays: ageInDays(o.observed_at),
      timesObserved: o.times_observed,
      // Surfaced, not hidden and not auto-deleted: a stale measurement may
      // still be right, and the reader is better placed to judge that than a
      // cutoff is. What must not happen is it reading as current.
      stale: isStale(o) || undefined,
    };
    byAction.set(o.subject, entry);
  }
  return [...byAction.values()].sort((a, b) => a.action.localeCompare(b.action));
}

// Builds the primitive for one page from recipes already grouped onto it.
function buildPrimitive(pageKey, recipes, { health = [], failures = [], observations = [] } = {}) {
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
    genericActions: mergeObservations(actionsFor(recipes, health), observations),
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
  const byPageKey = opts.observationsByPageKey || {};
  const built = [...pages.entries()].map(([key, recipes]) =>
    buildPrimitive(key, recipes, {
      health: opts.health || [],
      failures: (opts.failuresByHost || {})[recipes[0].hostname] || [],
      observations: byPageKey[key] || [],
    })
  );
  built.sort((a, b) => b.recipes.length - a.recipes.length || a.hostname.localeCompare(b.hostname));
  return { pages: built, unkeyed };
}

// What to try on a page, in the order worth trying it.
//
// The "conditional priority" half: given everything measured so far, which
// generic actions are worth running here and which are known to be pointless.
// It exists so that characterising a new page stops being a fixed script and
// starts being informed by what has already been learned.
//
// The ranking is a strict PRECEDENCE, not a score, because a score invites
// tuning weights until the order looks right and nobody can say why it is
// that order. Each tier is a different KIND of evidence:
//
//   known-here    measured on this exact page, and fresh -- nothing to do
//   retry-here    measured on this page but stale, so re-measure first
//   same-host     it did something on another page of this host
//   base-rate     it did something on N of M pages measured anywhere
//   untried       never measured anywhere; no evidence either way
//
// DELIBERATELY ABSENT: a notion of page SIMILARITY beyond same-host. "An ATS
// posting page" is the class that would actually predict, and identity is
// exact -- inventing a similarity metric from 30-odd recipes would be fitting
// noise, and a wrong one is worse than none because it would confidently
// reorder the plan. Recorded in TODO as the open design question it is.
function suggestPlan({ pageKey, hostname, observations, allObservations, availableActions }) {
  const { isStale } = require('./observations');
  const here = new Map();
  for (const o of observations || []) if (o.kind === 'generic_action') here.set(o.subject, o);

  // How often an action did something, per page, across everything measured.
  // Counted per PAGE rather than per observation so a page trialled ten times
  // does not outvote ten pages trialled once.
  const pagesByAction = new Map();
  const hostPages = new Map();
  for (const o of allObservations || []) {
    if (o.kind !== 'generic_action') continue;
    const did = o.outcome === 'changed' || o.outcome === 'reported';
    const acc = pagesByAction.get(o.subject) || { did: new Set(), pages: new Set() };
    acc.pages.add(o.page_key);
    if (did) acc.did.add(o.page_key);
    pagesByAction.set(o.subject, acc);

    if (String(o.hostname).toLowerCase() === String(hostname).toLowerCase() && o.page_key !== pageKey && did) {
      hostPages.set(o.subject, o);
    }
  }

  const plan = [];
  for (const action of availableActions || []) {
    const mine = here.get(action);
    if (mine && !isStale(mine)) {
      plan.push({
        action,
        tier: 'known-here',
        outcome: mine.outcome,
        why: `already measured on this page: ${mine.outcome} — ${mine.detail}`,
      });
      continue;
    }
    if (mine) {
      plan.push({
        action,
        tier: 'retry-here',
        why: `measured here as ${mine.outcome}, but that was ${require('./observations').ageInDays(mine.observed_at)} days ago and the page may have changed`,
      });
      continue;
    }
    const onHost = hostPages.get(action);
    if (onHost) {
      plan.push({
        action,
        tier: 'same-host',
        why: `did something on another page of this host (${onHost.outcome} on ${onHost.observed_url})`,
      });
      continue;
    }
    const rate = pagesByAction.get(action);
    if (rate && rate.pages.size) {
      plan.push({
        action,
        tier: 'base-rate',
        rate: `${rate.did.size}/${rate.pages.size}`,
        why: `did something on ${rate.did.size} of ${rate.pages.size} pages measured elsewhere`,
      });
      continue;
    }
    plan.push({ action, tier: 'untried', why: 'never measured anywhere — no evidence either way' });
  }

  const ORDER = ['retry-here', 'same-host', 'base-rate', 'untried', 'known-here'];
  plan.sort((a, b) => {
    const t = ORDER.indexOf(a.tier) - ORDER.indexOf(b.tier);
    if (t !== 0) return t;
    // Within base-rate, the ones that pay off more often come first.
    const share = x => (x.rate ? Number(x.rate.split('/')[0]) / Number(x.rate.split('/')[1]) : 0);
    return share(b) - share(a) || a.action.localeCompare(b.action);
  });
  return plan;
}

module.exports = { buildPrimitive, allPages, flagsFor, paramsFor, actionsFor, mergeObservations, suggestPlan, pageKeyFor };
