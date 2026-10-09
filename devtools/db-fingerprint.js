// What a test run could leave in the LIVE stores, as one JSON line.
//
//   node devtools/db-fingerprint.js              -> the fingerprint
//   node devtools/db-fingerprint.js --diff A B   -> what differs between two
//                                                   saved fingerprints; exit 1 if any
//
// test.sh takes one before the suite and one after, and fails the run when
// they differ: the suite runs on copies (SS_DB, SS_FAILURES_DB), so a change to
// the live files means some path still opens them (TODO 0k, where the suite
// was found writing 127.0.0.1 fixtures into the live recipe store).
//
// Always the LIVE paths (db.js LIVE_DB_PATH), whatever SS_DB says. Opened
// read-only, so taking a fingerprint writes nothing.
//
// What it compares, chosen to ignore real work other sessions may do while the
// suite runs (a scrape logging a run is not a leak):
//   - sqlite_sequence, every table except scrape_runs: the highest id ever
//     handed out, so a fixture inserted and deleted again still moves it;
//   - the fixture-host rows (lib/fixtureHosts.js) of sites, hashed whole, and
//     the scrape_runs on them, counted;
//   - the failures store's sqlite_sequence.

const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { LIVE_DB_PATH } = require('../db');
const { LIVE_FAILURES_DB_PATH } = require('../failuresDb');
const { isFixtureHost } = require('../lib/fixtureHosts');

function open(file) {
  if (!fs.existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 10000');
  return db;
}

function sequences(db, skip = []) {
  const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'").get();
  if (!has) return {};
  const out = {};
  for (const r of db.prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name').all()) {
    if (!skip.includes(r.name)) out[r.name] = r.seq;
  }
  return out;
}

function fingerprint() {
  const fp = { scrapers: null, failures: null };
  const db = open(LIVE_DB_PATH);
  if (db) {
    try {
      const fixtures = db.prepare('SELECT * FROM sites ORDER BY id').all().filter(s => isFixtureHost(s.hostname));
      const ids = fixtures.map(s => s.id);
      const runs = ids.length
        ? db.prepare(`SELECT COUNT(*) AS n FROM scrape_runs WHERE site_id IN (${ids.map(() => '?').join(',')})`).get(...ids).n
        : 0;
      fp.scrapers = {
        seq: sequences(db, ['scrape_runs']),
        fixtureSites: fixtures.length,
        fixtureSitesHash: crypto.createHash('sha256').update(JSON.stringify(fixtures)).digest('hex').slice(0, 16),
        fixtureRuns: runs,
      };
    } finally {
      db.close();
    }
  }
  const fdb = open(LIVE_FAILURES_DB_PATH);
  if (fdb) {
    try {
      fp.failures = { seq: sequences(fdb) };
    } finally {
      fdb.close();
    }
  }
  return fp;
}

// Flat "path: before -> after" lines for every leaf that differs.
function diff(a, b, at = '') {
  const out = [];
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of [...keys].sort()) {
    const x = a ? a[k] : undefined;
    const y = b ? b[k] : undefined;
    const p = at ? `${at}.${k}` : k;
    if (x && y && typeof x === 'object' && typeof y === 'object') out.push(...diff(x, y, p));
    else if (JSON.stringify(x) !== JSON.stringify(y)) out.push(`${p}: ${JSON.stringify(x ?? null)} -> ${JSON.stringify(y ?? null)}`);
  }
  return out;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv[0] === '--diff') {
    const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
    const lines = diff(read(argv[1]), read(argv[2]));
    for (const l of lines) process.stdout.write(l + '\n');
    process.exitCode = lines.length ? 1 : 0;
  } else {
    process.stdout.write(JSON.stringify(fingerprint()) + '\n');
  }
}

module.exports = { fingerprint, diff };
