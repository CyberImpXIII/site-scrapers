// Run by ./dev.sh check (the suite), the gate gates.json names for this file.
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
const {
  authorize,
  authorizeAsync,
  assertAuthorized,
  currentAuthorization,
  revokeTestAuthorization,
} = require('../lib/writeGuard');

// Guard tests assert REFUSALS, so they must run with the blanket test
// authorization closed — otherwise the assertions pass for the wrong reason.
test.beforeEach(() => revokeTestAuthorization());

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

test('a severity downgrade is not an introduced finding; an upgrade or a new one is', () => {
  // Whole-string comparison rolled back a change for turning an error into a
  // warning (TODO section 0, the gate.js item).
  const { introducedFindings } = require('../lib/gate');
  const before = ['error|a.com#listing|bad thing', 'warn|b.com#listing|meh', 'info|c.com#article|fyi'];
  assert.deepEqual(introducedFindings(before, ['warn|a.com#listing|bad thing']), [], 'error -> warn is better');
  assert.deepEqual(introducedFindings(before, ['ok|a.com#listing|bad thing']), []);
  assert.deepEqual(introducedFindings(before, ['error|b.com#listing|meh']), ['error|b.com#listing|meh'], 'warn -> error is worse');
  assert.deepEqual(introducedFindings(before, ['warn|c.com#article|fyi']), ['warn|c.com#article|fyi']);
  assert.deepEqual(introducedFindings(before, ['warn|d.com#listing|new']), ['warn|d.com#listing|new']);
  assert.deepEqual(introducedFindings(before, before), [], 'unchanged is nothing');
  // A problem text containing "|" keeps its whole tail as the key.
  assert.deepEqual(introducedFindings(['error|u|p|q'], ['warn|u|p|q']), []);
  // An unknown shape is compared whole, never guessed at.
  assert.deepEqual(introducedFindings(['fatal|u|p'], ['fatal|u|p', 'odd string']), ['odd string']);
  assert.deepEqual(introducedFindings(['fatal|u|p'], ['warn|u|p']), ['warn|u|p'], 'no known rank to compare against');
});

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

// --- The library's authority runs DB -> file, not file -> DB ---------------
// lib/builtinActions.js was hand-edited and authoritative, which made it the
// one write path the gate could not cover: a text editor needs no
// authorization. The DB is now the source of truth and the file is a generated
// export, so a change to shared behaviour goes through the gate and the file is
// rewritten from the result. The file still exists because data/*.db is
// gitignored — it is how a clone gets the library, and how a change to shared
// behaviour stays reviewable in a diff.

test('the committed export matches the DB', () => {
  const { exportIsCurrent } = require('../lib/exportBuiltins');
  const { openDb } = require('../db');
  const state = exportIsCurrent(openDb());
  assert.equal(state.current, true, `lib/builtinActions.js has drifted from the DB: ${state.reason}`);
});

// R5. exportIsCurrent compares steps/description/schema only; this compares
// the whole file with a fresh render, so a hand edit to a changeNote, an
// action_type, the header or the order is caught too. Mutation-checked: each
// edit below fails it, the untouched file passes.
test('the committed export is byte for byte a fresh render of the DB', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { exportMatchesRender, TARGET } = require('../lib/exportBuiltins');
  const { openDb } = require('../db');
  const db = openDb();
  const state = exportMatchesRender(db);
  assert.equal(state.matches, true, `lib/builtinActions.js differs from a fresh render: ${JSON.stringify(state.firstDiff)}`);

  const original = fs.readFileSync(TARGET, 'utf8');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-render-'));
  try {
    const mutants = {
      header: original.replace('GENERATED FILE', 'GENERATED  FILE'),
      actionType: original.replace('"action_type": null', '"action_type": "login"'),
      changeNote: original.replace(/"changeNote": "([^"]{10})/, '"changeNote": "X$1'),
      trailing: original + '\n',
    };
    // A fresh clone's DB has no builtin history, so its notes come from the
    // file and a note-only edit is the one thing it cannot see (documented in
    // exportMatchesRender).
    const history = db.prepare("SELECT COUNT(*) AS n FROM change_log WHERE target LIKE 'generic:%' AND rolled_back = 0").get().n;
    if (!history) delete mutants.changeNote;
    for (const [name, text] of Object.entries(mutants)) {
      assert.notEqual(text, original, `mutant ${name} changed nothing; fix the test`);
      const f = path.join(tmp, `${name}.js`);
      fs.writeFileSync(f, text);
      const r = exportMatchesRender(db, f);
      assert.equal(r.matches, false, `a hand edit (${name}) must not match the render`);
      assert.ok(r.firstDiff && r.firstDiff.line > 0, name);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the export carries a DO-NOT-EDIT header naming the gated path', () => {
  // A generated file with no warning gets hand-edited, and the next export
  // silently discards the edit.
  const src = require('fs').readFileSync(require('../lib/exportBuiltins').TARGET, 'utf8');
  assert.match(src, /GENERATED FILE/);
  assert.match(src, /DO NOT EDIT/i);
  assert.match(src, /register\.js/, 'it has to say what to use instead');
});

test('exporting an empty library is refused', () => {
  // The export is the only place a fresh clone can get the library, so writing
  // an empty one would erase it rather than merely be wrong.
  const { exportBuiltins } = require('../lib/exportBuiltins');
  const emptyDb = { prepare: () => ({ all: () => [] }) };
  assert.throws(() => exportBuiltins(emptyDb), /refusing to export an empty builtin library/);
});

test('exportIsCurrent reports WHAT drifted, not just that something did', () => {
  const { exportIsCurrent } = require('../lib/exportBuiltins');
  const fake = {
    prepare: () => ({
      all: () => [
        { name: 'dismiss_overlay', description: 'x', action_type: null, nav_params_schema: '{}', steps: '[{"action":"wait","ms":1}]' },
      ],
    }),
  };
  const state = exportIsCurrent(fake);
  assert.equal(state.current, false);
  assert.ok(state.reason && state.reason.length > 10, 'a bare "false" gives nobody anything to act on');
});

test('the generated export is written read-only', () => {
  // Turns "do not hand-edit" from a comment into something the filesystem
  // refuses. Not a security boundary — `chmod +w` defeats it instantly, and git
  // does not preserve the bit, so a fresh clone gets a writable file. It raises
  // the cost of the ACCIDENT, which is the case that actually happens.
  const fs = require('fs');
  const { TARGET } = require('../lib/exportBuiltins');
  const mode = fs.statSync(TARGET).mode & 0o777;
  assert.equal(mode & 0o222, 0, `expected no write bits on the generated export, got ${mode.toString(8)}`);
});

// --- Provenance travels with the library, in the committed file ------------
// The change_log lives in the gitignored DB, so it is invisible in a diff.
// Stamping the reason onto each exported action puts it where a reviewer will
// see it: a legitimate edit changes `steps` AND `changeNote` together, while a
// hand-edit changes steps and leaves a note describing something else.

test('every exported builtin carries a change note', () => {
  const { BUILTIN_ACTIONS } = require('../lib/builtinActions');
  for (const a of BUILTIN_ACTIONS) {
    assert.ok(
      typeof a.changeNote === 'string' && a.changeNote.length > 10,
      `${a.name} has no changeNote — without it, a change to shared behaviour has no visible reason in the diff`
    );
    assert.ok('changedAt' in a, `${a.name} should carry a changedAt, even if null`);
  }
});

test('a recorded change timestamp is backed by a change_log entry', () => {
  // A changedAt with nothing behind it would mean the note was written by hand
  // rather than earned by a gated change.
  const { BUILTIN_ACTIONS } = require('../lib/builtinActions');
  const { openDb } = require('../db');
  const db = openDb();
  require('../lib/gate').ensureChangeLog(db);
  for (const a of BUILTIN_ACTIONS.filter(x => x.changedAt)) {
    const row = db
      .prepare('SELECT COUNT(*) AS n FROM change_log WHERE target = ? AND rolled_back = 0')
      .get(`generic:${a.name}`);
    assert.ok(row.n > 0, `${a.name} claims a change at ${a.changedAt} but no change_log entry backs it`);
  }
});

// --- The audit that does not depend on how the row got there ---------------
// Write-time gating gives a useful error early, but it can only cover paths it
// knows about. Auditing at the POINT OF USE — against whatever the DB actually
// says, every time an action is expanded — makes a bad definition unrunnable
// regardless of whether it arrived through the gate, a hand-edited export, a
// pulled change, or sqlite3 on the command line.

test('an unrunnable action is refused at expansion, however it got into the DB', () => {
  const { expandSteps } = require('../lib/composeActions');
  const { openDb } = require('../db');
  const db = openDb();

  // Injected with raw SQL on purpose: no authorize(), no gate, no register.js.
  const inject = steps =>
    db
      .prepare(
        `INSERT OR REPLACE INTO generic_actions (name, description, action_type, nav_params_schema, steps, source, created_at, updated_at)
         VALUES ('guardtest_tampered', 'injected directly', NULL, '{}', ?, 'user', datetime('now'), datetime('now'))`
      )
      .run(JSON.stringify(steps));

  try {
    inject([{ action: 'probe', kind: 'ghost_kind' }]);
    assert.throws(
      () => expandSteps(db, [{ action: 'run_generic_action', ref: 'guardtest_tampered' }], 'x.test', new Set()),
      /not runnable as currently defined in the database.*ghost_kind/s,
      'an unregistered probe kind must stop the run before a browser is launched'
    );

    inject([{ action: 'no_such_step_type' }]);
    assert.throws(
      () => expandSteps(db, [{ action: 'run_generic_action', ref: 'guardtest_tampered' }], 'x.test', new Set()),
      /step type "no_such_step_type" is not implemented/
    );

    inject([{ ms: 100 }]);
    assert.throws(
      () => expandSteps(db, [{ action: 'run_generic_action', ref: 'guardtest_tampered' }], 'x.test', new Set()),
      /no "action"/,
      'a step the engine would silently skip is worse than one that fails'
    );

    // Nesting must not hide it.
    inject([{ action: 'repeat', times: 1, steps: [{ action: 'probe', kind: 'ghost_kind' }] }]);
    assert.throws(
      () => expandSteps(db, [{ action: 'run_generic_action', ref: 'guardtest_tampered' }], 'x.test', new Set()),
      /ghost_kind/
    );

    // And a valid definition still expands.
    inject([{ action: 'wait', ms: 10 }]);
    assert.doesNotThrow(() =>
      expandSteps(db, [{ action: 'run_generic_action', ref: 'guardtest_tampered' }], 'x.test', new Set())
    );
  } finally {
    db.prepare("DELETE FROM generic_actions WHERE name = 'guardtest_tampered'").run();
  }
});

test('the runtime audit only blocks UNRUNNABLE definitions, not style', () => {
  // If it blocked style problems too, a run could fail over something
  // `audit.js` is meant to merely report, and people would route around it.
  const { assertGenericActionRunnable } = require('../lib/composeActions');
  assert.doesNotThrow(() =>
    assertGenericActionRunnable('stylistically_poor', [
      { action: 'click', selector: 'div:has(a[href])' }, // audit.js warns; still runnable
      { action: 'wait', ms: 1 },
    ])
  );
});

test('every seeded generic action is runnable right now', () => {
  // The whole library is expanded through the real path. If any action in the
  // DB were unrunnable, every recipe referencing it would fail at run time.
  const { expandSteps } = require('../lib/composeActions');
  const { openDb, listGenericActions } = require('../db');
  const db = openDb();
  for (const g of listGenericActions(db)) {
    assert.doesNotThrow(
      () => expandSteps(db, [{ action: 'run_generic_action', ref: g.name }], 'x.test', new Set()),
      `${g.name} is in the DB but would refuse to run`
    );
  }
});

// --- Every store that changes BEHAVIOUR is guarded -------------------------
// An audit of what was still writable without authorization found three holes,
// all reachable through a different door than the one the gate watches. Each is
// pinned here so it cannot quietly reopen.

test('the failures DB is guarded, including the tables that change conclusions', () => {
  // blocker_signatures decides whether verify.js concludes "blocked-attn".
  // probe_knowledge decides what the forms probe calls required. Neither is
  // passive record-keeping: a bad row changes what the system concludes.
  const fdb = require('../failuresDb');
  const fake = { prepare: () => ({ run: () => {}, get: () => null, all: () => [] }) };
  for (const name of [
    'recordFailure',
    'deleteFailure',
    'insertFailureType',
    'insertBlockerSignature',
    'deleteBlockerSignature',
    'insertProbeKnowledge',
  ]) {
    assert.equal(typeof fdb[name], 'function', `${name} should exist`);
    assert.throws(() => fdb[name](fake, { symptom: 'x', failure_type: 'y', value: 'z' }), /guarded write/, `${name} must refuse an unauthorized call`);
  }
});

test('logRun is guarded, because it feeds an earned status', () => {
  // definitionHasPassingRun reads result_count to decide whether register.js may
  // accept status "working". Unguarded, an inserted row grants that status with
  // no run behind it — the earned-status gate reached through a different door.
  const { logRun } = require('../db');
  const fake = { prepare: () => ({ run: () => {} }) };
  assert.throws(() => logRun(fake, { siteId: 1, success: true, resultCount: 99 }), /guarded write/);
});

test('a real run can still record its own outcome', () => {
  // The guard must not break the thing it protects: engine.js authorizes a
  // narrow scope around its own insert.
  const { authorize } = require('../lib/writeGuard');
  const { logRun } = require('../db');
  let inserted = false;
  const fake = { prepare: () => ({ run: () => { inserted = true; } }) };
  authorize('test: simulated run telemetry', () => logRun(fake, { siteId: 1, success: true, resultCount: 5 }));
  assert.equal(inserted, true);
});

test('no writable store is left unguarded', () => {
  // A structural check rather than a list to maintain: every exported function
  // whose name implies a mutation must refuse an unauthorized call. If a new
  // mutator is added without a guard, this fails rather than waiting for someone
  // to notice.
  const fake = { prepare: () => ({ run: () => {}, get: () => null, all: () => [] }) };
  const MUTATOR = /^(insert|upsert|delete|record|promote|restore|snapshot|prune)/;
  // logRun is named for what it does rather than how; checked separately above.
  const exempt = new Set(['pruneVersions', 'insertProbeKnowledge']);
  for (const mod of ['../db', '../failuresDb']) {
    const api = require(mod);
    for (const [name, fn] of Object.entries(api)) {
      if (typeof fn !== 'function' || !MUTATOR.test(name) || exempt.has(name)) continue;
      assert.throws(
        () => fn(fake, {}, {}),
        /guarded write/,
        `${mod} exports ${name}, which mutates but does not require authorization`
      );
    }
  }
});
