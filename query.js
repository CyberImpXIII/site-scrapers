#!/usr/bin/env node
// Inspect what's already documented — this is the tool a context-less
// session should reach for FIRST, before assuming a site needs interactive
// re-discovery.
//
// Usage:
//   node query.js sites                  # list every known site + status
//   node query.js site <hostname>        # full recipe + fields for one site
//   node query.js runs <hostname> [n]    # recent run history (reliability)

const { openDb, listSites, getSite, getFields, getRuns } = require('./db');

function main() {
  const [, , cmd, arg, limitArg] = process.argv;
  const db = openDb();

  if (cmd === 'sites' || !cmd) {
    console.log(JSON.stringify(listSites(db), null, 2));
    return;
  }

  if (cmd === 'site') {
    if (!arg) {
      console.log(JSON.stringify({ error: 'Usage: node query.js site <hostname>' }));
      process.exit(1);
    }
    const site = getSite(db, arg);
    if (!site) {
      console.log(JSON.stringify({ error: `No site documented for "${arg}"`, documented: false }));
      process.exit(1);
    }
    const fields = getFields(db, site.id);
    console.log(JSON.stringify({ ...site, fields }, null, 2));
    return;
  }

  if (cmd === 'runs') {
    if (!arg) {
      console.log(JSON.stringify({ error: 'Usage: node query.js runs <hostname> [limit]' }));
      process.exit(1);
    }
    const site = getSite(db, arg);
    if (!site) {
      console.log(JSON.stringify({ error: `No site documented for "${arg}"` }));
      process.exit(1);
    }
    const runs = getRuns(db, site.id, limitArg ? parseInt(limitArg, 10) : 10);
    console.log(JSON.stringify(runs, null, 2));
    return;
  }

  console.log(JSON.stringify({ error: `Unknown command "${cmd}". Use: sites | site <hostname> | runs <hostname> [n]` }));
  process.exit(1);
}

main();
