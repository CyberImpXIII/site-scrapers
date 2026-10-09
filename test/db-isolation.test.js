// The suite runs on throwaway copies of the stores, never the live files
// (TODO 0k: tests were found writing 127.0.0.1 fixtures into data/scrapers.db).
//
// Three layers, each checked here:
//   1. db.js / failuresDb.js read SS_DB / SS_FAILURES_DB at load (this file);
//   2. test.sh sets both to a fresh snapshot (devtools/snapshot-stores.js), so
//      every test file and every child it spawns inherits them (this file
//      fails when run outside test.sh, saying so);
//   3. test.sh fingerprints the LIVE stores before and after the suite
//      (devtools/db-fingerprint.js) and fails the run on any difference --
//      the "live DB is unchanged" check, over the whole suite rather than one
//      file. Its wiring is asserted at the end of this file.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const dbApi = require('../db');
const failuresApi = require('../failuresDb');

const REPO = path.join(__dirname, '..');
const CHILD = path.join(__dirname, 'fixtures', 'isolation-child.js');

test('this suite is pointed at copies, not the live stores (run it through ./test.sh)', () => {
  assert.ok(process.env.SS_DB, 'SS_DB is unset: this suite would write the live data/scrapers.db. Run ./test.sh (or ./dev.sh test), which points it at a snapshot');
  assert.ok(process.env.SS_FAILURES_DB, 'SS_FAILURES_DB is unset: failures tests would write the live data/failures.db');
  assert.notEqual(dbApi.DB_PATH, dbApi.LIVE_DB_PATH);
  assert.notEqual(failuresApi.FAILURES_DB_PATH, failuresApi.LIVE_FAILURES_DB_PATH);
  assert.equal(dbApi.DB_PATH, path.resolve(process.env.SS_DB));
  assert.equal(failuresApi.FAILURES_DB_PATH, path.resolve(process.env.SS_FAILURES_DB));
});

test('a child process writes where SS_DB points, and the live store does not get the row', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-isolation-'));
  const host = `isolation-${process.pid}-${Date.now()}.test`;
  try {
    const env = { ...process.env, SS_DB: path.join(tmp, 's.db'), SS_FAILURES_DB: path.join(tmp, 'f.db') };
    const out = JSON.parse(execFileSync(process.execPath, [CHILD, host], { env, encoding: 'utf8' }));
    assert.equal(out.DB_PATH, env.SS_DB);
    assert.equal(out.FAILURES_DB_PATH, env.SS_FAILURES_DB);
    assert.equal(out.written, true);
    assert.ok(fs.existsSync(env.SS_FAILURES_DB), 'the failures store was created at the override path');

    const copy = new DatabaseSync(env.SS_DB, { readOnly: true });
    assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM sites WHERE hostname = ?').get(host).n, 1);
    copy.close();
    if (fs.existsSync(dbApi.LIVE_DB_PATH)) {
      const live = new DatabaseSync(dbApi.LIVE_DB_PATH, { readOnly: true });
      assert.equal(live.prepare('SELECT COUNT(*) AS n FROM sites WHERE hostname = ?').get(host).n, 0, 'the row leaked into the live store');
      live.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('without SS_DB the default is the live path (the override is opt-in)', () => {
  const env = { ...process.env };
  delete env.SS_DB;
  delete env.SS_FAILURES_DB;
  // Resolve only; nothing opened, so nothing written.
  const probe = path.join(__dirname, 'fixtures', 'resolve-paths.js');
  const out = JSON.parse(execFileSync(process.execPath, [probe], { env, encoding: 'utf8' }));
  assert.equal(out.DB_PATH, path.join(REPO, 'data', 'scrapers.db'));
  assert.equal(out.FAILURES_DB_PATH, path.join(REPO, 'data', 'failures.db'));
});

test("the gate counts test.sh's live-store failure, which comes after node's `# fail 0`", () => {
  const { parseTap } = require('../lib/gate');
  const out = [
    'ok 1 - fine',
    '# pass 1',
    '# fail 0',
    'not ok 0 - the LIVE store changed during the suite (devtools/db-fingerprint.js; rerun if another session was writing it)',
    '  # scrapers.seq.sites: 10 -> 11',
  ].join('\n');
  const p = parseTap(out);
  assert.equal(p.failed, 1, 'a gate reading only `# fail` would wave the leak through');
  assert.match(p.failures[0], /LIVE store changed/);
});

test('failure details skip the subtest wrapper and keep the child error', () => {
  const { parseTap } = require('../lib/gate');
  const out = [
    '# Subtest: group',
    '    not ok 1 - child',
    '      ---',
    "      location: '/x/a.test.js:7:3'",
    '      error: |-',
    '        Expected values to be strictly equal:',
    '        1 !== 2',
    "      code: 'ERR_ASSERTION'",
    '      ...',
    'not ok 1 - group',
    '  ---',
    "  location: '/x/a.test.js:5:1'",
    "  failureType: 'subtestsFailed'",
    "  error: '1 subtest failed'",
    '  ...',
    '# pass 0',
    '# fail 1',
  ].join('\n');
  const p = parseTap(out);
  assert.equal(p.failed, 1);
  assert.deepEqual(p.failureDetails, [
    { name: 'child', error: 'Expected values to be strictly equal:\n1 !== 2', location: '/x/a.test.js:7:3' },
  ]);
});

test('test.sh snapshots the stores, fingerprints the live ones around the run, and fails on a difference', () => {
  const src = fs.readFileSync(path.join(REPO, 'test.sh'), 'utf8');
  assert.match(src, /devtools\/snapshot-stores\.js/);
  assert.match(src, /export SS_DB/);
  assert.match(src, /export SS_FAILURES_DB/);
  assert.match(src, /devtools\/db-fingerprint\.js/);
  assert.match(src, /db-fingerprint\.js" --diff/);
});
