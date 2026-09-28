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
//   node audit.js units          # static invariants per component: unimplemented step types,
//                                # unregistered probe kinds, undocumented or unread parameters,
//                                # builtins that did not seed. Offline and instant.
//   node audit.js params         # LIVE: do recipes that declare parameters actually honour them?
//   node audit.js working        # LIVE: does every recipe claiming "working" actually return records now?
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
  // `kind` carries its VALUE because it is a small closed enum describing what
  // the step asks, not site data — a forms probe and a blockers probe are
  // different steps. Collapsing it to "str" like a selector made them look
  // interchangeable, which would let the audit advise extracting a "shared"
  // sequence that two recipes do not actually share.
  if (step.kind !== undefined) parts.push(`kind=${step.kind}`);
  for (const k of ['stop_if_missing', 'restore_scroll', 'only_if_selector', 'optional_selector']) {
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

// Static invariant checks on individual components — the pieces the live
// audits cannot reach because they are about internal consistency rather than
// about what a site returns. All offline and instant: no browser, no network.
//
// These catch the class of mistake that produces no error and no wrong answer,
// just a quiet dead end: a probe kind referenced by a generic action but never
// registered, a step type used in a recipe that the engine does not implement,
// a parameter documented in a schema that the steps never read, a failure type
// nothing can ever match.
function auditUnits(db) {
  const findings = [];
  const add = (severity, unit, problem, why) => findings.push({ severity, unit, problem, why });

  const { PROBE_KINDS } = require('./lib/probes');
  const { BUILTIN_ACTIONS } = require('./lib/builtinActions');
  const generics = listGenericActions(db).map(g => require('./db').getGenericAction(db, g.name));

  // Step types the engine actually implements, read from its source rather
  // than duplicated here — a hand-maintained copy would drift and then this
  // audit would report phantom problems.
  const engineSrc = require('fs').readFileSync(require('path').join(__dirname, 'engine.js'), 'utf8');
  // camelCase too: waitForSelector and scroll_bottom are both real step types,
  // and a lowercase-only pattern reported the former as unimplemented.
  const implemented = new Set([...engineSrc.matchAll(/case '([A-Za-z_]+)':/g)].map(m => m[1]));

  const allSteps = [];
  for (const g of generics) {
    let steps;
    try {
      steps = JSON.parse(g.steps);
    } catch {
      add('error', `generic:${g.name}`, 'steps are not valid JSON', 'the action can never run');
      continue;
    }
    const walk = list => {
      for (const s of list) {
        allSteps.push({ owner: `generic:${g.name}`, step: s, schema: g.nav_params_schema });
        if (Array.isArray(s.steps)) walk(s.steps);
      }
    };
    walk(steps);
  }
  for (const r of recipesWithSteps(db)) {
    const site = getSite(db, ...r.key.split(/[#:]/));
    const walk = list => {
      for (const s of list) {
        allSteps.push({ owner: r.key, step: s, schema: site?.nav_params_schema });
        if (Array.isArray(s.steps)) walk(s.steps);
      }
    };
    walk(r.raw);
  }

  for (const { owner, step } of allSteps) {
    if (!step.action) {
      add('error', owner, 'a step has no action', 'the engine will fall through and do nothing');
      continue;
    }
    if (!implemented.has(step.action) && !['run_action', 'run_generic_action'].includes(step.action)) {
      add('error', owner, `step action "${step.action}" is not implemented by engine.js`, 'it silently does nothing at run time');
    }
    if (step.action === 'probe' && step.kind && !PROBE_KINDS[step.kind]) {
      add(
        'error',
        owner,
        `probe kind "${step.kind}" is not registered`,
        `runProbe returns an error object instead of a result; known kinds: ${Object.keys(PROBE_KINDS).join(', ')}`
      );
    }
  }

  // A parameter a generic action documents but no step reads is a promise to
  // callers that nothing honours.
  for (const g of generics) {
    let schema = {};
    try {
      schema = JSON.parse(g.nav_params_schema || '{}');
    } catch {
      add('warn', `generic:${g.name}`, 'nav_params_schema is not valid JSON', 'callers cannot discover its parameters');
      continue;
    }
    const body = g.steps || '';
    for (const name of Object.keys(schema)) {
      if (!body.includes(`{{${name}}}`)) {
        add(
          'warn',
          `generic:${g.name}`,
          `documents parameter "${name}" but no step references {{${name}}}`,
          'passing it via `with` would have no effect'
        );
      }
    }
    // And the reverse: a placeholder with no documentation is undiscoverable.
    for (const m of body.matchAll(/\{\{(\w+)\}\}/g)) {
      if (!(m[1] in schema)) {
        add(
          'warn',
          `generic:${g.name}`,
          `uses {{${m[1]}}} but nav_params_schema does not document it`,
          'a caller has no way to know the parameter exists'
        );
      }
    }
  }

  // Every builtin must survive the round trip into the DB, or edits to
  // lib/builtinActions.js silently do not take effect.
  for (const b of BUILTIN_ACTIONS) {
    const row = generics.find(g => g.name === b.name);
    if (!row) {
      add('error', `generic:${b.name}`, 'defined in lib/builtinActions.js but absent from the DB', 'seeding did not take');
    } else if (row.source !== 'builtin') {
      add('error', `generic:${b.name}`, `is in the DB with source="${row.source}"`, 're-seeding will not update it, so edits to the code file are silently ignored');
    }
    if (!b.description || b.description.length < 40) {
      add('warn', `generic:${b.name}`, 'has little or no description', 'the library is only discoverable through these');
    }
  }

  return findings;
}

// Which template placeholders a probe param-set cannot fill. Pure and
// exported, because getting it wrong is how a verified recipe gets called a
// liar: an earlier version looked for the word "required" in the schema prose
// and so ran wellfound.com with no params, leaving "{{role}}" in the URL.
function unfillablePlaceholders(navTemplate, probeSet) {
  const names = [...String(navTemplate || '').matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]);
  return [...new Set(names)].filter(name => !(probeSet && typeof probeSet === 'object' && name in probeSet));
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
      // refKey takes camelCase, but a DB row is snake_case — passing the row
      // directly seeded cycle detection with "host#undefined:undefined", so a
      // self-referencing recipe would not have been caught here.
      expanded = expandSteps(
        db,
        raw,
        site.hostname,
        new Set([refKey({ hostname: site.hostname, pageType: site.page_type, recipeName: site.recipe_name })])
      );
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

// Does every recipe claiming "working" actually work RIGHT NOW?
//
// `status` is only as good as the last run behind it, and recipes rot: sites
// redesign, filters stop being honoured, a card container gets renamed. A
// recipe that claims working and returns nothing is worse than one marked
// broken, because a caller trusts it. `dev.sh health` answers this from run
// HISTORY, which goes stale exactly when it matters; this answers it from a
// run made now.
//
// Verdicts:
//   ok            records came back
//   INFRA         the browser crashed or was torn down — says nothing about the recipe
//   LIAR          claims working, returned nothing — status is wrong
//   PARTIAL       timed out but still extracted records; usable, likely short timeout
//   UNRUNNABLE    needs parameters and has no param_probe_values to supply them
async function auditWorking(db) {
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
    if (s.status !== 'working') continue;
    if (/\.internal$/.test(s.hostname)) continue; // tool scaffolding, not a recipe
    const site = getSite(db, s.hostname, s.page_type, s.recipe_name);
    const target = `${site.hostname}#${site.page_type}:${site.recipe_name}`;

    let schema = {};
    try {
      schema = JSON.parse(site.nav_params_schema || '{}');
    } catch {
      /* an unparseable schema is reported by the run itself */
    }
    // A required parameter with no probe value cannot be exercised: calling
    // without it leaves "{{param}}" unsubstituted in the URL, which produces a
    // confusing empty result rather than an error. Reported as UNRUNNABLE
    // rather than counted as a failure, since the recipe may be fine.
    let probes = null;
    try {
      probes = site.param_probe_values ? JSON.parse(site.param_probe_values) : null;
    } catch {
      /* fall through */
    }
    // Detected from the TEMPLATE, not from the schema prose. Looking for the
    // word "required" in a description missed wellfound.com, whose schema
    // documents `role` without calling it required — so the audit ran it with
    // no params, left "{{role}}" unsubstituted in the URL, got nothing back and
    // called a recipe verified at 39 records a liar. An unfilled placeholder is
    // the exact, mechanical condition: the URL has holes nothing can fill.
    const probeSet = Array.isArray(probes) && probes.length ? probes[0] : null;
    const unfillable = unfillablePlaceholders(site.nav_template, probeSet);
    if (unfillable.length) {
      findings.push({
        recipe: target,
        result: 'UNRUNNABLE',
        why: `claims working, but nav_template has placeholder(s) {{${unfillable.join('}}, {{')}}} that param_probe_values does not supply — running it would leave them unsubstituted and look like a failure`,
        fix: `node lab.js set ${target} '{"param_probe_values":[{...}]}'`,
      });
      continue;
    }

    const r = await run(target, (Array.isArray(probes) && probes[0]) || {});
    const count = r.count ?? (r.article ? 1 : 0);

    // A browser that crashed or was torn down mid-run says nothing about the
    // recipe, and calling it a LIAR would send someone to "fix" something that
    // works. Observed for real: running two sweeps at once produced "detached
    // Frame", "Execution context was destroyed" and "Target closed" across five
    // recipes that all returned records when run alone. These are Puppeteer/CDP
    // failures, distinguishable by their wording and unrelated to selectors.
    const INFRA_ERRORS =
      /detached Frame|Execution context was destroyed|Target closed|Protocol error|Session closed|browser has disconnected|WebSocket is not open/i;
    const infra = count === 0 && INFRA_ERRORS.test(String(r.error || ''));

    findings.push({
      recipe: target,
      result: infra ? 'INFRA' : count > 0 ? (r.partialResults ? 'PARTIAL' : 'ok') : 'LIAR',
      records: count,
      timedOut: r.timedOut ?? null,
      error: r.error ?? null,
      failedStep: r.failedStep ? `step ${r.failedStep.index} ${r.failedStep.action} ${r.failedStep.selector ?? ''}` : null,
      waitingOn: r.failureContext?.matcher?.value ?? null,
      debugDir: r.debugDir ?? null,
      ...(infra
        ? {
            why:
              'the BROWSER failed, not the recipe — this says nothing about whether the recipe works. Almost always resource ' +
              'contention: do not run two sweeps at once, or other browser work alongside one. Re-run this recipe alone before ' +
              'concluding anything.',
          }
        : count === 0
          ? { why: 'claims working but returned no records. Either fix it, or let verify.js set an honest status from a real run.' }
          : {}),
      ...(r.partialResults ? { why: 'records came back but the wait expired first — raise ready_timeout_ms' } : {}),
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
  if (which === 'all' || which === 'units') report.unitInvariants = auditUnits(db);
  if (which === 'all' || which === 'hardcoded') report.literalsInsideGenericActions = findHardcodedInGenerics(db);
  // Only on request: this one runs live recipes, so it is slow and needs the
  // network, unlike the static checks above.
  if (which === 'params') report.parameterValidation = await auditParameters(db);
  // Also live, and the one that answers "is what we claim actually true".
  if (which === 'working') report.workingRecipeValidation = await auditWorking(db);

  const counts = Object.entries(report)
    .filter(([, v]) => Array.isArray(v))
    .map(([k, v]) => `${k}: ${v.length}`);
  out({ ...report, summary: counts.join(', ') });
}

// Only run as a CLI, so the pure functions above can be unit-tested. They are
// the interesting part — signature normalisation and duplication detection are
// where a wrong answer quietly produces either noise or false confidence.
if (require.main === module) main();

module.exports = {
  unfillablePlaceholders,
  signature,
  literalsOf,
  findRepeatedSequences,
  findSharedLiterals,
  findInlineDuplicates,
};
