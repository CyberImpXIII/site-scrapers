#!/usr/bin/env node
// Inspect what's already documented — this is the tool a context-less
// session should reach for FIRST, before assuming a site needs interactive
// re-discovery.
//
// Usage:
//   node query.js sites                                    # list every known recipe + status
//   node query.js site <hostname>[#page_type[:recipe_name]] # full recipe + fields for one site
//   node query.js runs <hostname>[#page_type[:recipe_name]] [n] # recent run history (reliability)
//   node query.js action-types                              # the action_type taxonomy for page_type "action"
//   node query.js sessions [hostname]                        # saved session cookie jars (metadata only, never cookie values)
//   node query.js clear-session <hostname>[:sessionName]      # delete one saved session, forcing a fresh login/handoff next run
//   node query.js expand <hostname>#page_type:recipe_name     # flatten a ui_steps recipe's run_action/run_generic_action references
//   node query.js expand generic:<name>                       # same, for a generic_actions library entry
//   node query.js generic-actions                             # list the generic_actions library (name/description/action_type, no steps)
//   node query.js generic-action <name>                       # one generic action, full detail including steps
//   node query.js health [recentN]                            # observed reliability per recipe vs its declared status (default last 10 runs)
//   node query.js efficiency                                  # real output-size history per recipe (avg/min/max chars + rough est. tokens)
//   node query.js debug-captures                              # failed-run diagnostics (screenshot/DOM/console/network dirs), newest last
//
// #page_type ('#listing' | '#article' | '#action') picks which recipe when a
// hostname has more than one; omitting it defaults to 'listing'. A hostname
// can also have more than one recipe of the SAME page_type (e.g. two
// 'action' recipes) — add ':recipe_name' to disambiguate, e.g.
// "example.com#action:login". Omitting it defaults to 'default'. Run
// `node query.js sites` to see every (hostname, page_type, recipe_name)
// combination that's registered.
//
// Before registering a NEW 'action' recipe, run `node query.js action-types`
// and prefer reusing an existing action_type over inventing a near-duplicate
// (e.g. "add_to_cart" vs "add-to-basket") — register.js enforces this.

const {
  openDb,
  listSites,
  getSite,
  getFields,
  getRuns,
  getRecipeHealth,
  getEfficiencyStats,
  parseSiteArg,
  listActionTypes,
  listGenericActions,
  getGenericAction,
} = require('./db');
const { listSessions, clearSession } = require('./lib/sessions');
const { expandSteps, refKey, genericRefKey } = require('./lib/composeActions');
const { listDebugCaptures } = require('./lib/debug');

function main() {
  const [, , cmd, arg, limitArg] = process.argv;
  const db = openDb();

  if (cmd === 'sites' || !cmd) {
    console.log(JSON.stringify(listSites(db), null, 2));
    return;
  }

  if (cmd === 'site') {
    if (!arg) {
      console.log(JSON.stringify({ error: 'Usage: node query.js site <hostname>[#page_type[:recipe_name]]' }));
      process.exit(1);
    }
    const { hostname, pageType, recipeName } = parseSiteArg(arg);
    const site = getSite(db, hostname, pageType, recipeName);
    if (!site) {
      console.log(JSON.stringify({ error: `No site documented for "${hostname}#${pageType}:${recipeName}"`, documented: false }));
      process.exit(1);
    }
    const fields = getFields(db, site.id);
    console.log(JSON.stringify({ ...site, fields }, null, 2));
    return;
  }

  if (cmd === 'action-types') {
    console.log(JSON.stringify(listActionTypes(db), null, 2));
    return;
  }

  if (cmd === 'sessions') {
    console.log(JSON.stringify(listSessions(arg), null, 2));
    return;
  }

  if (cmd === 'clear-session') {
    if (!arg) {
      console.log(JSON.stringify({ error: 'Usage: node query.js clear-session <hostname>[:sessionName]' }));
      process.exit(1);
    }
    const [hostname, sessionName] = arg.split(':');
    const removed = clearSession(hostname, sessionName);
    console.log(JSON.stringify({ removed, hostname, sessionName: sessionName || 'default' }));
    return;
  }

  if (cmd === 'expand') {
    if (!arg) {
      console.log(JSON.stringify({ error: 'Usage: node query.js expand <hostname>#page_type:recipe_name | expand generic:<name>' }));
      process.exit(1);
    }

    if (arg.startsWith('generic:')) {
      const name = arg.slice('generic:'.length);
      const ga = getGenericAction(db, name);
      if (!ga) {
        console.log(JSON.stringify({ error: `No generic action documented for "${name}"`, documented: false }));
        process.exit(1);
      }
      try {
        // No fixed hostname to resolve a bare run_action against — pass
        // null, same as register.js's check (bare refs are only valid once
        // something with a real hostname invokes this).
        const steps = expandSteps(db, JSON.parse(ga.steps), null, new Set([genericRefKey(name)]));
        console.log(JSON.stringify({ name, steps }, null, 2));
      } catch (e) {
        console.log(JSON.stringify({ error: e.message }));
        process.exit(1);
      }
      return;
    }

    const { hostname, pageType, recipeName } = parseSiteArg(arg);
    const site = getSite(db, hostname, pageType, recipeName);
    if (!site) {
      console.log(JSON.stringify({ error: `No site documented for "${hostname}#${pageType}:${recipeName}"`, documented: false }));
      process.exit(1);
    }
    if (site.nav_method !== 'ui_steps') {
      console.log(JSON.stringify({ error: `"${hostname}#${pageType}:${recipeName}" uses nav_method "${site.nav_method}", not "ui_steps" — nothing to expand.` }));
      process.exit(1);
    }
    try {
      const steps = expandSteps(db, JSON.parse(site.nav_template), hostname, new Set([refKey({ hostname, pageType, recipeName })]));
      console.log(JSON.stringify({ hostname, pageType, recipeName, steps }, null, 2));
    } catch (e) {
      console.log(JSON.stringify({ error: e.message }));
      process.exit(1);
    }
    return;
  }

  if (cmd === 'generic-actions') {
    console.log(JSON.stringify(listGenericActions(db), null, 2));
    return;
  }

  if (cmd === 'generic-action') {
    if (!arg) {
      console.log(JSON.stringify({ error: 'Usage: node query.js generic-action <name>' }));
      process.exit(1);
    }
    const ga = getGenericAction(db, arg);
    if (!ga) {
      console.log(JSON.stringify({ error: `No generic action documented for "${arg}"`, documented: false }));
      process.exit(1);
    }
    console.log(JSON.stringify({ ...ga, steps: JSON.parse(ga.steps) }, null, 2));
    return;
  }

  if (cmd === 'health') {
    const recentN = arg ? parseInt(arg, 10) : 10;
    console.log(JSON.stringify(getRecipeHealth(db, Number.isFinite(recentN) ? recentN : 10), null, 2));
    return;
  }

  if (cmd === 'efficiency') {
    console.log(JSON.stringify(getEfficiencyStats(db), null, 2));
    return;
  }

  if (cmd === 'debug-captures') {
    console.log(JSON.stringify(listDebugCaptures(), null, 2));
    return;
  }

  if (cmd === 'runs') {
    if (!arg) {
      console.log(JSON.stringify({ error: 'Usage: node query.js runs <hostname>[#page_type[:recipe_name]] [limit]' }));
      process.exit(1);
    }
    const { hostname, pageType, recipeName } = parseSiteArg(arg);
    const site = getSite(db, hostname, pageType, recipeName);
    if (!site) {
      console.log(JSON.stringify({ error: `No site documented for "${hostname}#${pageType}:${recipeName}"` }));
      process.exit(1);
    }
    const runs = getRuns(db, site.id, limitArg ? parseInt(limitArg, 10) : 10);
    console.log(JSON.stringify(runs, null, 2));
    return;
  }

  console.log(JSON.stringify({
    error: `Unknown command "${cmd}". Use: sites | site <hostname>[#page_type[:recipe_name]] | runs <hostname>[#page_type[:recipe_name]] [n] | action-types | sessions [hostname] | clear-session <hostname>[:sessionName] | expand <hostname>#page_type:recipe_name | expand generic:<name> | generic-actions | generic-action <name> | efficiency | health [recentN] | debug-captures`,
  }));
  process.exit(1);
}

main();
