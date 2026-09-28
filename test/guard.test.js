// The write guard (lib/writeGuard.js) and the validation gate (lib/gate.js).
//
// These exist because detecting off-path edits after the fact was not enough —
// the edits still landed, unaudited, and the record of them was a warning
// someone had to go looking for. Writes are now refused outright unless they
// come through a sanctioned path.
//
// The concrete history: a recipe got status "blocked" by hand through a path
// that had no gate, and a status was set that register.js would have refused.
// Both were inline `node -e` calling db.js's own mutators because it was quick.
//
// Run via `npm test` / `./test.sh`.

const test = require('node:test');
const assert = require('node:assert/strict');
const { authorize, authorizeAsync, assertAuthorized, currentAuthorization } = require('../lib/writeGuard');

// --- The guard -------------------------------------------------------------

test('an unauthorized write is refused', () => {
  assert.throws(() => assertAuthorized('upsertSite'), /guarded write/);
});

test('the refusal names the sanctioned paths, not just the problem', () => {
  // An error that says "denied" and stops there gets worked around. This one
  // has to say what to do instead.
  try {
    assertAuthorized('upsertSite');
    assert.fail('should have thrown');
  } catch (e) {
    assert.match(e.message, /lab\.js set/, 'the gated path for recipe edits');
    assert.match(e.message, /register\.js/, 'the path for new recipes');
    assert.match(e.message, /verify\.js/, 'the path for an earned status');
    assert.match(e.message, /authorizeForTests/, 'what a test should do');
    assert.match(e.message, /raw SQL|node -e/, 'the specific thing not to do');
  }
});

test('a write inside authorize() is allowed, and only inside', () => {
  authorize('unit test', () => assertAuthorized('upsertSite'));
  // Authorization must not leak past the scope, or the first sanctioned write
  // in a process would open every later one.
  assert.throws(() => assertAuthorized('upsertSite'), /guarded write/);
});

test('authorization is cleared even when the mutation throws', () => {
  assert.throws(
    () =>
      authorize('failing mutation', () => {
        throw new Error('boom');
      }),
    /boom/
  );
  assert.throws(() => assertAuthorized('upsertSite'), /guarded write/, 'a thrown mutation must not leave writes open');
});

test('nesting is allowed and the outermost scope owns the lifetime', () => {
  authorize('outer', () => {
    authorize('inner', () => assertAuthorized('insertField'));
    // Still authorized: the inner scope exiting must not close the outer one,
    // or a gated change that calls a helper internally would break halfway.
    assertAuthorized('insertField');
  });
  assert.throws(() => assertAuthorized('insertField'), /guarded write/);
});

test('authorize records a reason, because an unexplained write is the problem', () => {
  assert.throws(() => authorize('', () => {}), /needs a reason/);
  authorize('a stated reason', () => {
    assert.equal(currentAuthorization().reason, 'a stated reason');
  });
  assert.equal(currentAuthorization(), null, 'no reason outstanding once the scope closes');
});

test('the async form behaves the same way', async () => {
  await authorizeAsync('async unit test', async () => {
    assertAuthorized('promoteVersion');
  });
  assert.throws(() => assertAuthorized('promoteVersion'), /guarded write/);

  await assert.rejects(
    authorizeAsync('async failure', async () => {
      throw new Error('async boom');
    }),
    /async boom/
  );
  assert.throws(() => assertAuthorized('promoteVersion'), /guarded write/, 'a rejected promise must not leave writes open');
});

// --- Which operations are guarded -----------------------------------------

test('every definition-mutating db.js export is guarded', () => {
  const db = require('../db');
  const mustBeGuarded = [
    'upsertSite',
    'insertField',
    'deleteSite',
    'promoteVersion',
    'restoreVersion',
    'snapshotVersionIfChanged',
    'insertActionType',
    'upsertGenericAction',
  ];
  for (const name of mustBeGuarded) {
    assert.equal(typeof db[name], 'function', `${name} should exist`);
    assert.throws(
      () => db[name]({ prepare: () => ({ run: () => {}, get: () => null, all: () => [] }) }, {}),
      /guarded write/,
      `${name} must refuse an unauthorized call before touching the database`
    );
  }
});

test('logRun is deliberately NOT guarded', () => {
  // It is append-only telemetry written by every scrape, not a change to a
  // definition. Guarding it would mean every run needed a stated reason.
  const { logRun } = require('../db');
  const fake = { prepare: () => ({ run: () => {} }) };
  assert.doesNotThrow(() => logRun(fake, { siteId: 1, success: true }));
});

// --- The gate module loads -------------------------------------------------
// Added after a backtick inside a SQL comment broke lib/gate.js's template
// literal and 130 passing tests did not notice, because nothing required the
// file. A module with no test at all is a module that can be syntactically
// broken and still ship green.

test('lib/gate.js loads and exposes its interface', () => {
  const gate = require('../lib/gate');
  for (const fn of ['guardedChange', 'offlineFindings', 'unitTests', 'ensureChangeLog']) {
    assert.equal(typeof gate[fn], 'function', `${fn} should be exported`);
  }
  assert.match(gate.CHANGE_LOG_TABLE_SQL, /CREATE TABLE IF NOT EXISTS change_log/);
});

test('every CLI and library module parses', () => {
  // The cheapest possible guard against the class above: requiring a file
  // proves it at least compiles. CLIs are excluded where requiring them would
  // execute their main(); those run under `require.main === module`.
  for (const mod of [
    '../db',
    '../failuresDb',
    '../audit',
    '../lib/gate',
    '../lib/writeGuard',
    '../lib/verdict',
    '../lib/probes',
    '../lib/composeActions',
    '../lib/builtinActions',
    '../lib/blockerSignatures',
    '../lib/failureTypes',
    '../lib/debug',
    '../lib/runner',
    '../lib/sessions',
  ]) {
    assert.doesNotThrow(() => require(mod), `${mod} should load`);
  }
});

test('a guarded change rejects a regression and rolls it back', () => {
  // End-to-end through the real gate, on a throwaway recipe: apply a change
  // that introduces a known audit finding and confirm it does not survive.
  const { authorizeForTests } = require('../lib/writeGuard');
  authorizeForTests('guard test fixture');
  const { openDb, upsertSite, insertField, getSite, deleteSite, snapshotVersionIfChanged } = require('../db');
  const { guardedChange } = require('../lib/gate');
  const db = openDb();

  const stray = getSite(db, 'gatetest.test', 'listing', 'default');
  if (stray) deleteSite(db, stray.id);
  const id = upsertSite(db, {
    hostname: 'gatetest.test',
    page_type: 'listing',
    recipe_name: 'default',
    status: 'needs-review',
    nav_method: 'url_param',
    nav_template: 'https://gatetest.test/jobs',
    card_selector: 'li.job',
    notes: 'Test-only fixture for test/guard.test.js. Safe to delete if found stray.',
  });
  insertField(db, id, { field_name: 'title', extract_kind: 'positional_segment', segment_index: 0 }, 0);
  snapshotVersionIfChanged(db, id, { note: 'baseline' });

  try {
    const result = guardedChange(db, {
      target: 'gatetest.test#listing:default',
      summary: 'introduce a descendant :has(), which the units audit flags',
      scope: 'recipe',
      siteId: id,
      mutate: () => {
        db.prepare('UPDATE sites SET card_selector = ? WHERE id = ?').run('div:has(a[href])', id);
        snapshotVersionIfChanged(db, id, { note: 'bad selector' });
      },
    });

    assert.equal(result.ok, false, 'a change introducing a finding must not pass');
    assert.ok(result.introducedFindings.length > 0);
    assert.match(result.introducedFindings.join(' '), /descendant :has\(\)/);
    assert.equal(result.rolledBack, true);
    assert.equal(
      getSite(db, 'gatetest.test', 'listing', 'default').card_selector,
      'li.job',
      'the rollback must restore the definition, not just report a failure'
    );
  } finally {
    deleteSite(db, id);
  }
});

// --- Referenced actions are part of a change's scope ----------------------
// A composed recipe is not self-contained: most of what it runs lives in the
// actions it references. Validating the recipe without them is partial, and a
// failure inside a referenced action is the hardest kind to attribute — it
// happens in code the recipe did not write.

test('referenced actions are found at any depth, including inside a repeat', () => {
  const { referencedActions } = require('../lib/gate');
  const refs = referencedActions([
    { action: 'goto', url: 'x' },
    { action: 'run_generic_action', ref: 'dismiss_overlay' },
    { action: 'repeat', times: 1, steps: [{ action: 'run_generic_action', ref: 'describe_form' }] },
    { action: 'run_action', ref: 'other.com#action:login' },
  ]);
  assert.deepEqual(refs.generic.sort(), ['describe_form', 'dismiss_overlay']);
  assert.deepEqual(refs.site, ['other.com#action:login']);
});

test('a step list referencing nothing yields no scope', () => {
  const { referencedActions } = require('../lib/gate');
  assert.deepEqual(referencedActions([{ action: 'goto', url: 'x' }]), { generic: [], site: [] });
  assert.deepEqual(referencedActions(null), { generic: [], site: [] });
});

test('a reference to a non-existent action is an error, not a warning', () => {
  const { validateReferencedActions } = require('../lib/gate');
  const { openDb } = require('../db');
  const findings = validateReferencedActions(openDb(), { generic: ['definitely_not_an_action'], site: [] }, 'x.test');
  assert.equal(findings.length, 1);
  assert.match(findings[0], /^error\|generic:definitely_not_an_action\|referenced but does not exist/);
});

test('a healthy referenced action produces no findings', () => {
  const { validateReferencedActions } = require('../lib/gate');
  const { openDb } = require('../db');
  assert.deepEqual(
    validateReferencedActions(openDb(), { generic: ['dismiss_overlay', 'describe_form'], site: [] }, 'x.test'),
    [],
    'the builtin library must be clean, or every gated change inherits its findings'
  );
});

test('the suites covering a referenced action are discovered by name, not a map', () => {
  // A hand-maintained map would drift the moment a test was renamed, and then
  // this would quietly run nothing.
  const { testFilesFor } = require('../lib/gate');
  const files = testFilesFor({ generic: ['dismiss_overlay'], site: [] }).map(f => f.split('/').pop());
  assert.ok(files.includes('compose.test.js'), 'composition always applies to a reference');
  assert.ok(files.includes('builtins.test.js'), 'so does seeding');
  assert.ok(files.includes('steps.test.js'), 'and the suite that actually exercises dismiss_overlay');
});

test('with no references, only the machinery suites are selected', () => {
  const { testFilesFor } = require('../lib/gate');
  const files = testFilesFor({ generic: [], site: [] }).map(f => f.split('/').pop()).sort();
  assert.deepEqual(files, ['builtins.test.js', 'compose.test.js']);
});

// --- Generic actions are validated in both directions ---------------------
// A generic action is library code: changing it changes every recipe and
// action that references it. dismiss_overlay alone is depended on by another
// action and seven recipes. Validating only what an action PULLS IN checks the
// safe direction and misses the one where damage spreads.

test('dependents are found transitively, through other actions and into recipes', () => {
  const { dependentsOf } = require('../lib/gate');
  const { openDb } = require('../db');
  const deps = dependentsOf(openDb(), 'dismiss_overlay');
  assert.ok(deps.actions.includes('open_apply_form'), 'an action referencing it is a dependent');
  assert.ok(deps.recipes.length > 0, 'so is every recipe that reaches it');
  assert.ok(
    deps.recipes.some(r => r.includes('#action:describe_application_form')),
    'including recipes that reach it only THROUGH open_apply_form'
  );
});

test('an action nothing references has no dependents', () => {
  const { dependentsOf } = require('../lib/gate');
  const { openDb } = require('../db');
  assert.deepEqual(dependentsOf(openDb(), 'no_such_action_exists'), { actions: [], recipes: [] });
});

test('a generic action is validated as a unit: its own steps and its subactions', () => {
  const { validateGenericAction } = require('../lib/gate');
  const { openDb } = require('../db');
  const db = openDb();

  assert.deepEqual(validateGenericAction(db, 'candidate', [{ action: 'wait', ms: 10 }]), [],
    'a well-formed action produces no findings');

  const badStep = validateGenericAction(db, 'candidate', [{ action: 'no_such_step' }]);
  assert.match(badStep.join(' '), /not implemented by engine\.js/);

  const badProbe = validateGenericAction(db, 'candidate', [{ action: 'probe', kind: 'no_such_kind' }]);
  assert.match(badProbe.join(' '), /probe kind "no_such_kind" is not registered/);

  const badSub = validateGenericAction(db, 'candidate', [{ action: 'run_generic_action', ref: 'nope_not_real' }]);
  assert.match(badSub.join(' '), /referenced but does not exist/);
});

test('a self-referencing action is caught before it can expand forever', () => {
  const { validateGenericAction } = require('../lib/gate');
  const { openDb } = require('../db');
  const findings = validateGenericAction(openDb(), 'loopy', [{ action: 'run_generic_action', ref: 'loopy' }]);
  assert.match(findings.join(' '), /references itself/);
});

test('a nested subaction inside a repeat is validated too', () => {
  const { validateGenericAction } = require('../lib/gate');
  const { openDb } = require('../db');
  const findings = validateGenericAction(openDb(), 'candidate', [
    { action: 'repeat', times: 1, steps: [{ action: 'probe', kind: 'still_not_a_kind' }] },
  ]);
  assert.match(findings.join(' '), /still_not_a_kind/, 'depth must not hide a broken step');
});

test('every builtin action passes its own validation', () => {
  // If the shipped library does not pass, every gated change inherits its
  // findings and the gate becomes noise people learn to ignore.
  const { validateGenericAction } = require('../lib/gate');
  const { openDb, listGenericActions, getGenericAction } = require('../db');
  const db = openDb();
  for (const g of listGenericActions(db)) {
    const row = getGenericAction(db, g.name);
    assert.deepEqual(validateGenericAction(db, g.name, row.steps), [], `${g.name} should be clean`);
  }
});

// --- The library's source file is validated, not just the seeded rows ------
// Editing lib/builtinActions.js is the one write path the gate cannot cover: a
// text editor needs no authorization. Seeding refuses a broken builtin at run
// time, but that is a warning on one run. This catches it at commit time.

test('every builtin in the SOURCE FILE validates, before it is ever seeded', () => {
  const { validateGenericAction } = require('../lib/gate');
  const { BUILTIN_ACTIONS } = require('../lib/builtinActions');
  const { openDb } = require('../db');
  const db = openDb();
  for (const a of BUILTIN_ACTIONS) {
    assert.deepEqual(
      validateGenericAction(db, a.name, a.steps),
      [],
      `${a.name} in lib/builtinActions.js would be REFUSED by seeding — the DB would silently keep the previous version`
    );
  }
});

test('the seeded rows match the source file', () => {
  // If these diverge, the DB is not running what the file says, which is the
  // symptom of a rejected edit.
  const { BUILTIN_ACTIONS } = require('../lib/builtinActions');
  const { openDb, getGenericAction } = require('../db');
  const db = openDb();
  for (const a of BUILTIN_ACTIONS) {
    const row = getGenericAction(db, a.name);
    assert.ok(row, `${a.name} should be seeded`);
    assert.equal(row.steps, JSON.stringify(a.steps), `${a.name}: the DB is running different steps from the source file`);
  }
});

test('a builtin declaring a parameter must actually use it', () => {
  // A documented parameter no step reads is a promise to callers that nothing
  // honours — found for real on probe_card_candidates, which documented
  // min_group while hardcoding 3.
  const { BUILTIN_ACTIONS } = require('../lib/builtinActions');
  for (const a of BUILTIN_ACTIONS) {
    let schema = {};
    try {
      schema = JSON.parse(a.nav_params_schema || '{}');
    } catch {
      assert.fail(`${a.name}: nav_params_schema is not valid JSON`);
    }
    const body = JSON.stringify(a.steps);
    for (const param of Object.keys(schema)) {
      assert.ok(body.includes(`{{${param}}}`), `${a.name} documents "${param}" but no step references {{${param}}}`);
    }
  }
});
