// Gates for multi-option questions (checkbox and radio groups) in the forms
// probe and fill_form. Reported 2026-10-03 by the applications agent on live
// Greenhouse twitch/jobs/8623401002, `question_37220519002[]`, and confirmed
// there by a describe run:
//   - each option was described with only its own text ("TikTok", "None"), so
//     nothing said what the question was;
//   - every option was `required:true` (Greenhouse puts `required` on each),
//     though one ticked answers it -- so a fill that ticked one still listed
//     the rest in requiredNotFilled, and no answer could make a packet ready.
// And on live Lever (palantir), found while checking: options have NO id, so
// every option of a question got the same `input[name=...]` selector, which
// fill_form refuses as selector_not_unique -- no option could be answered.
//
// Proven here, offline, against test/fixtures/ats/ ?groups=1 (both shapes):
//   1. each option carries `group` {name, question, required, size}; the
//      option's own `required` is false; hasValue reflects `checked`;
//   2. Lever-shaped options get distinct selectors that each resolve;
//   3. a Greenhouse-shaped description stored before this change hashes the
//      same, so existing packets are not flagged formChanged;
//   4. ticking one option satisfies a required group: no member selector in
//      requiredNotFilled, requiredGroupsNotFilled empty;
//   5. an unanswered required group is reported once in
//      requiredGroupsNotFilled (with its question), and its members stay in
//      requiredNotFilled, so a caller testing that list for emptiness stays safe.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const { openDb, upsertSite, insertField, deleteSite } = require('../db');
const { authorizeForTests } = require('../lib/writeGuard');
const { startAtsServer } = require('./fixtures/ats/server');
const { validateFillResult } = require('../lib/fillContract');
const { formHash } = require('../lib/formHash');

const REPO_ROOT = path.join(__dirname, '..');
// Not 127.0.0.1, so these never collide with fill.test.js's recipes.
const HOST = 'option-groups.internal';
const GH = 'question_3003[]';
const LEVER = 'cards[fx-0001][field0]';
// Lever checkboxes: no id AND no value attribute (live palantir, 33 options).
const LEVER_CB = 'cards[fx-0001][field1]';

let ats;
let db;
const created = [];

function recipe(name, steps) {
  const id = upsertSite(db, {
    hostname: HOST,
    page_type: 'action',
    recipe_name: name,
    status: 'working',
    nav_method: 'ui_steps',
    nav_template: JSON.stringify(steps),
    card_min_text_len: 1,
    ready_timeout_ms: 4000,
    notes: 'Test-only recipe for test/option-groups.test.js. Safe to delete if found stray.',
  });
  created.push(id);
  insertField(db, id, { field_name: 'body', extract_kind: 'full_blob' }, 0);
}

async function run(name, params) {
  const args = ['engine.js', `${HOST}#action:${name}`, JSON.stringify({ noSession: true, noDiagnostics: true, ...params })];
  let stdout;
  try {
    ({ stdout } = await execFileAsync(process.execPath, args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  } catch (e) {
    stdout = e.stdout;
  }
  return JSON.parse(stdout);
}

async function describe(query) {
  const out = await run('groups_describe', { url: ats.url('greenhouse', query) });
  const forms = (out.diagnostics || []).find(d => d.kind === 'forms');
  assert.ok(forms && Array.isArray(forms.fields), `describe returned no forms probe: ${JSON.stringify(out).slice(0, 300)}`);
  return forms;
}

const members = (fields, name) => fields.filter(f => f.name === name);

test.before(async () => {
  authorizeForTests();
  ats = await startAtsServer();
  db = openDb();
  recipe('groups_describe', [{ action: 'goto', url: '{{url}}' }, { action: 'probe', kind: 'forms' }]);
  recipe('groups_fill', [{ action: 'goto', url: '{{url}}' }, { action: 'fill_form', fields: '{{fields}}', answers: '{{answers}}' }]);
});

test.after(async () => {
  for (const id of created) deleteSite(db, id);
  await ats.close();
});

test('describe: each option of a multi-option question carries its group, and the group carries required-ness', async () => {
  const forms = await describe('groups=1');
  const gh = members(forms.fields, GH);
  const lever = members(forms.fields, LEVER);
  const leverCb = members(forms.fields, LEVER_CB);
  assert.equal(gh.length, 3, 'the Greenhouse-shaped checkbox question has 3 options');
  assert.equal(lever.length, 2, 'the Lever-shaped radio question has 2 options');
  assert.equal(leverCb.length, 3, 'the Lever-shaped checkbox question has 3 options');

  for (const [opts, question, size] of [
    [gh, /^Which fixture platforms have you used\?/, 3],
    [lever, /^Are you authorized to work in Fixtureland\?/, 2],
    [leverCb, /^Which fixture languages do you speak\?/, 3],
  ]) {
    for (const f of opts) {
      assert.ok(f.group, `${f.selector}: no group on a multi-option question`);
      assert.match(f.group.question || '', question, `${f.selector}: the question text is missing`);
      assert.equal(f.group.required, true, `${f.selector}: the question is required`);
      assert.ok(f.group.requiredEvidence, `${f.selector}: group required-ness needs its evidence`);
      assert.equal(f.group.size, size);
      assert.equal(f.required, false, `${f.selector}: one option is not required; the question is`);
      assert.equal(f.hasValue, false, `${f.selector}: an unticked option has no value`);
    }
  }
  assert.deepEqual(gh.map(f => f.label), ['Alpha', 'Beta', 'None'], 'each option keeps its own text as its label');

  // Lever's options have no id: each needs its own selector, or none can be answered.
  assert.equal(new Set(lever.map(f => f.selector)).size, 2, `Lever options share a selector: ${lever.map(f => f.selector)}`);
  assert.equal(new Set(leverCb.map(f => f.selector)).size, 3, `value-less Lever options share a selector: ${leverCb.map(f => f.selector)}`);
  assert.deepEqual(leverCb.map(f => f.label), ['Fixtish', 'Testese', 'Mockian']);

  // A field outside any group is unchanged.
  const single = forms.fields.find(f => f.name === 'question_2002[]');
  assert.equal(single.group, null, 'a lone checkbox is not a group');

  // requiredCount counts questions: each required group once.
  const plain = await describe('');
  assert.equal(forms.requiredCount, plain.requiredCount + 3);
});

test('describe: a Greenhouse-shaped description stored before groups existed hashes the same', async () => {
  // Before: options carried required:true and no `group`. Labels and selectors
  // (ids) are unchanged, so an existing packet must not read as formChanged.
  const forms = await describe('groups=1');
  const before = forms.fields
    .filter(f => f.name !== LEVER && f.name !== LEVER_CB)
    .map(f => {
      const { group, ...rest } = f;
      return group ? { ...rest, required: true } : rest;
    });
  const now = forms.fields.filter(f => f.name !== LEVER && f.name !== LEVER_CB);
  assert.equal(formHash(now), formHash(before));
});

test('fill: ticking one option answers a required group', async () => {
  const forms = await describe('groups=1');
  const beta = members(forms.fields, GH).find(f => f.label === 'Beta');
  const yes = members(forms.fields, LEVER).find(f => f.label === 'Yes');
  const testese = members(forms.fields, LEVER_CB).find(f => f.label === 'Testese');
  const answers = { [beta.selector]: true, [yes.selector]: true, [testese.selector]: true };
  const out = await run('groups_fill', { url: ats.url('greenhouse', 'groups=1'), fields: forms.fields, answers });
  const fill = out.fill;
  assert.deepEqual(validateFillResult(fill, forms.fields), [], 'fill output violates the contract');
  const outcome = Object.fromEntries(fill.fields.map(f => [f.selector, f.outcome]));
  assert.equal(outcome[beta.selector], 'filled');
  assert.equal(outcome[yes.selector], 'filled', 'a Lever-shaped option must be answerable by its own selector');
  assert.equal(outcome[testese.selector], 'filled', 'a value-less Lever option must be answerable by its own selector');
  const groupSelectors = [GH, LEVER, LEVER_CB].flatMap(n => members(forms.fields, n)).map(f => f.selector);
  assert.deepEqual(fill.requiredNotFilled.filter(s => groupSelectors.includes(s)), [], 'an answered group still listed as required-not-filled');
  assert.deepEqual(fill.requiredGroupsNotFilled, []);
  assert.equal(fill.fields.find(f => f.selector === beta.selector).group, GH, 'a fill row names its group');
  const st = ats.state();
  assert.equal(st['question_3003[]_1'], true, 'Beta is ticked on the page');
  assert.equal(st[`${LEVER}=Yes`], true, 'Yes is chosen on the page');
  assert.equal(st[`${LEVER_CB}=Testese`], true, 'Testese is ticked on the page');
  assert.equal(st[`${LEVER_CB}=Fixtish`], false, 'and only Testese');
  assert.equal(st[`${LEVER_CB}=Mockian`], false, 'and only Testese');
});

test('fill: an unanswered required group is reported once, with its question', async () => {
  const forms = await describe('groups=1');
  const out = await run('groups_fill', { url: ats.url('greenhouse', 'groups=1'), fields: forms.fields, answers: {} });
  const fill = out.fill;
  assert.deepEqual(validateFillResult(fill, forms.fields), []);
  const byName = Object.fromEntries(fill.requiredGroupsNotFilled.map(g => [g.name, g]));
  assert.deepEqual(Object.keys(byName).sort(), [LEVER, LEVER_CB, GH].sort());
  assert.match(byName[GH].question, /Which fixture platforms/);
  assert.deepEqual(byName[GH].selectors, members(forms.fields, GH).map(f => f.selector));
  for (const f of [GH, LEVER, LEVER_CB].flatMap(n => members(forms.fields, n))) {
    assert.ok(fill.requiredNotFilled.includes(f.selector), `${f.selector} must stay in requiredNotFilled while its group is unanswered`);
  }
});
