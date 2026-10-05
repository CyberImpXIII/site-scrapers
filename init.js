#!/usr/bin/env node
// First-run setup. Run this once after cloning:
//
//   node init.js
//
// It creates both databases, seeds the shared library (generic actions, the
// failure taxonomy, blocker signatures, the action-type taxonomy), reports which
// of this project's rules are actually ENFORCED by a live hook, and says exactly
// what it created — so a fresh clone starts in a known state instead of whatever
// the first command happened to build implicitly.
//
// Seeding also still happens automatically on every openDb(), which is how a
// pulled change to the library reaches your database without a manual step.
// This command exists because an implicit side effect of "whatever you ran
// first" is a poor way to learn what your environment contains — and because
// after a clone, `data/` is empty and nothing tells you that.
//
// What it does NOT do: create recipes. Those are yours, they live only in
// the recipe DB (db.js's DB_PATH, under data/), and that file is gitignored on purpose — it holds your
// search history and the sites you care about. A clone starts with the shared
// library and no recipes, which is the correct split.

process.removeAllListeners('warning');

const { openDb, listGenericActions, listActionTypes, listSites } = require('./db');
const { openFailuresDb, listFailureTypes, listBlockerSignatures, listFailures } = require('./failuresDb');
const { exportIsCurrent } = require('./lib/exportBuiltins');

// Three of this project's rules are enforced by PreToolUse hooks rather than
// stated, because stating them did not work (each hook's header says which rule
// and what it cost). They are committed, so a clone HAS them — but a hook only
// fires when Claude Code's project dir is the one holding it, its file has to be
// executable, and settings.json has to name it. None of that is visible until
// something quietly is not enforced, which for a guard is the worst state to be
// in: you believe you are covered.
//
// So this reports it. A hook whose file is MISSING is called out loudly for a
// second reason: Claude Code treats a non-zero exit as a block, so a named-but-
// absent hook command would refuse every matching tool call.
function hookStatus() {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '.claude', 'hooks');
  const settingsPath = path.join(__dirname, '.claude', 'settings.json');

  let wired = [];
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    wired = (raw.hooks?.PreToolUse || []).flatMap(entry =>
      (entry.hooks || [])
        .map(h => String(h.command || '').split('/').pop())
        .filter(Boolean)
        .map(name => ({ name, matcher: entry.matcher || '(any)' }))
    );
  } catch {
    return { error: `could not read .claude/settings.json — no hook is enforced: ${settingsPath}` };
  }

  const report = {};
  const problems = [];
  for (const { name, matcher } of wired) {
    const file = path.join(dir, name);
    let state;
    if (!fs.existsSync(file)) {
      state = 'MISSING — settings.json names it, so every matching tool call will be refused';
      problems.push(`${name} is named in settings.json but not present in .claude/hooks/`);
    } else {
      // eslint-disable-next-line no-bitwise
      const executable = (fs.statSync(file).mode & 0o111) !== 0;
      state = executable ? `on (${matcher})` : 'NOT EXECUTABLE — chmod +x it, or it cannot run';
      if (!executable) problems.push(`${name} is not executable: chmod +x .claude/hooks/${name}`);
    }
    report[name] = state;
  }
  if (!wired.length) problems.push('settings.json wires no PreToolUse hook — nothing is enforced');
  return { ...report, ...(problems.length ? { problems } : {}) };
}

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
      ...(before.scrapers ? [] : [require('path').relative(__dirname, require('./db').DB_PATH)]),
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
    enforcedRules: hookStatus(),
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
