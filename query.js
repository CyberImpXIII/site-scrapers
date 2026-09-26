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

const { openDb, listSites, getSite, getFields, getRuns, parseSiteArg, listActionTypes } = require('./db');

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

  console.log(JSON.stringify({ error: `Unknown command "${cmd}". Use: sites | site <hostname>[#page_type[:recipe_name]] | runs <hostname>[#page_type[:recipe_name]] [n] | action-types` }));
  process.exit(1);
}

main();
