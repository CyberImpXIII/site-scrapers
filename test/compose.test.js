// Unit tests for action composition (lib/composeActions.js) and failure
// matching (failuresDb.js) — the pure logic underneath "reuse before you write".
//
// Composition is where a mistake is most expensive: expandSteps decides what a
// recipe ACTUALLY runs, so a wrong expansion is a silent behaviour change
// rather than an error. Cycle detection in particular has to fail loudly,
// because the alternative is an infinite step list.
//
// Run via `npm test` / `./test.sh`.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { expandSteps, applyWith, refKey, genericRefKey, stepsNeedHeaded } = require('../lib/composeActions');
const { openDb, upsertSite, insertField, deleteSite } = require('../db');
const { authorizeForTests } = require('../lib/writeGuard');
const { openFailuresDb, signatureOf, matchFailures, recordFailure, deleteFailure } = require('../failuresDb');

let db;
let fdb;
const created = [];
const createdFailures = [];

test.before(() => {
  authorizeForTests();
  db = openDb();
  fdb = openFailuresDb();
});

test.after(() => {
  for (const id of created) deleteSite(db, id);
  for (const id of createdFailures) deleteFailure(fdb, id);
});

// --- applyWith(): parameter substitution into a referenced action ----------

test('applyWith replaces a placeholder everywhere it appears', () => {
  const steps = [
    { action: 'click', selector: '{{target}}' },
    { action: 'waitForSelector', selector: '{{target}}' },
  ];
  const out = applyWith(steps, { target: '.go' });
  assert.equal(out[0].selector, '.go');
  assert.equal(out[1].selector, '.go', 'a parameter used twice is substituted twice');
});

test('applyWith leaves unrelated placeholders alone', () => {
  const out = applyWith([{ action: 'click', selector: '{{a}}', url: '{{b}}' }], { a: '.x' });
  assert.equal(out[0].selector, '.x');
  assert.equal(out[0].url, '{{b}}', 'an unsupplied parameter stays a placeholder, so a default can apply later');
});

test('applyWith escapes values so a quote cannot corrupt the step list', () => {
  // It works by JSON round-trip, so an unescaped quote would produce invalid
  // JSON and throw rather than silently mangling a later step.
  const out = applyWith([{ action: 'click', selector: '{{sel}}' }], { sel: 'a[title="x"]' });
  assert.equal(out[0].selector, 'a[title="x"]');
});

test('applyWith with no values is a no-op', () => {
  const steps = [{ action: 'click', selector: '.x' }];
  assert.deepEqual(applyWith(steps, null), steps);
  assert.deepEqual(applyWith(steps, undefined), steps);
});

// --- expandSteps(): what a recipe actually runs ----------------------------

test('a plain step list expands to itself', () => {
  const steps = [{ action: 'goto', url: 'https://x.test' }, { action: 'collect' }];
  assert.deepEqual(expandSteps(db, steps, 'x.test', new Set()), steps);
});

test('a generic action reference is inlined and tagged with its origin', () => {
  const out = expandSteps(
    db,
    [{ action: 'goto', url: 'https://x.test' }, { action: 'run_generic_action', ref: 'dismiss_overlay' }],
    'x.test',
    new Set()
  );
  assert.ok(out.length > 2, 'the reference is replaced by the action\'s own steps');
  assert.equal(out[0]._from, undefined, "the recipe's own step carries no origin");
  assert.ok(
    out.slice(1).every(s => s._from === 'generic:dismiss_overlay'),
    'every inlined step records where it came from, so a failure inside it is attributable'
  );
});

test('nested references produce a breadcrumb chain, not just the innermost', () => {
  // open_apply_form references dismiss_overlay, so its steps are two levels
  // deep. Reporting only the inner name would lose which action pulled it in.
  const out = expandSteps(db, [{ action: 'run_generic_action', ref: 'open_apply_form' }], 'x.test', new Set());
  const chained = out.filter(s => (s._from || '').includes('>'));
  assert.ok(chained.length > 0, 'expected at least one doubly-nested step');
  assert.match(chained[0]._from, /^generic:open_apply_form > generic:/);
});

test('steps inside a repeat are expanded but the repeat keeps its structure', () => {
  const out = expandSteps(
    db,
    [{ action: 'repeat', times: 2, steps: [{ action: 'run_generic_action', ref: 'dismiss_overlay' }] }],
    'x.test',
    new Set()
  );
  assert.equal(out.length, 1, 'the repeat itself is not unrolled — it loops at run time');
  assert.equal(out[0].action, 'repeat');
  assert.ok(out[0].steps.length > 1, 'but its contents are expanded');
});

test('a reference to something that does not exist fails loudly', () => {
  assert.throws(
    () => expandSteps(db, [{ action: 'run_generic_action', ref: 'no_such_action_exists' }], 'x.test', new Set()),
    /run_generic_action/,
    'a dangling reference must not silently expand to nothing'
  );
});

test('a missing ref is an error, not an empty expansion', () => {
  assert.throws(() => expandSteps(db, [{ action: 'run_generic_action' }], 'x.test', new Set()), /missing "ref"/);
  assert.throws(() => expandSteps(db, [{ action: 'run_action' }], 'x.test', new Set()), /missing "ref"/);
});

test('a reference cycle is detected instead of expanding forever', () => {
  const id = upsertSite(db, {
    hostname: 'cycle.test',
    page_type: 'action',
    recipe_name: 'loop',
    action_type: 'login',
    status: 'working',
    nav_method: 'ui_steps',
    // References itself.
    nav_template: JSON.stringify([{ action: 'run_action', ref: 'loop' }]),
    content_selector: 'body',
    notes: 'Test-only fixture for test/compose.test.js. Safe to delete if found stray.',
  });
  created.push(id);
  insertField(db, id, { field_name: 'b', extract_kind: 'full_blob' }, 0);

  assert.throws(
    () => expandSteps(db, [{ action: 'run_action', ref: 'loop' }], 'cycle.test', new Set()),
    /cycle detected/,
    'self-reference must be caught before it becomes an infinite list'
  );

  // Through the CLI: engine.js reports the cycle and STOPS. Its exit fires
  // from a stdout-write callback, so without a `return` main() ran on past
  // the error (TODO 0j) -- the signature is a second JSON document on stdout.
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'engine.js'), 'cycle.test#action:loop', '{}'], {
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  const docs = r.stdout.trim().split('\n').filter(Boolean);
  assert.equal(docs.length, 1, `exactly one JSON document, got:\n${r.stdout}`);
  const out = JSON.parse(docs[0]);
  assert.equal(out.success, false);
  assert.match(out.error, /cycle detected/);
  assert.equal(r.status, 1);
});

test('engine.js bad-JSON params: one refusal, nothing run after it', () => {
  // 2026-10-06, before the fix: `engine.js no-such-host.invalid '{bad'`
  // printed "Bad JSON in params" AND then "No site documented" -- it went on
  // to look the recipe up, and on a real one would have run it with {}.
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'engine.js'), 'no-such-host.invalid', '{bad'], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  const docs = r.stdout.trim().split('\n').filter(Boolean);
  assert.equal(docs.length, 1, `exactly one JSON document, got:\n${r.stdout}`);
  assert.match(JSON.parse(docs[0]).error, /Bad JSON in params/);
  assert.equal(r.status, 1);
});

// --- stepsNeedHeaded(): does this require a visible browser? ---------------

test('a handoff anywhere forces a headed run, including inside a repeat', () => {
  assert.equal(stepsNeedHeaded([{ action: 'click', selector: '.x' }]), false);
  assert.equal(stepsNeedHeaded([{ action: 'handoff', reason: 'solve it' }]), true);
  assert.equal(
    stepsNeedHeaded([{ action: 'repeat', times: 1, steps: [{ action: 'handoff', reason: 'solve it' }] }]),
    true,
    'a nested handoff still needs a person, so it still needs a window'
  );
});

// --- refKey / genericRefKey ------------------------------------------------

test('reference keys distinguish recipes that differ only by name', () => {
  const a = refKey({ hostname: 'x.test', pageType: 'action', recipeName: 'login' });
  const b = refKey({ hostname: 'x.test', pageType: 'action', recipeName: 'checkout' });
  assert.notEqual(a, b);
  assert.notEqual(a, genericRefKey('login'), 'a site recipe and a generic action are different namespaces');
});

// --- Failure identity and matching ----------------------------------------

test('failure identity ignores symptom text but not the failing selector', () => {
  const base = {
    failure_type: 'slow_render',
    hostname: 'sig.test',
    page_type: 'listing',
    recipe_name: 'default',
    step_action: 'waitForSelector',
    step_selector: '.card',
  };
  assert.equal(
    signatureOf({ ...base, symptom: 'timed out at 8000ms' }),
    signatureOf({ ...base, symptom: 'timed out at 30000ms' }),
    'the same problem described with a different number is one failure'
  );
  assert.notEqual(
    signatureOf(base),
    signatureOf({ ...base, step_selector: '.other' }),
    'a different selector is a different failure'
  );
  assert.notEqual(
    signatureOf(base),
    signatureOf({ ...base, hostname: 'other.test' }),
    'the same shape on another site is tracked separately'
  );
});

test('matching withholds weak hits rather than pointing somewhere wrong', () => {
  const r = recordFailure(fdb, {
    failure_type: 'consent_overlay',
    hostname: 'matchtest.example',
    step_action: 'collect',
    symptom: 'compose_test_marker zero results, consent dialog over the list',
    resolution: 'composed dismiss_overlay before collect',
  });
  createdFailures.push(r.id);

  // Same shape on a different site: should surface, because the fix transfers.
  const strong = matchFailures(fdb, {
    hostname: 'somewhere-else.example',
    failure_type: 'consent_overlay',
    step_action: 'collect',
    symptom: 'zero results, a consent dialog is over the list',
  });
  assert.ok(strong.some(h => h.hostname === 'matchtest.example'));

  // Nothing in common: must NOT surface. A weak match is worse than none.
  const weak = matchFailures(fdb, {
    hostname: 'unrelated.example',
    failure_type: 'pagination_broken',
    symptom: 'next button does nothing',
  });
  assert.ok(!weak.some(h => h.hostname === 'matchtest.example'));
});

test('a match explains itself', () => {
  const hits = matchFailures(fdb, {
    hostname: 'matchtest.example',
    failure_type: 'consent_overlay',
    step_action: 'collect',
    symptom: 'consent dialog over the list',
  });
  const hit = hits.find(h => h.hostname === 'matchtest.example');
  assert.ok(hit, 'expected the recorded failure to match itself');
  assert.ok(Array.isArray(hit.why) && hit.why.length, 'a score with no reasons is not actionable');
  assert.ok(hit.why.includes('same site') && hit.why.includes('same failure type'));
});
