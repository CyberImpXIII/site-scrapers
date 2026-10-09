// The built-in generic_actions library lives in lib/builtinActions.js and is
// seeded into the DB on open. The property that actually matters: a FRESH
// clone (no DB, since data/scrapers.db is gitignored) still comes up with the
// library present. Before this split, the generic actions existed only in the
// untracked DB — invisible to git and lost with the file.
//
// Run via `npm test` / `./test.sh`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { BUILTIN_ACTIONS } = require('../lib/builtinActions');

const REPO_ROOT = path.join(__dirname, '..');

// Exercise a genuinely fresh DB by running a throwaway copy of the repo's db.js
// against a temp directory: copy the js files there and require db.js, so
// DB_PATH resolves to that dir's data/scrapers.db. The children get an env
// WITHOUT SS_DB, which test.sh sets: with it, the copy would open the suite's
// snapshot instead of the fresh file this test is about.
const FRESH_ENV = { ...process.env };
delete FRESH_ENV.SS_DB;
delete FRESH_ENV.SS_FAILURES_DB;
function withFreshDb(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-builtins-'));
  try {
    fs.mkdirSync(path.join(tmp, 'lib'), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, 'db.js'), path.join(tmp, 'db.js'));
    for (const f of ['builtinActions.js', 'writeGuard.js', 'fillContract.js', 'credentialShapes.js']) {
      fs.copyFileSync(path.join(REPO_ROOT, 'lib', f), path.join(tmp, 'lib', f));
    }
    return fn(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('a fresh DB is seeded with the built-in library from code', () => {
  withFreshDb(tmp => {
    const script = `
      const { openDb, listGenericActions } = require(${JSON.stringify(path.join(tmp, 'db.js'))});
      const db = openDb();
      process.stdout.write(JSON.stringify(listGenericActions(db).map(g => [g.name, g.source])));
    `;
    const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', env: FRESH_ENV });
    const rows = JSON.parse(out);
    assert.ok(fs.existsSync(path.join(tmp, 'data', 'scrapers.db')), 'a fresh DB file should have been created');
    assert.equal(rows.length, BUILTIN_ACTIONS.length, 'every builtin should be present in a fresh DB');
    for (const a of BUILTIN_ACTIONS) {
      const row = rows.find(([name]) => name === a.name);
      assert.ok(row, `builtin "${a.name}" missing from a fresh DB`);
      assert.equal(row[1], 'builtin', `"${a.name}" should be marked source=builtin`);
    }
  });
});

// The test above copies db.js WITHOUT lib/gate.js, so seeding skips validation
// there and every builtin lands. With the real gate present, validation
// resolves `run` references against the DB, and a builtin that runs one not
// yet seeded used to be rejected as an unknown ref on the first open of a fresh
// store (found 2026-10-05: detect_blockers_then_handoff and open_apply_form
// were absent until the second open). This runs the real repo's db.js against
// a private file (openDb(file)), never data/scrapers.db.
test('a fresh store opened ONCE holds every builtin, with the real gate validating', () => {
  const { openDb, listGenericActions } = require('../db');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-builtins-gate-'));
  const warnings = [];
  const onWarn = w => warnings.push(w.name);
  process.on('warning', onWarn);
  try {
    const db = openDb(path.join(tmp, 'fresh.db'));
    const names = new Set(listGenericActions(db).filter(g => g.source === 'builtin').map(g => g.name));
    db.close();
    const absent = BUILTIN_ACTIONS.map(a => a.name).filter(n => !names.has(n));
    assert.deepEqual(absent, [], 'builtins absent after one open of a fresh store');
  } finally {
    process.off('warning', onWarn);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  assert.ok(!warnings.includes('BuiltinActionRejected'), 'no builtin rejected on a fresh store');
});

test('re-seeding restores an edited builtin but leaves user actions alone', () => {
  withFreshDb(tmp => {
    const dbPath = JSON.stringify(path.join(tmp, 'db.js'));
    const target = BUILTIN_ACTIONS[0].name;

    // Tamper with a builtin and add a user action, then reopen.
    const mutate = `
      // Writes are guarded, and this subprocess is simulating a user
      // registering an action, so it authorizes itself the way a test does.
      require(${JSON.stringify(path.join(tmp, 'lib', 'writeGuard.js'))}).authorizeForTests('builtins test subprocess');
      const { openDb, upsertGenericAction } = require(${dbPath});
      const db = openDb();
      db.prepare('UPDATE generic_actions SET steps = ? WHERE name = ?').run('[{"action":"wait","ms":1}]', ${JSON.stringify(target)});
      upsertGenericAction(db, { name: 'user_made', description: 'mine', steps: '[{"action":"wait","ms":2}]' });
    `;
    execFileSync(process.execPath, ['-e', mutate], { encoding: 'utf8', env: FRESH_ENV });

    const check = `
      const { openDb, getGenericAction } = require(${dbPath});
      const db = openDb();
      const b = getGenericAction(db, ${JSON.stringify(target)});
      const u = getGenericAction(db, 'user_made');
      process.stdout.write(JSON.stringify({ builtinSteps: b.steps, builtinSource: b.source, user: u && { steps: u.steps, source: u.source } }));
    `;
    const res = JSON.parse(execFileSync(process.execPath, ['-e', check], { encoding: 'utf8', env: FRESH_ENV }));

    assert.equal(
      res.builtinSteps,
      JSON.stringify(BUILTIN_ACTIONS[0].steps),
      'an edited builtin should be restored from code on the next open'
    );
    assert.equal(res.builtinSource, 'builtin');
    assert.ok(res.user, 'a user-registered action must survive re-seeding');
    assert.equal(res.user.steps, '[{"action":"wait","ms":2}]', 'user action content must be untouched');
    assert.equal(res.user.source, 'user');
  });
});

test('every builtin has the shape the engine needs', () => {
  for (const a of BUILTIN_ACTIONS) {
    assert.ok(a.name && typeof a.name === 'string', 'builtin needs a name');
    assert.ok(a.description && a.description.length > 40, `${a.name} needs a real description`);
    assert.ok(Array.isArray(a.steps) && a.steps.length > 0, `${a.name} needs steps`);
    for (const s of a.steps) assert.ok(s.action, `${a.name} has a step with no action`);
  }
});
