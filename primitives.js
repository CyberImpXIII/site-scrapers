#!/usr/bin/env node
// What is known about a PAGE, gathered across every recipe that targets it.
//
//   node primitives.js pages                  # every page, and how much is known
//   node primitives.js show <hostname|target> # one page, in full
//
// Read this BEFORE building a second recipe on a page that already has one.
// Three pages here already carry two recipes each, and each pair was
// characterised twice because nothing connected them.
//
// Derived from scrapers.db and failures.db on every call — see lib/primitives.js
// for why there is no table behind it.

process.removeAllListeners('warning');

const { openDb, listSites, getSite, getRecipeHealth, parseSiteArg } = require('./db');
const { openFailuresDb, listFailures } = require('./failuresDb');
const { allPages } = require('./lib/primitives');

function out(o) {
  console.log(JSON.stringify(o, null, 2));
}
function die(msg) {
  out({ success: false, error: msg });
  process.exit(1);
}

function load() {
  const db = openDb();
  const sites = listSites(db)
    .filter(s => !String(s.hostname).endsWith('.internal'))
    .map(s => getSite(db, s.hostname, s.page_type, s.recipe_name));

  let failuresByHost = {};
  try {
    const fdb = openFailuresDb();
    for (const f of listFailures(fdb)) {
      (failuresByHost[f.hostname] ||= []).push(f);
    }
  } catch {
    failuresByHost = {}; // a missing failures.db is not a reason to fail this
  }

  return allPages(sites, { health: getRecipeHealth(db), failuresByHost });
}

function main() {
  const [, , cmd, arg] = process.argv;

  if (cmd === 'pages') {
    const { pages, unkeyed } = load();
    out({
      pages: pages.map(p => ({
        page: p.page,
        recipes: p.recipes.map(r => `${r.pageType}:${r.target.split(':').pop()}`),
        flags: Object.keys(p.flags),
        genericActions: p.genericActions.length,
      })),
      // Surfaced rather than hidden: a recipe with no determinable entry point
      // cannot share what it learns with anything, which is worth seeing.
      recipesWithNoEntryPoint: unkeyed.map(s => `${s.hostname}#${s.page_type}:${s.recipe_name}`),
      hint:
        'A page with 2+ recipes is one where the next recipe should start from `primitives.js show <hostname>` ' +
        'rather than from a browser. Pages listed with 1 recipe are still worth reading before adding a second.',
    });
    return;
  }

  if (cmd === 'show') {
    if (!arg) die('Usage: node primitives.js show <hostname|target>');
    const { hostname } = parseSiteArg(arg);
    const { pages } = load();
    const matches = pages.filter(p => p.hostname.toLowerCase() === hostname.toLowerCase());
    if (!matches.length) {
      die(
        `no registered recipe for "${hostname}", so nothing is known about its pages yet. ` +
          '`node query.js sites` lists what is registered; build the first recipe with `node lab.js new <hostname>`.'
      );
    }
    out({
      hostname,
      pages: matches,
      hint:
        'flags are things you would otherwise rediscover by running into them. ' +
        'genericActions with evidence "ran here via a working recipe" have demonstrably worked on THIS page — ' +
        'prefer them over guessing. "referenced only" means a recipe pulls it in but has not earned `working` yet, ' +
        'and an action absent from the list has never been tried here, which is not the same as not working.',
    });
    return;
  }

  die(`Unknown command "${cmd ?? ''}". Use: pages | show <hostname|target>`);
}

main();
