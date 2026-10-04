// Gates for lib/describeVerdict.js: a describe_form recipe that found no form
// fields has extracted nothing.
//
// Before 2026-10-03 verify.js judged a describe on `article` (the page's text),
// so a run that never left the posting page -- 0 fields -- earned `working`,
// and engine.js logged it as a passing run (result_count 1). That hid a dead
// open_apply_form default_selector on Lever and Ashby.
//
// Proven here by runs through verify.js --dry and engine.js, offline against
// test/fixtures/ats/:
//   1. a describe recipe on a page with no form -> not extracted (broken), and
//      the engine logs result_count 0, while its output is unchanged
//      (success:true, an empty field list -- a true description of the page);
//   2. the same recipe on a page with a form -> working, recordsExtracted =
//      the described field count, result_count the same;
//   3. narrowness: a recipe NOT typed describe_form is judged exactly as
//      before, even when it runs a forms probe on a page with no form;
//   4. the seam: every stored recipe whose product is the describe_form action
//      is typed describe_form, so none escapes the verdict.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const { openDb, upsertSite, insertField, deleteSite } = require('../db');
const { authorizeForTests } = require('../lib/writeGuard');
const { startAtsServer } = require('./fixtures/ats/server');
const { verdictInputsFromDescribe, DESCRIBE_ACTION_TYPE } = require('../lib/describeVerdict');

const REPO_ROOT = path.join(__dirname, '..');
// Not 127.0.0.1: these recipes are not `working`, and test-prefer-recipes.sh picks
// a non-working host from the live DB -- a 127.0.0.1 one races fill.test.js's
// working 127.0.0.1 recipes (seen 2026-10-03). It skips hosts ending in "internal".
const HOST = 'describe-verdict.internal';

let ats;
let db;
const created = [];

function recipe(name, actionType) {
  const id = upsertSite(db, {
    hostname: HOST,
    page_type: 'action',
    recipe_name: name,
    status: 'needs-review',
    nav_method: 'ui_steps',
    // The live describe recipes' shape minus open_apply_form: the page the
    // forms probe reads is chosen by the URL, so "no form" is deterministic.
    nav_template: JSON.stringify([{ action: 'goto', url: '{{url}}' }, { action: 'run_generic_action', ref: 'describe_form' }]),
    action_type: actionType,
    card_min_text_len: 1,
    ready_timeout_ms: 4000,
    notes: 'Test-only recipe for test/describe-verdict.test.js. Safe to delete if found stray.',
  });
  created.push(id);
  insertField(db, id, { field_name: 'body', extract_kind: 'full_blob' }, 0);
  return id;
}

async function verifyDry(name, url) {
  const args = ['verify.js', `${HOST}#action:${name}`, JSON.stringify({ url, noSession: true, noDiagnostics: true }), '--dry'];
  let stdout;
  try {
    ({ stdout } = await execFileAsync(process.execPath, args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  } catch (e) {
    stdout = e.stdout;
  }
  return JSON.parse(stdout);
}

async function engine(name, url) {
  const args = ['engine.js', `${HOST}#action:${name}`, JSON.stringify({ url, noSession: true, noDiagnostics: true, allowUnverified: true })];
  let stdout;
  try {
    ({ stdout } = await execFileAsync(process.execPath, args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  } catch (e) {
    stdout = e.stdout;
  }
  return JSON.parse(stdout);
}

const lastResultCount = id =>
  db.prepare('SELECT result_count FROM scrape_runs WHERE site_id = ? ORDER BY id DESC LIMIT 1').get(id)?.result_count ?? null;

test.before(async () => {
  authorizeForTests();
  ats = await startAtsServer();
  db = openDb();
});

test.after(async () => {
  for (const id of created) deleteSite(db, id);
  await ats.close();
});

test('verdictInputsFromDescribe: only a describe_form recipe is judged on fields', () => {
  const forms = n => ({ kind: 'forms', fields: Array.from({ length: n }, (_, i) => ({ selector: `#f${i}` })) });
  assert.equal(verdictInputsFromDescribe('login', [forms(0)]), null, 'another action_type is not a describe');
  assert.equal(verdictInputsFromDescribe(null, [forms(0)]), null, 'an untyped recipe is not a describe');
  assert.deepEqual(verdictInputsFromDescribe(DESCRIBE_ACTION_TYPE, [forms(0)]), { extracted: false, fields: 0 });
  assert.deepEqual(verdictInputsFromDescribe(DESCRIBE_ACTION_TYPE, undefined), { extracted: false, fields: 0 }, 'no forms probe ran: nothing described');
  assert.deepEqual(verdictInputsFromDescribe(DESCRIBE_ACTION_TYPE, [{ kind: 'blockers', flags: [] }]), { extracted: false, fields: 0 });
  assert.deepEqual(verdictInputsFromDescribe(DESCRIBE_ACTION_TYPE, [forms(0), forms(3)]), { extracted: true, fields: 3 });
});

test('a describe recipe on a page with NO form is not extracted, and is not logged as a passing run', async () => {
  const id = recipe('describe_verdict_noform', DESCRIBE_ACTION_TYPE);
  const url = ats.postingUrl();

  // The engine's output is unchanged: the page has text and no form, which is
  // exactly what it reports.
  const out = await engine('describe_verdict_noform', url);
  assert.equal(out.success, true, `engine output should be unchanged for a page with no form: ${JSON.stringify(out).slice(0, 300)}`);
  const forms = (out.diagnostics || []).find(d => d.kind === 'forms');
  assert.ok(forms, 'describe_form ran no forms probe');
  assert.equal(forms.fields.length, 0, 'the posting fixture must have no form fields');
  assert.equal(lastResultCount(id), 0, 'a 0-field describe must log result_count 0, or definitionHasPassingRun counts it');

  const v = await verifyDry('describe_verdict_noform', url);
  assert.equal(v.recordsExtracted, 0, `a 0-field describe counted as ${v.recordsExtracted} record(s)`);
  assert.equal(v.verdict, 'broken', `a never-proven 0-field describe must not be ${v.verdict}`);
  assert.equal(v.describe?.fields, 0);
});

test('a describe recipe on a page WITH a form is extracted, counted in fields', async () => {
  const id = recipe('describe_verdict_form', DESCRIBE_ACTION_TYPE);
  const v = await verifyDry('describe_verdict_form', ats.url('greenhouse'));
  assert.equal(v.verdict, 'working', JSON.stringify(v).slice(0, 400));
  assert.ok(v.describe?.fields > 0, 'the Greenhouse fixture has a form');
  assert.equal(v.recordsExtracted, v.describe.fields, 'a describe extracts its described fields');
  assert.equal(lastResultCount(id), v.describe.fields, 'the logged result_count must match verify.js');
});

test('narrowness: a recipe not typed describe_form is judged as before, even on a page with no form', async () => {
  const id = recipe('describe_verdict_untyped', null);
  const v = await verifyDry('describe_verdict_untyped', ats.postingUrl());
  assert.equal(v.verdict, 'working', 'an untyped recipe is still judged on page text');
  assert.equal(v.recordsExtracted, 1);
  assert.equal(v.describe, undefined, 'no describe verdict for an untyped recipe');
  assert.equal(lastResultCount(id), 1);
});

test('seam: every stored recipe that ends in describe_form is typed describe_form', () => {
  // The verdict keys on the DECLARED action_type. A recipe whose product is a
  // describe but typed otherwise would be judged on page text again.
  const rows = db.prepare("SELECT hostname, recipe_name, action_type, nav_template FROM sites WHERE page_type = 'action'").all();
  const untyped = [];
  for (const r of rows) {
    let steps;
    try {
      steps = JSON.parse(r.nav_template || '[]');
    } catch {
      continue;
    }
    const last = Array.isArray(steps) ? steps[steps.length - 1] : null;
    const describes = last && last.action === 'run_generic_action' && last.ref === 'describe_form';
    if (describes && r.action_type !== DESCRIBE_ACTION_TYPE && r.hostname !== HOST) untyped.push(`${r.hostname}#action:${r.recipe_name} (${r.action_type})`);
  }
  assert.deepEqual(untyped, [], 'these describe recipes would escape the 0-field verdict');
});
