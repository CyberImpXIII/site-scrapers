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
//
// Every finding names the recipes involved, so a fix can start immediately.

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

function main() {
  const which = process.argv[2] || 'all';
  const db = openDb();
  const recipes = recipesWithSteps(db);
  const report = { uiStepRecipesAudited: recipes.length };

  if (which === 'all' || which === 'inline') report.inlinedGenericActions = findInlineDuplicates(db, recipes);
  if (which === 'all' || which === 'repeats') report.extractableSequences = findRepeatedSequences(recipes);
  if (which === 'all' || which === 'literals') report.literalsSharedAcrossRecipes = findSharedLiterals(recipes);
  if (which === 'all' || which === 'hardcoded') report.literalsInsideGenericActions = findHardcodedInGenerics(db);

  const counts = Object.entries(report)
    .filter(([, v]) => Array.isArray(v))
    .map(([k, v]) => `${k}: ${v.length}`);
  out({ ...report, summary: counts.join(', ') });
}

main();
