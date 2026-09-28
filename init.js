#!/usr/bin/env node
// First-run setup. Run this once after cloning:
//
//   node init.js
//
// It creates both databases, seeds the shared library (generic actions, the
// failure taxonomy, blocker signatures, the action-type taxonomy) and reports
// exactly what it created, so a fresh clone starts in a known state instead of
// whatever the first command happened to build implicitly.
//
// Seeding also still happens automatically on every openDb(), which is how a
// pulled change to the library reaches your database without a manual step.
// This command exists because an implicit side effect of "whatever you ran
// first" is a poor way to learn what your environment contains — and because
// after a clone, `data/` is empty and nothing tells you that.
//
// What it does NOT do: create recipes. Those are yours, they live only in
// data/scrapers.db, and that file is gitignored on purpose — it holds your
// search history and the sites you care about. A clone starts with the shared
// library and no recipes, which is the correct split.

process.removeAllListeners('warning');

const { openDb, listGenericActions, listActionTypes, listSites } = require('./db');
const { openFailuresDb, listFailureTypes, listBlockerSignatures, listFailures } = require('./failuresDb');
const { exportIsCurrent } = require('./lib/exportBuiltins');

function main() {
  const before = {
    scrapers: require('fs').existsSync(require('./db').DB_PATH),
    failures: require('fs').existsSync(require('./failuresDb').FAILURES_DB_PATH),
  };

  // Opening each database runs its migrations and seeds it.
  const db = openDb();
  const fdb = openFailuresDb();

  const report = {
    createdDatabases: [
      ...(before.scrapers ? [] : ['data/scrapers.db']),
      ...(before.failures ? [] : ['data/failures.db']),
    ],
    sharedLibrary: {
      genericActions: listGenericActions(db).length,
      actionTypes: listActionTypes(db).length,
      failureTypes: listFailureTypes(fdb).length,
      blockerSignatures: listBlockerSignatures(fdb).length,
    },
    yourData: {
      recipes: listSites(db).length,
      recordedFailures: listFailures(fdb).length,
    },
  };

  // If the committed export and the seeded rows disagree at this point,
  // something is wrong before any work has been done — worth knowing now
  // rather than discovering it mid-task.
  const exportState = exportIsCurrent(db);
  if (!exportState.current) {
    report.warning = `the committed builtin export does not match the seeded rows: ${exportState.reason}`;
  }

  report.next =
    report.yourData.recipes === 0
      ? 'No recipes yet — that is expected in a fresh clone, since recipes are yours and are not committed. Build one with `node lab.js new <hostname>`, which prints the whole sequence.'
      : 'Ready. `node query.js sites` lists what is registered.';

  console.log(JSON.stringify(report, null, 2));
}

main();
