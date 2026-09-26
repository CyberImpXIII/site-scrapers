// Recipe versioning (see README.md "Recipe versions"). The point of this
// feature is troubleshooting: when a site changes and a recipe breaks, you
// want to see what the recipe looked like when it last worked, iterate
// freely, then keep only the version that ended up good. These tests pin the
// semantics that make that workflow safe:
//
//   - re-registering an UNCHANGED recipe records nothing (no history spam)
//   - a real edit records a MINOR bump
//   - promote() blesses the current version and opens the next MAJOR
//   - pruning discards scaffolding minors but never a stable version
//   - a run stays attributable to a version even after that version is pruned
//
// Run via `npm test` / `./test.sh`.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  openDb,
  upsertSite,
  insertField,
  logRun,
  snapshotVersionIfChanged,
  promoteVersion,
  getCurrentVersion,
  getLastStableVersion,
  listVersions,
  getVersion,
  pruneVersions,
  recipeDefinition,
  restoreVersion,
  deleteSite,
} = require('../db');

const HOSTNAME = '127.0.0.1';
const RECIPE_NAME = 'versioning_fixture_test';

let db;
let siteId;

// Registers the recipe the way register.js does — upsert, re-insert fields,
// THEN snapshot — so these tests exercise the real ordering. (Snapshotting
// inside upsertSite would capture a fieldless recipe, since upsert clears
// fields for the caller to re-insert.)
function register({ status = 'working', notes = 'Test-only fixture recipe for test/versioning.test.js. Safe to delete if found stray.', fields = [{ field_name: 'title', extract_kind: 'positional_segment', segment_index: 1 }] } = {}) {
  siteId = upsertSite(db, {
    hostname: HOSTNAME,
    page_type: 'listing',
    recipe_name: RECIPE_NAME,
    status,
    nav_method: 'url_param',
    nav_template: 'http://127.0.0.1:9/?q={{query}}',
    card_anchor_text: 'View job',
    notes,
  });
  fields.forEach((f, i) => insertField(db, siteId, f, i));
  return snapshotVersionIfChanged(db, siteId);
}

test.before(() => {
  db = openDb();
  // A previous aborted run could have left the fixture behind; versioning is
  // cumulative, so start from a clean slate or the counts below drift.
  const stray = db.prepare('SELECT id FROM sites WHERE hostname = ? AND recipe_name = ?').get(HOSTNAME, RECIPE_NAME);
  if (stray) deleteSite(db, stray.id);
});

test.after(() => {
  deleteSite(db, siteId);
});

test('first registration opens v1.0', () => {
  const v = register();
  assert.equal(v.major, 1);
  assert.equal(v.minor, 0);
  assert.equal(v.stable, 0, 'a brand-new version is not stable until promoted');
});

test('re-registering an unchanged recipe records no new version', () => {
  const before = listVersions(db, siteId).length;
  const v = register();
  assert.equal(listVersions(db, siteId).length, before, 'identical re-register should not create history');
  assert.equal(`${v.major}.${v.minor}`, '1.0');
});

test('a changed recipe records a minor bump', () => {
  const v = register({ notes: 'changed note — this is a real edit' });
  assert.equal(`${v.major}.${v.minor}`, '1.1');
  assert.equal(JSON.parse(v.definition).notes, 'changed note — this is a real edit');
});

test('a changed FIELD also counts as a change', () => {
  const v = register({
    notes: 'changed note — this is a real edit',
    fields: [
      { field_name: 'title', extract_kind: 'positional_segment', segment_index: 1 },
      { field_name: 'company', extract_kind: 'positional_segment', segment_index: 2 },
    ],
  });
  assert.equal(`${v.major}.${v.minor}`, '1.2', 'fields are part of the recipe definition, not bookkeeping');
  assert.equal(JSON.parse(v.definition).fields.length, 2);
});

test('a run is attributed to the version that produced it', () => {
  const current = getCurrentVersion(db, siteId);
  logRun(db, {
    siteId,
    params: {},
    success: false,
    error: 'simulated failure',
    versionId: current.id,
    versionLabel: `v${current.major}.${current.minor}`,
  });
  const run = db.prepare('SELECT * FROM scrape_runs WHERE site_id = ? ORDER BY id DESC LIMIT 1').get(siteId);
  assert.equal(run.version_id, current.id);
  assert.equal(run.version_label, 'v1.2');
});

test('promote publishes the blessed definition AS the next major', () => {
  const before = getCurrentVersion(db, siteId);
  assert.equal(`${before.major}.${before.minor}`, '1.2');

  const promoted = promoteVersion(db, siteId, { note: 'verified against the live site' });
  // The checkpoint lands ON the major, not on whatever minor happened to be
  // current. "vN.0" has to mean the blessed version or the number is a lie.
  assert.equal(`${promoted.major}.${promoted.minor}`, '2.0');
  assert.equal(promoted.stable, 1);
  assert.equal(promoted.note, 'verified against the live site');
  assert.equal(
    promoted.definition,
    before.definition,
    'promoting publishes what you had, so it is a checkpoint and not an edit'
  );

  // It is also now the head, so further edits continue at v2.1.
  const current = getCurrentVersion(db, siteId);
  assert.equal(current.id, promoted.id);
  assert.equal(getLastStableVersion(db, siteId).id, promoted.id);
});

test('promoting again with nothing changed is a no-op', () => {
  const stable = getLastStableVersion(db, siteId);
  const again = promoteVersion(db, siteId);
  assert.equal(again.id, stable.id, 'a second promote must not duplicate the checkpoint under a higher number');
  assert.equal(listVersions(db, siteId).filter(v => v.stable).length, 1);
});

test('pruning collects scaffolding but never a major version', () => {
  // Churn out more non-stable minors than the keep window.
  for (let i = 0; i < 8; i++) register({ notes: `scaffolding iteration ${i}` });

  const keep = 3;
  pruneVersions(db, siteId, keep);
  const versions = listVersions(db, siteId);
  const label = v => `v${v.major}.${v.minor}`;

  // Every vN.0 survives -- the promoted v2.0 because it is stable, and v1.0
  // because it is a major version even though it was never promoted.
  const majors = versions.filter(v => v.minor === 0).map(label);
  assert.deepEqual(majors, ['v1.0', 'v2.0'], 'no vN.0 may ever be collected');
  assert.equal(versions.find(v => label(v) === 'v2.0').stable, 1);

  const scaffolding = versions.filter(v => v.minor !== 0);
  assert.equal(scaffolding.length, keep, `expected the keep window to cap scaffolding at ${keep}`);

  // What survives is the most RECENT scaffolding, not an arbitrary subset.
  const newest = getCurrentVersion(db, siteId);
  assert.ok(
    versions.some(v => v.major === newest.major && v.minor === newest.minor),
    'the current version must always survive pruning'
  );
});

test('a pruned version leaves run history readable', () => {
  // The v1.2 run above pointed at a version that has since been superseded.
  // Whether or not its row survived, the run must still say what ran.
  const run = db
    .prepare("SELECT * FROM scrape_runs WHERE site_id = ? AND error = 'simulated failure' ORDER BY id DESC LIMIT 1")
    .get(siteId);
  assert.equal(run.version_label, 'v1.2', 'the label is denormalized precisely so pruning cannot erase it');
});

test('no amount of churn can drop a promoted version', () => {
  // The whole bargain of the major/minor split: scaffolding is disposable
  // precisely BECAUSE blessing a version makes it permanent. If pruning
  // could ever reach a stable version, iterating freely would stop being
  // safe. Several generations, heavy churn after the last promote.
  const churnName = 'versioning_churn_test';
  let churnId;
  const reg = note => {
    churnId = upsertSite(db, {
      hostname: HOSTNAME,
      page_type: 'listing',
      recipe_name: churnName,
      status: 'working',
      nav_method: 'url_param',
      nav_template: 'http://127.0.0.1:9/',
      card_anchor_text: 'x',
      notes: note,
    });
    insertField(db, churnId, { field_name: 'title', extract_kind: 'positional_segment', segment_index: 1 }, 0);
    return snapshotVersionIfChanged(db, churnId, { note });
  };

  try {
    const blessed = [];
    for (let gen = 1; gen <= 3; gen++) {
      for (let i = 0; i < 4; i++) reg(`gen${gen} iteration ${i}`);
      const p = promoteVersion(db, churnId, { note: `gen ${gen} blessed` });
      assert.equal(p.minor, 0, 'a promoted version is always a vN.0');
      blessed.push({ major: p.major, minor: p.minor, definition: p.definition });
    }
    // Far more non-stable versions than the keep window, after the last promote.
    for (let i = 0; i < 10; i++) reg(`heavy churn ${i}`);

    const surviving = listVersions(db, churnId);
    for (const b of blessed) {
      const found = surviving.find(v => v.major === b.major && v.minor === b.minor);
      assert.ok(found, `promoted v${b.major}.${b.minor} must survive arbitrary churn`);
      assert.equal(found.stable, 1);
      assert.equal(
        getVersion(db, churnId, b.major, b.minor).definition,
        b.definition,
        'a promoted definition must be preserved byte-for-byte, not just its row'
      );
    }
    assert.equal(surviving.filter(v => v.stable).length, 3, 'every generation keeps exactly its blessed version');
  } finally {
    deleteSite(db, churnId);
  }
});

test('restore puts an older definition back without erasing what it replaced', () => {
  const before = getCurrentVersion(db, siteId);
  const stable = getLastStableVersion(db, siteId);
  assert.notEqual(before.definition, stable.definition, 'precondition: the live recipe has drifted from stable');

  const restored = restoreVersion(db, siteId, stable.major, stable.minor);
  assert.equal(
    JSON.stringify(recipeDefinition(db, siteId)),
    stable.definition,
    'the live recipe should now be byte-identical to the version restored'
  );
  assert.ok(
    restored.major > before.major || restored.minor > before.minor,
    'a restore moves history forward rather than rewinding it, so the bad version stays inspectable'
  );
  assert.match(restored.note, /restored from v/);

  // The restored-over version is still there to look at.
  const versions = listVersions(db, siteId);
  assert.ok(
    versions.some(v => v.major === before.major && v.minor === before.minor),
    'restoring must not delete the version it replaced'
  );
});

test('restoring a version that does not exist is a no-op, not a wipe', () => {
  const snapshot = JSON.stringify(recipeDefinition(db, siteId));
  const result = restoreVersion(db, siteId, 99, 99);
  assert.equal(result, null);
  assert.equal(JSON.stringify(recipeDefinition(db, siteId)), snapshot, 'the live recipe must be untouched');
});

test('opening the DB does not manufacture versions, so readers never become writers', () => {
  // openDb() runs in every engine.js subprocess. The baseline backfill is a
  // one-time migration guarded by PRAGMA user_version; an earlier draft
  // instead re-checked "does any site lack a version", which stays true
  // forever the moment anything creates a site without one — turning every
  // open into a SQLite writer and making concurrent scrapes fail with empty
  // stdout. This pins the fix.
  const orphanName = 'versioning_orphan_test';
  const orphanId = upsertSite(db, {
    hostname: HOSTNAME,
    page_type: 'listing',
    recipe_name: orphanName,
    status: 'working',
    nav_method: 'url_param',
    nav_template: 'http://127.0.0.1:9/',
    card_anchor_text: 'x',
    notes: 'Test-only fixture for test/versioning.test.js. Safe to delete if found stray.',
  });
  try {
    assert.equal(listVersions(db, orphanId).length, 0, 'precondition: a bare upsert records no version');
    openDb().close();
    assert.equal(
      listVersions(db, orphanId).length,
      0,
      'openDb() must not create a version for a site that has none — versioning is register.js\'s job'
    );
  } finally {
    deleteSite(db, orphanId);
  }
});

test('recipeDefinition excludes bookkeeping columns', () => {
  const def = recipeDefinition(db, siteId);
  for (const excluded of ['id', 'site_id', 'first_seen', 'last_verified']) {
    assert.ok(!(excluded in def), `${excluded} must not be part of the comparable definition`);
  }
  assert.ok('hostname' in def && 'card_anchor_text' in def, 'behavioral columns must be included');
  assert.ok(Array.isArray(def.fields));
  for (const f of def.fields) {
    assert.ok(!('id' in f) && !('site_id' in f), 'field rows are compared by shape, not identity');
  }
});
