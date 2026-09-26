const { getSite, parseSiteArg, getGenericAction } = require('../db');

// Parses a run_action step's `ref` into a full (hostname, page_type,
// recipe_name). Bare "recipe_name" means "the same hostname, page_type
// 'action'" — the common case, reusing e.g. a 'login' action on the same
// site. "hostname.com#page_type:recipe_name" is fully qualified, for
// cross-hostname composition (an SSO login on a different domain) or to
// reference a non-'action' page_type explicitly.
function resolveActionRef(ref, callerHostname) {
  if (ref.includes('#')) {
    return parseSiteArg(ref);
  }
  return { hostname: callerHostname, pageType: 'action', recipeName: ref };
}

function refKey({ hostname, pageType, recipeName }) {
  return `${hostname}#${pageType}:${recipeName}`;
}

function genericRefKey(name) {
  return `generic:${name}`;
}

// Resolves ONE run_action step to the (unexpanded) step array it points at,
// without recursing into any run_action/run_generic_action steps inside it.
// Used by both the full recursive expander below and by register.js's
// shallow, non-fatal existence check at registration time.
function resolveOneLevel(db, ref, callerHostname) {
  const target = resolveActionRef(ref, callerHostname);
  const site = getSite(db, target.hostname, target.pageType, target.recipeName);
  if (!site) {
    return { target, error: `references "${refKey(target)}", which isn't registered` };
  }
  if (site.status !== 'working') {
    return { target, error: `references "${refKey(target)}", which is status="${site.status}" (not working)` };
  }
  let steps;
  if (site.nav_method === 'ui_steps') {
    steps = JSON.parse(site.nav_template);
  } else if (site.nav_method === 'direct_url') {
    steps = [{ action: 'goto', url: site.nav_template }];
  } else {
    return {
      target,
      error: `references "${refKey(target)}" with unsupported nav_method "${site.nav_method}" for composition (only ui_steps/direct_url recipes can be composed)`,
    };
  }
  return { target, steps };
}

// Same idea as resolveOneLevel, but against the hostname-independent
// generic_actions library instead of a specific site's recipes.
function resolveOneLevelGeneric(db, name) {
  const ga = getGenericAction(db, name);
  if (!ga) {
    return { error: `references generic action "${name}", which isn't registered (see \`node query.js generic-actions\`)` };
  }
  let steps;
  try {
    steps = JSON.parse(ga.steps);
  } catch (e) {
    return { error: `generic action "${name}" has invalid steps JSON: ${e.message}` };
  }
  return { steps };
}

// Recursively replaces every run_action/run_generic_action step with the
// (recursively expanded) steps of what it references — composition is
// inline execution on the SAME page, not a separate browser or session. A
// generic action's own steps keep whatever `callerHostname` was in effect
// when it was pulled in, so a bare run_action inside a generic macro still
// resolves against the site that originally invoked the chain. Throws with
// a clear message on a dangling reference, a referenced site recipe that
// isn't status:"working", or a reference cycle (`visited` should be seeded
// with the top-level recipe's own key so a direct self-reference is also
// caught).
function expandSteps(db, steps, callerHostname, visited) {
  const out = [];
  for (const step of steps) {
    if (step.action === 'run_action') {
      if (!step.ref) throw new Error('run_action step is missing "ref"');
      const { target, steps: subSteps, error } = resolveOneLevel(db, step.ref, callerHostname);
      const key = refKey(target);
      if (error) throw new Error(`run_action ${error}`);
      if (visited.has(key)) {
        throw new Error(
          `run_action cycle detected: "${key}" is referenced again (directly or indirectly) from within its own chain`
        );
      }
      const nextVisited = new Set(visited);
      nextVisited.add(key);
      out.push(...expandSteps(db, subSteps, target.hostname, nextVisited));
    } else if (step.action === 'run_generic_action') {
      if (!step.ref) throw new Error('run_generic_action step is missing "ref"');
      const { steps: subSteps, error } = resolveOneLevelGeneric(db, step.ref);
      const key = genericRefKey(step.ref);
      if (error) throw new Error(`run_generic_action ${error}`);
      if (visited.has(key)) {
        throw new Error(
          `run_generic_action cycle detected: "${key}" is referenced again (directly or indirectly) from within its own chain`
        );
      }
      const nextVisited = new Set(visited);
      nextVisited.add(key);
      out.push(...expandSteps(db, subSteps, callerHostname, nextVisited));
    } else {
      out.push(step);
    }
  }
  return out;
}

// Non-fatal existence check for register.js: returns [{ref, error}] for any
// run_action/run_generic_action step that doesn't currently resolve. Real,
// fatal checking (including cycles) happens in expandSteps at run/expand
// time. callerHostname may be null — e.g. checking a generic action's own
// steps, which don't have a fixed hostname until something invokes them —
// in which case a BARE run_action ref (no hostname of its own) can't be
// checked yet and is silently skipped rather than flagged as unresolved.
function checkUnresolvedRefs(db, steps, callerHostname) {
  const problems = [];
  for (const step of steps) {
    if (step.action === 'run_action' && step.ref) {
      if (!step.ref.includes('#') && !callerHostname) continue;
      const { error } = resolveOneLevel(db, step.ref, callerHostname);
      if (error) problems.push({ ref: step.ref, error: `run_action ${error}` });
    } else if (step.action === 'run_generic_action' && step.ref) {
      const { error } = resolveOneLevelGeneric(db, step.ref);
      if (error) problems.push({ ref: step.ref, error: `run_generic_action ${error}` });
    }
  }
  return problems;
}

function stepsNeedHeaded(steps) {
  return steps.some(s => s.action === 'handoff');
}

module.exports = {
  resolveActionRef,
  resolveOneLevel,
  resolveOneLevelGeneric,
  expandSteps,
  checkUnresolvedRefs,
  stepsNeedHeaded,
  refKey,
  genericRefKey,
};
