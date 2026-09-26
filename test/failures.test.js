// The failure knowledge base (failuresDb.js, failures.js). Its whole value
// is answering "have we seen this before?", which depends on two things:
// a CLOSED taxonomy, so two descriptions of one problem land on one label,
// and identity that tolerates cosmetic variation in error text.
//
// Run via `npm test` / `./test.sh`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const {
  openFailuresDb,
  recordFailure,
  listFailures,
  commonFailures,
  matchFailures,
  listFailureTypes,
  deleteFailure,
} = require('../failuresDb');
const { FAILURE_TYPES } = require('../lib/failureTypes');

const REPO_ROOT = path.join(__dirname, '..');
const MARK = 'failures_test_marker';
let db;
const created = [];

function record(f) {
  const r = recordFailure(db, { symptom: MARK, ...f });
  if (!created.includes(r.id)) created.push(r.id);
  return r;
}

test.before(() => {
  db = openFailuresDb();
});

test.after(() => {
  for (const id of created) deleteFailure(db, id);
});

test('the taxonomy is seeded from code, so a fresh clone has the vocabulary', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-failures-'));
  try {
    fs.mkdirSync(path.join(tmp, 'lib'), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, 'failuresDb.js'), path.join(tmp, 'failuresDb.js'));
    fs.copyFileSync(path.join(REPO_ROOT, 'lib', 'failureTypes.js'), path.join(tmp, 'lib', 'failureTypes.js'));
    const { openFailuresDb: openFresh, listFailureTypes: listFresh } = require(path.join(tmp, 'failuresDb.js'));
    const fresh = openFresh();
    const names = listFresh(fresh).map(t => t.name);
    assert.equal(names.length, FAILURE_TYPES.length);
    for (const [name] of FAILURE_TYPES) assert.ok(names.includes(name), `${name} missing from a fresh DB`);
    assert.equal(listFailures(fresh).length, 0, 'a fresh DB has vocabulary but no history');
    fresh.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the taxonomy stays small enough to actually match against', () => {
  // Not a style rule: a vocabulary large enough to hold near-duplicates
  // stops being able to answer "is this the same failure?".
  assert.ok(listFailureTypes(db).length <= 20, 'if this trips, consolidate rather than raising the bound');
});

test('the same failure recorded twice counts twice instead of duplicating', () => {
  const base = {
    failure_type: 'slow_render',
    hostname: 'failtest.example',
    page_type: 'listing',
    recipe_name: 'default',
    step_action: 'waitForSelector',
    step_selector: '.card',
  };
  const first = record({ ...base, symptom: `${MARK} timed out at 8000ms` });
  assert.equal(first.recorded, 'new');

  // Cosmetically different symptom text, plainly the same problem. Symptom
  // is excluded from identity precisely so this doesn't fragment.
  const second = record({ ...base, symptom: `${MARK} timed out at 30000ms` });
  assert.equal(second.recorded, 'repeat');
  assert.equal(second.id, first.id);
  assert.equal(second.occurrences, 2);

  // A genuinely different selector IS a different failure.
  const other = record({ ...base, step_selector: '.different-card' });
  assert.equal(other.recorded, 'new');
  assert.notEqual(other.id, first.id);
});

test('a later recording fills in a diagnosis without erasing what is there', () => {
  const base = {
    failure_type: 'empty_result',
    hostname: 'failtest-fill.example',
    step_action: 'collect',
  };
  record({ ...base, resolution: 'the original fix' });
  record({ ...base, diagnosis: 'worked out later' });

  const [row] = listFailures(db, { hostname: 'failtest-fill.example' });
  assert.equal(row.diagnosis, 'worked out later', 'a missing field gets filled in');
  assert.equal(row.resolution, 'the original fix', 'an existing field is not clobbered by a later blank');
});

test('matching surfaces a fix from a DIFFERENT site when the pattern transfers', () => {
  record({
    failure_type: 'consent_overlay',
    hostname: 'failtest-eu.example',
    step_action: 'collect',
    symptom: `${MARK} zero results, consent dialog covering the list`,
    resolution: 'composed dismiss_overlay before collect',
  });

  const hits = matchFailures(db, {
    hostname: 'never-seen-before.example',
    failure_type: 'consent_overlay',
    step_action: 'collect',
    symptom: 'zero results, a consent dialog is covering the list',
  });

  const hit = hits.find(h => h.hostname === 'failtest-eu.example');
  assert.ok(hit, 'a same-shape failure on another site is the most useful hit there is');
  assert.ok(hit.resolution.includes('dismiss_overlay'));
  assert.ok(hit.why.includes('same failure type'));
});

test('matching does not return unrelated records', () => {
  record({ failure_type: 'bot_block', hostname: 'failtest-bot.example', symptom: `${MARK} challenge page` });
  const hits = matchFailures(db, {
    hostname: 'unrelated.example',
    failure_type: 'pagination_broken',
    symptom: 'next button does nothing',
  });
  assert.ok(
    !hits.some(h => h.hostname === 'failtest-bot.example'),
    'a low-signal match is worse than none -- it sends you down the wrong path'
  );
});

test('common counts occurrences, not rows', () => {
  const rows = commonFailures(db, 20);
  const slow = rows.find(r => r.failure_type === 'slow_render');
  assert.ok(slow, 'expected the recorded slow_render entries to show up');
  assert.ok(slow.total >= slow.distinct_cases, 'total sums occurrences across cases');
});

test('the CLI refuses a failure type outside the taxonomy', async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ['failures.js', 'record', JSON.stringify({ failure_type: 'cookie_wall', symptom: 'x' })],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  ).catch(e => ({ stdout: e.stdout }));
  const out = JSON.parse(stdout);
  assert.equal(out.success, false);
  assert.match(out.error, /not in the failure taxonomy/);
  assert.match(out.error, /new_failure_type_description/, 'the escape hatch must be discoverable');
});

test('the CLI accepts a deliberately new type via the escape hatch', async () => {
  const payload = {
    failure_type: 'failtest_novel_type',
    symptom: `${MARK} a genuinely new shape`,
    hostname: 'failtest-novel.example',
    new_failure_type_description: 'Test-only type registered by test/failures.test.js.',
  };
  const { stdout } = await execFileAsync(
    process.execPath,
    ['failures.js', 'record', JSON.stringify(payload)],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  );
  const out = JSON.parse(stdout);
  assert.equal(out.success, true);

  // A type cannot be removed while a failure still references it -- the FK
  // is enforced, which is the taxonomy protecting itself. So the record
  // goes first, and neither is left to the shared teardown.
  assert.throws(
    () => db.prepare('DELETE FROM failure_types WHERE name = ?').run('failtest_novel_type'),
    /FOREIGN KEY/,
    'a type in use must not be removable out from under its failures'
  );
  deleteFailure(db, out.id);
  db.prepare('DELETE FROM failure_types WHERE name = ?').run('failtest_novel_type');
});
