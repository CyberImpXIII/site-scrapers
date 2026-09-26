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

// db.js hardcodes its path, so exercise a genuinely fresh DB by running a
// throwaway copy of the repo's db.js against a temp HOME-like directory.
// Simplest faithful approach: copy the repo's js files into a temp dir and
// require db.js there, so DB_PATH resolves to that dir's data/scrapers.db.
function withFreshDb(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-builtins-'));
  try {
    fs.mkdirSync(path.join(tmp, 'lib'), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, 'db.js'), path.join(tmp, 'db.js'));
    for (const f of ['builtinActions.js']) {
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
    const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
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

test('re-seeding restores an edited builtin but leaves user actions alone', () => {
  withFreshDb(tmp => {
    const dbPath = JSON.stringify(path.join(tmp, 'db.js'));
    const target = BUILTIN_ACTIONS[0].name;

    // Tamper with a builtin and add a user action, then reopen.
    const mutate = `
      const { openDb, upsertGenericAction } = require(${dbPath});
      const db = openDb();
      db.prepare('UPDATE generic_actions SET steps = ? WHERE name = ?').run('[{"action":"wait","ms":1}]', ${JSON.stringify(target)});
      upsertGenericAction(db, { name: 'user_made', description: 'mine', steps: '[{"action":"wait","ms":2}]' });
    `;
    execFileSync(process.execPath, ['-e', mutate], { encoding: 'utf8' });

    const check = `
      const { openDb, getGenericAction } = require(${dbPath});
      const db = openDb();
      const b = getGenericAction(db, ${JSON.stringify(target)});
      const u = getGenericAction(db, 'user_made');
      process.stdout.write(JSON.stringify({ builtinSteps: b.steps, builtinSource: b.source, user: u && { steps: u.steps, source: u.source } }));
    `;
    const res = JSON.parse(execFileSync(process.execPath, ['-e', check], { encoding: 'utf8' }));

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
