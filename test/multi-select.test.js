// Gates for controls that take SEVERAL options: a react-select isMulti
// combobox and a native <select multiple> (TODO.md "Multi-select comboboxes
// unsupported", done 2026-10-04). Offline, against test/fixtures/ats ?multi=.
//
// The seam is lib/multiSelect.js: the forms probe reports `multiple` from it
// and fill_form accepts a list answer only where it says so. Proven here:
//   1. describe marks exactly the multi controls `multiple: true`;
//   2. a list answer lands as that SET (the page's own state), and a different
//      list lands differently -- the input changes the output;
//   3. the answer is the whole set: a native multi-select is left holding
//      exactly the answer; a combobox holding an option NOT in the answer is
//      refused before anything is touched (removing a chip is not supported);
//   4. a list for a single-option control fails answer_type_mismatch and
//      chooses nothing; a one-element list is just that option;
//   5. one unmatched entry: a native select changes nothing; a combobox says
//      how many were chosen before it failed (they stay, and the page shows it);
//   6. [] is no_answer; a repeated option is chosen once;
//   7. every output passes the contract and nothing submits.

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

const REPO_ROOT = path.join(__dirname, '..');
const HOST = 'multi-select.internal';
const TOOLS = '#question_4004';
const LANGS = '#languages';

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
    notes: 'Test-only recipe for test/multi-select.test.js. Safe to delete if found stray.',
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
  const out = await run('multi_describe', { url: ats.url('greenhouse', query) });
  const forms = (out.diagnostics || []).find(d => d.kind === 'forms');
  assert.ok(forms && Array.isArray(forms.fields), `describe returned no forms probe: ${JSON.stringify(out).slice(0, 300)}`);
  return forms;
}

// Fill with `answers`; returns {fill, by: selector -> "outcome:reason", st: page state}.
async function fill(query, answers) {
  const forms = await describe(query);
  ats.reset();
  const out = await run('multi_fill', { url: ats.url('greenhouse', query), fields: forms.fields, answers });
  assert.ok(out.fill, `no fill in output: ${JSON.stringify(out).slice(0, 300)}`);
  assert.deepEqual(validateFillResult(out.fill, forms.fields), [], 'fill output violates the contract');
  assert.equal(ats.submits(), 0, `submit attempts: ${JSON.stringify(ats.counters)}`);
  const by = Object.fromEntries(out.fill.fields.map(f => [f.selector, `${f.outcome}:${f.reason}`]));
  const detail = Object.fromEntries(out.fill.fields.map(f => [f.selector, f.detail]));
  return { fill: out.fill, by, detail, st: ats.state() || {} };
}

test.before(async () => {
  authorizeForTests();
  ats = await startAtsServer();
  db = openDb();
  recipe('multi_describe', [{ action: 'goto', url: '{{url}}' }, { action: 'probe', kind: 'forms' }]);
  recipe('multi_fill', [{ action: 'goto', url: '{{url}}' }, { action: 'fill_form', fields: '{{fields}}', answers: '{{answers}}' }]);
});

test.after(async () => {
  for (const id of created) deleteSite(db, id);
  await ats.close();
});

test('describe marks exactly the controls that take several options', async () => {
  const forms = await describe('multi=1');
  const m = Object.fromEntries(forms.fields.map(f => [f.selector, f.multiple]));
  assert.equal(m[TOOLS], true, 'react-select isMulti combobox');
  assert.equal(m[LANGS], true, '<select multiple>');
  for (const s of ['#country', '#question_1001', '#source', '#first_name']) assert.equal(m[s], false, `${s} takes one value`);
  assert.ok(forms.fields.every(f => typeof f.multiple === 'boolean'), 'every field carries a boolean `multiple`');
});

test('a list answer lands as that set, and a different list lands differently', async () => {
  const a = await fill('multi=1', { [TOOLS]: ['Saw', 'Hammer'], [LANGS]: ['English', 'Testese'] });
  assert.equal(a.by[TOOLS], 'filled:null', a.detail[TOOLS]);
  assert.equal(a.by[LANGS], 'filled:null', a.detail[LANGS]);
  assert.deepEqual(a.st.question_4004, ['Saw', 'Hammer'], 'exactly the answered options: not "Saw blade"');
  assert.deepEqual(a.st.languages, ['en', 'ts'], 'the answer is the whole set: the preselected Fixtish is deselected');
  const b = await fill('multi=1', { [TOOLS]: ['Saw blade', 'Level'], [LANGS]: ['mk'] });
  assert.equal(b.by[TOOLS], 'filled:null', b.detail[TOOLS]);
  assert.equal(b.by[LANGS], 'filled:null', b.detail[LANGS]);
  assert.deepEqual(b.st.question_4004, ['Saw blade', 'Level']);
  assert.deepEqual(b.st.languages, ['mk'], 'an option value is accepted as for a single <select>');
});

test('an option chosen before the fill and not in the answer is refused before anything is touched', async () => {
  const r = await fill('multi=pre', { [TOOLS]: ['Hammer'] });
  assert.equal(r.by[TOOLS], 'failed:unsupported_control', r.detail[TOOLS]);
  assert.equal(r.st.question_4004, undefined, 'the page saw no input at all');
  // Control: the same preselected option IS in the answer -> kept, the rest added.
  const ok = await fill('multi=pre', { [TOOLS]: ['Level', 'Saw'] });
  assert.equal(ok.by[TOOLS], 'filled:null', ok.detail[TOOLS]);
  assert.deepEqual(ok.st.question_4004, ['Level', 'Saw']);
});

test('a list for a single-option control chooses nothing; a one-element list is that option', async () => {
  const r = await fill('multi=1', { '#country': ['Canada', 'United Kingdom'], '#source': ['LinkedIn', 'Referral'] });
  assert.equal(r.by['#country'], 'failed:answer_type_mismatch');
  assert.equal(r.by['#source'], 'failed:answer_type_mismatch');
  assert.equal(r.st.country || '', '', 'no option was chosen');
  assert.equal(r.st.source || '', '', 'no option was selected');
  const one = await fill('multi=1', { '#country': ['Canada'], '#source': ['Referral'] });
  assert.equal(one.by['#country'], 'filled:null');
  assert.equal(one.by['#source'], 'filled:null');
  assert.equal(one.st.country, 'Canada');
  assert.equal(one.st.source, '3');
});

test('one unmatched entry: the native select changes nothing; the combobox says what stayed chosen', async () => {
  const r = await fill('multi=1', { [LANGS]: ['English', 'Klingon'], [TOOLS]: ['Hammer', 'Sa'] });
  assert.equal(r.by[LANGS], 'failed:no_matching_option', r.detail[LANGS]);
  assert.equal(r.by[TOOLS], 'failed:no_matching_option', r.detail[TOOLS]);
  assert.match(r.detail[TOOLS], /1 option\(s\) chosen before this one stay chosen/);
  assert.deepEqual(r.st.question_4004, ['Hammer'], 'what the detail says is what the page shows');
  assert.ok(!r.st.languages || r.st.languages.join() === 'fx', `the native select was changed: ${JSON.stringify(r.st.languages)}`);
  const json = JSON.stringify(r.fill);
  assert.ok(!json.includes('Klingon'), 'a detail echoes an answer');
});

test('an empty list is no_answer; a repeated option is chosen once', async () => {
  const r = await fill('multi=1', { [TOOLS]: [], [LANGS]: ['Testese', 'testese'] });
  assert.equal(r.by[TOOLS], 'unfilled:no_answer');
  assert.equal(r.by[LANGS], 'filled:null');
  assert.deepEqual(r.st.languages, ['ts']);
  const d = await fill('multi=1', { [TOOLS]: ['Saw', ' saw '] });
  assert.equal(d.by[TOOLS], 'filled:null', d.detail[TOOLS]);
  assert.deepEqual(d.st.question_4004, ['Saw']);
});
