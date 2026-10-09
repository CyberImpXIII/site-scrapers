// Copies the live stores into a folder, for a test run that must not touch them.
//
//   node devtools/snapshot-stores.js <dir>
//
// Prints {"SS_DB": "<dir>/recipes.sqlite", "SS_FAILURES_DB": "<dir>/failures.sqlite"}
// (a store that does not exist yet is left out: openDb creates and seeds a
// fresh one at the override path). test.sh exports both, so the suite and
// every engine/verify/lab child it spawns open the copies (db.js DB_PATH,
// failuresDb.js FAILURES_DB_PATH read them at load). TODO 0k.
//
// It copies the store the CALLER is pointed at (DB_PATH, which honours SS_DB),
// not always the live one: test.sh run from inside a suite (lib/gate.js, via
// register.js under test) then copies the suite's copy, never the live file.
//
// The copy is SQLite's own (`VACUUM INTO` on a read-only connection), not a
// file copy: the live DB is in WAL mode and another process may be writing,
// so copying the main file and its -wal separately could tear. The source is
// opened read-only; nothing in it changes.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { DB_PATH } = require('../db');
const { FAILURES_DB_PATH } = require('../failuresDb');

function snapshot(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const out = {};
  for (const [env, live, name] of [
    ['SS_DB', DB_PATH, 'recipes.sqlite'],
    ['SS_FAILURES_DB', FAILURES_DB_PATH, 'failures.sqlite'],
  ]) {
    if (!fs.existsSync(live)) continue;
    const dest = path.join(dir, name);
    if (fs.existsSync(dest)) fs.rmSync(dest);
    const src = new DatabaseSync(live, { readOnly: true });
    try {
      src.exec('PRAGMA busy_timeout = 10000');
      src.prepare('VACUUM INTO ?').run(dest);
    } finally {
      src.close();
    }
    out[env] = dest;
  }
  return out;
}

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) {
    process.stderr.write('usage: node devtools/snapshot-stores.js <dir>\n');
    process.exit(2);
  }
  process.stdout.write(JSON.stringify(snapshot(path.resolve(dir))) + '\n');
}

module.exports = { snapshot };
