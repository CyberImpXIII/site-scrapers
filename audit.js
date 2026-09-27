#!/usr/bin/env node
// Measures duplication across recipes, so "prefer a generic action" is a
// checkable claim instead of good intentions.
//
// The design goal this enforces: a recipe should hold only what is UNIQUE to
// its site — selectors, URLs, field mappings, parameter values. Everything
// procedural should be a parameterised generic action it references. Recipes
// are data, so unlike duplication in code, duplication here can be found
// mechanically.
//
//   node audit.js                # every check
//   node audit.js inline         # recipes that re-implement an existing generic action
//   node audit.js repeats        # step sequences shared by 2+ recipes and not yet extracted
//   node audit.js literals       # the same literal string hard-coded in 2+ recipes
//   node audit.js hardcoded      # generic actions carrying literals that should be parameters
//   node audit.js params         # LIVE: do recipes that declare parameters actually honour them?
//
// `params` runs each recipe twice using its own `param_probe_values` and
// compares the records. It needs the network, so it is not part of ./test.sh —
// that suite has to stay fast and deterministic. Verdicts: ok, INERT (the
// recipe ignores its params), INCONCLUSIVE (both probe runs were empty, so
// pick better values), UNVALIDATABLE (declares params but has no probe values).
//
// Every finding names the recipes involved, so a fix can start immediately.

// node:sqlite emits an ExperimentalWarning on every run, which lands on
// stderr and makes this tool's output awkward to pipe into jq. Real warnings
// are not expected here and would be noise in a machine-read stream.
process.removeAllListeners('warning');


const { openDb, listSites, getSite, listGenericActions } = require('./db');
const { expandSteps, refKey } = require('./lib/composeActions');

const MIN_SEQUENCE = 2;   // a single shared step is not worth extracting
const MIN_RECIPES = 2;    // "reused" means more than one caller

function out(o) {
  console.log(JSON.stringify(o, null, 2));
}

// A step's shape, ignoring the site-specific values inside it. Two steps with
// the same signature do the same KIND of thing, which is what makes them
// candidates for one parameterised action.
function signature(step) {
  const parts = [step.action];
  for (const k of ['stop_if_missing', 'restore_scroll', 'kind', 'only_if_selector']) {
    if (step[k] !== undefined) parts.push(`${k}=${typeof step[k] === 'string' ? 'str' : step[k]}`);
  }
  if (step.action === 'repeat') parts.push(`x${step.times ?? '?'}`);
  return parts.join(':');
}

// Literal values a step carries — the things that should usually be either
// site-specific (fine, they live in the recipe) or parameters (not fine when
// they live in a generic action).
function literalsOf(step) {
  const out = [];
  for (const k of ['selector', 'url', 'text', 'selectors', 'record_nouns', 'default_selector']) {
    const v = step[k];
    if (typeof v === 'string' && v.length > 2 && !/^\{\{[^}]*\}\}$/.test(v)) out.push({ field: k, value: v });
  }
  return out;
}

function recipesWithSteps(db) {
  const rows = [];
  for (const s of listSites(db)) {
    const site = getSite(db, s.hostname, s.page_type, s.recipe_name);
    if (site.nav_method !== 'ui_steps' || !site.nav_template) continue;
    let raw;
    try {
      raw = JSON.parse(site.nav_template);
    } catch {
      continue;
    }
    const key = `${site.hostname}#${site.page_type}:${site.recipe_name}`;
    let expanded = raw;
    try {
      expanded = expandSteps(db, raw, site.hostname, new Set([refKey(site)]));
    } catch {
      /* dangling reference — audit the unexpanded form rather than skipping */
    }
    rows.push({ key, raw, expanded });
  }
  return rows;
}

// A recipe that spells out inline what a generic action already does. The
// highest-value finding: the fix is replacing N steps with one reference.
function findInlineDuplicates(db, recipes) {
  const generics = listGenericActions(db).map(g => {
    const full = require('./db').getGenericAction(db, g.name);
    let steps = [];
    try {
      steps = JSON.parse(full.steps);
    } catch {
      /* ignore unparseable */
    }
    return { name: g.name, sigs: steps.map(signature).join('>'), length: steps.length };
  }).filter(g => g.length >= MIN_SEQUENCE);

  const findings = [];
  for (const r of recipes) {
    // Compare against the recipe's OWN steps, not the expanded form: an
    // expanded recipe legitimately contains a generic action's steps because
    // it referenced it. Only inlining in the source is a problem.
    const sigs = r.raw.map(signature);
    const refs = new Set(r.raw.filter(s => s.action === 'run_generic_action').map(s => s.ref));
    for (const g of generics) {
      if (refs.has(g.name)) continue;
      for (let i = 0; i + g.length <= sigs.length; i++) {
        if (sigs.slice(i, i + g.length).join('>') === g.sigs) {
          findings.push({
            recipe: r.key,
            couldReplaceWith: `generic:${g.name}`,
            stepsAt: `${i}..${i + g.length - 1}`,
            savedSteps: g.length - 1,
            fix: `Replace those steps with {"action":"run_generic_action","ref":"${g.name}"}`,
          });
          break;
        }
      }
    }
  }
  return findings;
}

// Step sequences several recipes share that no generic action covers yet —
// i.e. the next generic actions worth creating.
function findRepeatedSequences(recipes) {
  const seen = new Map();
  for (const r of recipes) {
    const sigs = r.raw.map(signature);
    for (let len = Math.min(6, sigs.length); len >= MIN_SEQUENCE; len--) {
      for (let i = 0; i + len <= sigs.length; i++) {
        const seq = sigs.slice(i, i + len).join(' > ');
        // Sequences that are purely references are already factored out.
        if (!sigs.slice(i, i + len).some(x => !x.startsWith('run_generic_action'))) continue;
        if (!seen.has(seq)) seen.set(seq, new Set());
        seen.get(seq).add(r.key);
      }
    }
  }
  return [...seen.entries()]
    .filter(([, set]) => set.size >= MIN_RECIPES)
    .map(([seq, set]) => ({ sequence: seq, steps: seq.split(' > ').length, recipes: [...set] }))
    // Longest shared sequence first: that is the biggest single extraction.
    .sort((a, b) => b.steps * b.recipes.length - a.steps * a.recipes.length)
    .slice(0, 10);
}

// The same literal in several recipes. Usually means one parameterised action
// is hiding behind copy-paste.
function findSharedLiterals(recipes) {
  const seen = new Map();
  for (const r of recipes) {
    for (const step of r.raw) {
      for (const { field, value } of literalsOf(step)) {
        const k = `${field}=${value}`;
        if (!seen.has(k)) seen.set(k, new Set());
        seen.get(k).add(r.key);
      }
    }
  }
  return [...seen.entries()]
    .filter(([, set]) => set.size >= MIN_RECIPES)
    .map(([k, set]) => ({ literal: k.slice(0, 160), recipes: [...set] }))
    .sort((a, b) => b.recipes.length - a.recipes.length)
    .slice(0, 15);
}

// A generic action is meant to be site-independent. A literal inside one is
// either genuinely universal (a consent-dialog role, a captcha iframe) or
// smuggled domain knowledge that should have been a parameter.
function findHardcodedInGenerics(db) {
  const { getGenericAction } = require('./db');
  const findings = [];
  for (const g of listGenericActions(db)) {
    const full = getGenericAction(db, g.name);
    let steps;
    try {
      steps = JSON.parse(full.steps);
    } catch {
      continue;
    }
    const schema = full.nav_params_schema || '{}';
    for (const step of steps) {
      for (const { field, value } of literalsOf(step)) {
        if (field === 'default_selector') continue; // an overridable default is the intended pattern
        findings.push({
          genericAction: g.name,
          field,
          value: value.slice(0, 120),
          hasAnyParameters: schema !== '{}' && schema !== '',
          note:
            'Universal platform vocabulary (consent dialogs, captcha widgets, form controls) is fine here. ' +
            'Anything specific to a DOMAIN or a site should be a parameter instead — the recipe is meant to be the unique document.',
        });
      }
    }
  }
  return findings;
}

// Does every recipe that DECLARES parameters actually honour them? Runs each
// recipe twice with its own param_probe_values and compares the record sets.
//
// This is validation, not a unit test: it needs the live sites, so it does not
// belong in ./test.sh, which must stay fast and offline-deterministic.
//
// It exists because a declared-but-ignored parameter is worse than a broken
// recipe. nodesk.co accepted {"search":"sales"} and {"search":"engineer"} and
// returned byte-identical results — it answered the wrong question without
// complaining, and a count-based check said it was fine.
async function auditParameters(db) {
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  const execFileAsync = promisify(execFile);
  const path = require('path');

  const run = async (target, params) => {
    const args = [path.join(__dirname, 'engine.js'), target, JSON.stringify({ ...params, allowUnverified: true })];
    try {
      const { stdout } = await execFileAsync(process.execPath, args, { cwd: __dirname, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      return JSON.parse(stdout);
    } catch (e) {
      try {
        return JSON.parse(e.stdout);
      } catch {
        return { success: false, error: 'no parseable output' };
      }
    }
  };

  const findings = [];
  for (const s of listSites(db)) {
    const site = getSite(db, s.hostname, s.page_type, s.recipe_name);
    const target = `${site.hostname}#${site.page_type}:${site.recipe_name}`;
    let schema = {};
    try {
      schema = JSON.parse(site.nav_params_schema || '{}');
    } catch {
      /* unparseable schema is its own problem, reported below */
    }
    const declared = Object.keys(schema);
    if (!declared.length) continue;
    if (site.status === 'blocked' || site.status === 'broken') {
      findings.push({ recipe: target, declaredParams: declared, result: 'skipped', why: `status is "${site.status}"` });
      continue;
    }

    let probes = null;
    try {
      probes = site.param_probe_values ? JSON.parse(site.param_probe_values) : null;
    } catch {
      /* fall through to the unvalidatable branch */
    }
    if (!Array.isArray(probes) || probes.length < 2) {
      findings.push({
        recipe: target,
        declaredParams: declared,
        result: 'UNVALIDATABLE',
        why: 'declares parameters but has no param_probe_values (needs 2+ contrasting param sets)',
        fix: `node lab.js set ${target} '{"param_probe_values":[{"${declared[0]}":"<value A>"},{"${declared[0]}":"<value B>"}]}'`,
      });
      continue;
    }

    const [ra, rb] = [await run(target, probes[0]), await run(target, probes[1])];
    const ids = r => JSON.stringify((r.jobs || []).map(j => j.href ?? j.title ?? '').slice(0, 25));
    const bothEmpty = (ra.count ?? 0) === 0 && (rb.count ?? 0) === 0;
    const identical = ids(ra) === ids(rb);

    findings.push({
      recipe: target,
      declaredParams: declared,
      a: { params: probes[0], url: ra.url, count: ra.count ?? 0 },
      b: { params: probes[1], url: rb.url, count: rb.count ?? 0 },
      result: bothEmpty ? 'INCONCLUSIVE' : identical ? 'INERT' : 'ok',
      why: bothEmpty
        ? 'both probe runs returned nothing, so the comparison proves nothing — pick probe values known to return records'
        : identical
          ? 'both parameter sets returned the SAME records: the recipe is ignoring its parameters. Either find the real filter mechanism (a client-side search may need a ui_steps type step rather than a URL param) or drop the parameter from nav_params_schema so it stops promising what it cannot do.'
          : 'parameters change the result set, as a caller would expect',
    });
  }
  return findings;
}

async function main() {
  const which = process.argv[2] || 'all';
  const db = openDb();
  const recipes = recipesWithSteps(db);
  const report = { uiStepRecipesAudited: recipes.length };

  if (which === 'all' || which === 'inline') report.inlinedGenericActions = findInlineDuplicates(db, recipes);
  if (which === 'all' || which === 'repeats') report.extractableSequences = findRepeatedSequences(recipes);
  if (which === 'all' || which === 'literals') report.literalsSharedAcrossRecipes = findSharedLiterals(recipes);
  if (which === 'all' || which === 'hardcoded') report.literalsInsideGenericActions = findHardcodedInGenerics(db);
  // Only on request: this one runs live recipes, so it is slow and needs the
  // network, unlike the static checks above.
  if (which === 'params') report.parameterValidation = await auditParameters(db);

  const counts = Object.entries(report)
    .filter(([, v]) => Array.isArray(v))
    .map(([k, v]) => `${k}: ${v.length}`);
  out({ ...report, summary: counts.join(', ') });
}

main();
