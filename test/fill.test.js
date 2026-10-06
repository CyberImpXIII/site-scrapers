// Gates for the `fill_form` step and the `fill_application_form` generic
// action (PLAN-applications.md §3.2, §4 "Fill"). Everything runs offline
// against test/fixtures/ats/, through engine.js -- the same path ./scrape.sh
// takes for the applications repo.
//
// What is proven here, each by a run rather than by reading the code:
//   1. every described field gets exactly one outcome (filled/failed/unfilled),
//      none missing, none invented -- for EVERY ATS fixture registered;
//   2. a different answer map changes what lands in the form;
//   3. ZERO submit attempts (click on a submit control, submit event, Enter in
//      a field, POST to the form action) across every fill -- and a control run
//      that does click submit counts it, so the counter is known to be live;
//   4. a login or CAPTCHA wall stops the fill before anything is touched;
//   5. every output matches the contract (lib/fillContract.js), and the
//      contract matches the published doc (docs/fill-output.md) both ways;
//   6. answers never reach scrape_runs.params_json, only their keys.
//
// Uses only obviously fake values (example.invalid, "Fixturea Testperson").

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const { openDb, upsertSite, insertField, deleteSite } = require('../db');
const { authorizeForTests } = require('../lib/writeGuard');
const { startAtsServer, ATS_FIXTURES } = require('./fixtures/ats/server');
const { validateFillResult, REASONS, OUTCOMES, redactRunParams, verdictInputsFromFill } = require('../lib/fillContract');
const { formHash } = require('../lib/formHash');

const REPO_ROOT = path.join(__dirname, '..');
// The Greenhouse recipe's entry selector: type=button only, so an "Apply"
// that is really the submit control can never match.
const SAFE_ENTRY = 'button[type=button]::-p-text(Apply), a::-p-text(Apply)';
// open_apply_form's entry click, read from the export rather than copied, so
// the late-entry control below cannot drift from the real selector.
const OPEN_ENTRY_CLICK = (() => {
  const def = require('../lib/builtinActions').BUILTIN_ACTIONS.find(a => a.name === 'open_apply_form');
  const find = steps => steps.flatMap(s => (s.steps ? find(s.steps) : s.action === 'click' ? [s] : []));
  const clicks = find(def.steps);
  assert.equal(clicks.length, 1, 'open_apply_form should have exactly one click (its entry click)');
  return clicks[0];
})();
const OPEN_DEFAULT_SELECTOR = OPEN_ENTRY_CLICK.default_selector;
// The entry control of the late-entry test appears this long after the page
// script runs: past the old window (dismiss_overlay ~1.4s + settle 0.2s + 5s
// = ~6.6s), well inside the new one (~16.6s).
const LATE_ENTRY_MS = 9000;

let ats;
let db;
let tmp;
const createdSiteIds = [];
const siteIds = {};

function recipe(name, steps) {
  const id = upsertSite(db, {
    hostname: '127.0.0.1',
    page_type: 'action',
    recipe_name: name,
    status: 'working',
    nav_method: 'ui_steps',
    nav_template: JSON.stringify(steps),
    card_min_text_len: 1,
    ready_timeout_ms: 4000,
    notes: 'Test-only recipe for test/fill.test.js. Safe to delete if found stray.',
  });
  if (!createdSiteIds.includes(id)) createdSiteIds.push(id);
  siteIds[name] = id;
  insertField(db, id, { field_name: 'body', extract_kind: 'full_blob' }, 0);
}

async function run(name, params) {
  const args = ['engine.js', `127.0.0.1#action:${name}`, JSON.stringify({ noSession: true, noDiagnostics: true, ...params })];
  let stdout;
  try {
    ({ stdout } = await execFileAsync(process.execPath, args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  } catch (e) {
    stdout = e.stdout;
  }
  return JSON.parse(stdout);
}

async function describe(url) {
  const out = await run('fill_test_describe', { url });
  const forms = (out.diagnostics || []).find(d => d.kind === 'forms');
  assert.ok(forms && Array.isArray(forms.fields), `describe returned no forms probe: ${JSON.stringify(out).slice(0, 300)}`);
  return forms;
}

// Answer maps are keyed by the description's own selectors, looked up by
// something stable, so the escaped ones (#\34 033064002) are not hand-written.
function sel(fields, pred, what) {
  const f = fields.find(pred);
  assert.ok(f, `fixture field not described: ${what}`);
  return f.selector;
}

function answerMaps(fields) {
  const s = {
    first: sel(fields, f => f.selector === '#first_name', 'first_name'),
    last: sel(fields, f => f.selector === '#last_name', 'last_name'),
    email: sel(fields, f => f.selector === '#email', 'email'),
    phone: sel(fields, f => f.selector === '#phone', 'phone'),
    country: sel(fields, f => f.selector === '#country', 'country'),
    dial: sel(fields, f => f.selector === '#phone_country', 'phone country (abbreviated display)'),
    auth: sel(fields, f => f.selector === '#question_1001', 'work authorization'),
    gender: sel(fields, f => /^Gender/.test(f.label || ''), 'gender (numeric id)'),
    resume: sel(fields, f => f.selector === '#resume', 'resume'),
    cover: sel(fields, f => f.selector === '#cover_letter_text', 'cover letter'),
    source: sel(fields, f => f.selector === '#source', 'source'),
    privacy: sel(fields, f => f.name === 'question_2002[]', 'privacy checkbox (array id)'),
  };
  const fileA = path.join(tmp, 'fixture-resume-a.txt');
  const fileB = path.join(tmp, 'fixture-resume-b.txt');
  const A = {
    [s.first]: 'Fixturea',
    [s.last]: 'Testperson',
    [s.email]: 'fixture.a@example.invalid',
    [s.phone]: '5550100001',
    [s.country]: 'United States',
    [s.dial]: 'Fixtureland +99',
    [s.auth]: 'Yes',
    [s.gender]: 'Decline To Self Identify',
    [s.resume]: fileA,
    [s.cover]: 'Fake cover letter A, line one.\nLine two, still fake.',
    [s.source]: 'LinkedIn',
    [s.privacy]: true,
  };
  const B = {
    [s.first]: 'Fixtureb',
    [s.last]: 'Otherperson',
    [s.email]: 'fixture.b@example.invalid',
    [s.phone]: '5550100002',
    [s.country]: 'Canada',
    [s.dial]: 'Testonia +98',
    [s.auth]: 'No',
    [s.gender]: 'Non-binary',
    [s.resume]: fileB,
    [s.cover]: 'Fake cover letter B.',
    [s.source]: 'Referral',
    [s.privacy]: false,
  };
  return { s, A, B };
}

function assertContract(fill, fields) {
  assert.ok(fill, 'engine output has no top-level `fill`');
  assert.deepEqual(validateFillResult(fill, fields), [], 'fill output violates the contract');
}

test.before(async () => {
  authorizeForTests();
  ats = await startAtsServer();
  db = openDb();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fill-test-'));
  fs.writeFileSync(path.join(tmp, 'fixture-resume-a.txt'), 'FAKE RESUME A -- test fixture, not a real person.\n');
  fs.writeFileSync(path.join(tmp, 'fixture-resume-b.txt'), 'FAKE RESUME B -- test fixture, not a real person.\n');
  recipe('fill_test_describe', [{ action: 'goto', url: '{{url}}' }, { action: 'probe', kind: 'forms' }]);
  // The shape of the real Greenhouse recipe: open the form (safe entry
  // selector), then the generic action under test.
  recipe('fill_test_fill', [
    { action: 'goto', url: '{{url}}' },
    { action: 'run_generic_action', ref: 'open_apply_form', with: { entry_selector: SAFE_ENTRY, settle_ms: '200' } },
    { action: 'run_generic_action', ref: 'fill_application_form' },
  ]);
  // Same, with the bare step: isolates fill_form from open_apply_form.
  recipe('fill_test_step', [{ action: 'goto', url: '{{url}}' }, { action: 'fill_form', fields: '{{fields}}', answers: '{{answers}}' }]);
  // open_apply_form alone: with its DEFAULT entry selector, and with the
  // Greenhouse recipe's override.
  recipe('fill_test_open_default', [
    { action: 'goto', url: '{{url}}' },
    { action: 'run_generic_action', ref: 'open_apply_form', with: { settle_ms: '200' } },
  ]);
  recipe('fill_test_open_safe', [
    { action: 'goto', url: '{{url}}' },
    { action: 'run_generic_action', ref: 'open_apply_form', with: { entry_selector: SAFE_ENTRY, settle_ms: '200' } },
  ]);
  // CONTROL for the late-entry test: open_apply_form's click as it was before
  // 2026-10-03 -- same steps, the click's window left at stop_if_missing's 5s.
  recipe('fill_test_open_old_window', [
    { action: 'goto', url: '{{url}}' },
    { action: 'run_generic_action', ref: 'dismiss_overlay' },
    { action: 'wait', ms: 200 },
    { action: 'repeat', times: 1, steps: [{ action: 'click', selector: '{{entry_selector}}', default_selector: OPEN_DEFAULT_SELECTOR, stop_if_missing: true, timeout: 5000 }] },
    { action: 'wait', ms: 1500 },
  ]);
  // CONTROL: deliberately clicks submit, to prove the counter sees it.
  recipe('fill_test_control_submit', [{ action: 'goto', url: '{{url}}' }, { action: 'click', selector: '#submit_app' }, { action: 'wait', ms: 300 }]);
});

test.after(async () => {
  for (const id of createdSiteIds) deleteSite(db, id);
  await ats.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('the counter is live: a recipe that clicks submit is counted (control for every zero-submit assertion)', async () => {
  ats.reset();
  await run('fill_test_control_submit', { url: ats.url('greenhouse') });
  assert.ok(ats.counters.submitClick >= 1, `a real submit click was not counted: ${JSON.stringify(ats.counters)}`);
  assert.ok(ats.submits() >= 1);
});

for (const name of Object.keys(ATS_FIXTURES)) {
  test(`${name}: every described field gets exactly one outcome, answers land, and nothing submits`, async () => {
    ats.reset();
    const url = ats.url(name);
    const forms = await describe(url);
    assert.equal(forms.truncated, false, 'the fixture form must be described completely');
    assert.equal(forms.formHash, formHash(forms.fields), 'the probe and fill_form must hash the same way');
    const { s, A } = answerMaps(forms.fields);

    const out = await run('fill_test_fill', { url, fields: forms.fields, answers: A });
    const fill = out.fill;
    assertContract(fill, forms.fields);
    assert.equal(fill.status, 'done', JSON.stringify(fill).slice(0, 600));
    assert.equal(out.success, true);
    assert.equal(out.article, null, 'a fill drops the page text from its output');
    assert.equal(fill.formChanged, false, 'describing and filling the same page must hash the same');
    assert.equal(fill.navigatedDuringFill, false);
    assert.equal(fill.wallCheck, 'clear');

    const bySel = Object.fromEntries(fill.fields.map(f => [f.selector, f]));
    for (const k of Object.keys(A)) {
      assert.equal(bySel[k]?.outcome, 'filled', `${k}: ${JSON.stringify(bySel[k])}`);
    }
    // Every field NOT answered is accounted for with a reason, not skipped.
    for (const f of fill.fields.filter(x => !(x.selector in A))) {
      assert.equal(f.outcome, 'unfilled', JSON.stringify(f));
      assert.ok(['no_answer', 'not_user_fillable'].includes(f.reason), JSON.stringify(f));
    }
    assert.ok(fill.fields.some(f => f.reason === 'not_user_fillable'), 'the aria-hidden requiredInput mirrors must be reported, not dropped');
    assert.equal(fill.counts.failed, 0);
    assert.deepEqual(fill.requiredNotFilled, []);

    // What actually landed, as the page itself reports it.
    const st = ats.state();
    assert.ok(st, 'the fixture page reported no state');
    assert.equal(st.first_name, 'Fixturea');
    assert.equal(st.email, 'fixture.a@example.invalid');
    assert.equal(st.phone.replace(/\D/g, ''), '5550100001', 'phone reformatted by the widget, same digits');
    assert.equal(st.country, 'United States', 'exact option, not "United States Minor Outlying Islands" or the phone widget list');
    assert.equal(st.phone_country, '+99', 'the picker shows the dial code of the chosen option');
    assert.equal(bySel['#phone_country'].detail, 'the control shows an abbreviation of the chosen option');
    assert.equal(st.question_1001, 'Yes');
    assert.equal(st['4033064002'], 'Decline To Self Identify', 'a numeric id needs CSS.escape to resolve at all');
    assert.deepEqual(st.resume, ['fixture-resume-a.txt']);
    assert.equal(st.cover_letter_text, A[s.cover], 'a textarea keeps its newlines');
    assert.equal(st.source, '1');
    assert.equal(st['question_2002[]'], true);
    assert.equal(st.website_hp, '', 'the honeypot is never touched');

    assert.equal(ats.submits(), 0, `submit attempts during a dry fill: ${JSON.stringify(ats.counters)}`);
  });
}

test('an abbreviated value that was already shown before the choice is not proof it landed', async () => {
  // The abbreviation rule's failure path: the option click does nothing, and
  // "+99" -- part of "Fixtureland +99" -- was on screen from the start.
  const url = ats.url('greenhouse', 'dead=phone_country');
  const forms = await describe(url);
  const { s } = answerMaps(forms.fields);
  const out = await run('fill_test_fill', { url, fields: forms.fields, answers: { [s.dial]: 'Fixtureland +99' } });
  assertContract(out.fill, forms.fields);
  const f = out.fill.fields.find(x => x.selector === s.dial);
  assert.equal(`${f.outcome}:${f.reason}`, 'failed:value_did_not_stick', JSON.stringify(f));
  assert.equal(ats.submits(), 0);
});

test('a different answer map changes the filled values (the input matters)', async () => {
  const url = ats.url('greenhouse');
  const forms = await describe(url);
  const { A, B } = answerMaps(forms.fields);
  ats.reset();
  const outA = await run('fill_test_fill', { url, fields: forms.fields, answers: A });
  const stA = ats.state();
  ats.reset();
  const outB = await run('fill_test_fill', { url, fields: forms.fields, answers: B });
  const stB = ats.state();
  assertContract(outA.fill, forms.fields);
  assertContract(outB.fill, forms.fields);
  assert.equal(outB.fill.status, 'done');
  assert.equal(outB.fill.counts.failed, 0, JSON.stringify(outB.fill.fields.filter(f => f.outcome === 'failed')));
  for (const id of ['first_name', 'last_name', 'email', 'phone', 'country', 'phone_country', 'question_1001', '4033064002', 'resume', 'cover_letter_text', 'source', 'question_2002[]']) {
    assert.notDeepEqual(stA[id], stB[id], `${id} did not change between answer maps`);
  }
  assert.equal(stB.first_name, 'Fixtureb');
  assert.equal(stB.country, 'Canada');
  assert.equal(stB['question_2002[]'], false);
  assert.equal(ats.submits(), 0);
});

test('a submit control labelled "Apply" is never clicked by the fill path', async () => {
  // The default open_apply_form selector matches text "Apply" -- here the
  // only such control IS the submit. The recipe's type=button selector must
  // find nothing, and the fill must not submit either.
  ats.reset();
  const url = ats.url('greenhouse', 'submit_text=Apply');
  const forms = await describe(url);
  const { A } = answerMaps(forms.fields);
  ats.reset();
  const out = await run('fill_test_fill', { url, fields: forms.fields, answers: A });
  assertContract(out.fill, forms.fields);
  assert.equal(out.fill.status, 'done');
  assert.equal(ats.submits(), 0, JSON.stringify(ats.counters));
});

// open_apply_form's DEFAULT entry selector (no entry_selector passed). It used
// to be `button::-p-text(Apply)`, which matches a submit control whose text is
// "Apply". Every submit shape below submits the form when clicked, and the
// page counts it; with no entry control on the page the default must find
// NOTHING (the step is optional), not fall back to the submit.
for (const submit of ['typed', 'untyped', 'form_attr']) {
  test(`open_apply_form's default entry selector never clicks a submit control (${submit} submit reading "Apply")`, async () => {
    ats.reset();
    const out = await run('fill_test_open_default', { url: ats.url('greenhouse', `submit_text=Apply&submit=${submit}&entry=none`) });
    assert.equal(out.success, true, JSON.stringify(out).slice(0, 400));
    assert.equal(ats.submits(), 0, `the default entry selector submitted the form: ${JSON.stringify(ats.counters)}`);
    assert.equal(ats.counters.entryClick, 0);
  });
}

// ...and it still finds a real entry control, in each shape seen live, even
// when the submit control ALSO reads "Apply" (the worst case: both match the
// text, only one is safe).
for (const entry of ['typed', 'untyped', 'link']) {
  test(`open_apply_form's default entry selector still clicks an Apply entry control (${entry})`, async () => {
    ats.reset();
    const out = await run('fill_test_open_default', { url: ats.url('greenhouse', `submit_text=Apply&submit=untyped&entry=${entry}`) });
    assert.equal(out.success, true, JSON.stringify(out).slice(0, 400));
    assert.equal(ats.counters.entryClick, 1, `the entry control was not clicked: ${JSON.stringify(ats.counters)}`);
    assert.equal(ats.submits(), 0, JSON.stringify(ats.counters));
  });
}

// The entry click's WINDOW. A miss is silent (the click is optional), so on a
// board whose Apply control renders late, describe runs on the posting page and
// reports 0 fields with success:true. Live Lever 2026-10-03: the link appeared
// 4.5-4.9s into the old 5s window on 2 runs and missed it on 1. The fixture's
// control renders LATE_ENTRY_MS after load: the real action must click it, and
// the same click with the old 5s window must not (control: the delay is real,
// so the pass is the timeout's doing and not a fast page).
test(`open_apply_form waits long enough for a late entry control (appears after ${LATE_ENTRY_MS}ms)`, async () => {
  for (const entry of ['typed', 'untyped', 'link']) {
    const url = ats.url('greenhouse', `submit_text=Apply&submit=untyped&entry=${entry}&entry_delay_ms=${LATE_ENTRY_MS}`);
    ats.reset();
    const old = await run('fill_test_open_old_window', { url });
    assert.equal(old.success, true, JSON.stringify(old).slice(0, 400));
    assert.equal(ats.counters.entryClick, 0, `${entry}: the CONTROL (old 5s window) clicked the late entry, so the fixture is not late enough to prove anything`);
    ats.reset();
    const out = await run('fill_test_open_default', { url });
    assert.equal(out.success, true, JSON.stringify(out).slice(0, 400));
    assert.equal(ats.counters.entryClick, 1, `${entry}: the late entry control was not clicked: ${JSON.stringify(ats.counters)}`);
    assert.equal(ats.submits(), 0, JSON.stringify(ats.counters));
  }
  // Behaviour first (above), so on a short window the failure names the miss.
  assert.ok(Number(OPEN_ENTRY_CLICK.timeout) >= 15000, `entry click timeout is ${OPEN_ENTRY_CLICK.timeout}; a late Apply is missed silently`);
});

test('the late-entry fixture renders its control only after the delay (fixture self-check)', async () => {
  const res = await fetch(ats.url('greenhouse', `entry=typed&entry_delay_ms=${LATE_ENTRY_MS}`));
  const html = await res.text();
  assert.ok(!/<button[^>]*data-entry/.test(html), 'the entry control is in the served HTML, so it is not late');
  assert.match(html, /late-entry/);
  assert.equal((await fetch(ats.url('greenhouse', 'entry=none&entry_delay_ms=100'))).status, 404, 'nothing to delay must be an error, not a silent pass');
});

test('the Greenhouse override (type=button / a) still clicks the entry and never the submit', async () => {
  for (const q of ['', 'submit_text=Apply&entry=typed']) {
    ats.reset();
    const out = await run('fill_test_open_safe', { url: ats.url('greenhouse', q) });
    assert.equal(out.success, true, JSON.stringify(out).slice(0, 400));
    assert.equal(ats.counters.entryClick, 1, `${q || 'default page'}: ${JSON.stringify(ats.counters)}`);
    assert.equal(ats.submits(), 0, `${q || 'default page'}: ${JSON.stringify(ats.counters)}`);
  }
});

for (const wall of ['captcha', 'login']) {
  test(`a ${wall} wall stops the fill before anything is touched (blocked-attn)`, async () => {
    const clean = await describe(ats.url('greenhouse'));
    const { A } = answerMaps(clean.fields);
    ats.reset();
    const out = await run('fill_test_step', { url: ats.url('greenhouse', `wall=${wall}`), fields: clean.fields, answers: A });
    const fill = out.fill;
    assertContract(fill, clean.fields);
    assert.equal(fill.status, 'blocked-attn');
    assert.equal(fill.wall.phase, 'before');
    assert.ok(fill.wall.signals.length > 0);
    assert.equal(out.success, false);
    assert.ok(fill.fields.every(f => f.outcome === 'unfilled' && f.reason === 'blocked_by_wall'));
    assert.equal(ats.state(), null, 'the page saw input on a walled form');
    assert.equal(ats.submits(), 0);
    const v = verdictInputsFromFill(fill);
    assert.equal(v.extracted, false);
    assert.deepEqual(v.wall, fill.wall.signals, 'verify.js must read this as a wall, not a broken recipe');
  });
}

test('bad answers fail by name, never by typing something dangerous', async () => {
  const url = ats.url('greenhouse');
  const forms = await describe(url);
  const { s } = answerMaps(forms.fields);
  const hp = sel(forms.fields, f => f.selector === '#website_hp', 'honeypot');
  const answers = {
    [s.first]: 'Fixture\nEnter would submit',
    [s.last]: 42,
    [s.phone]: '5'.repeat(31),
    [s.country]: 'United',
    [s.auth]: true,
    [s.resume]: path.join(tmp, 'no-such-file.pdf'),
    [s.source]: 'Carrier pigeon',
    [s.gender]: 'Fixture gender',
    [s.privacy]: 'yes',
    [hp]: 'bot bait',
    '#not_on_this_form': 'x',
  };
  ats.reset();
  const out = await run('fill_test_step', { url, fields: forms.fields, answers });
  const fill = out.fill;
  assertContract(fill, forms.fields);
  const r = Object.fromEntries(fill.fields.map(f => [f.selector, `${f.outcome}:${f.reason}`]));
  assert.equal(r[s.first], 'failed:multiline_in_single_line');
  assert.equal(r[s.last], 'filled:null', 'a number is a valid text answer');
  assert.equal(r[s.phone], 'failed:exceeds_maxlength');
  assert.equal(r[s.country], 'failed:no_matching_option', 'a prefix is not an exact option');
  assert.equal(r[s.auth], 'failed:answer_type_mismatch');
  assert.equal(r[s.resume], 'failed:file_not_found');
  assert.equal(r[s.source], 'failed:no_matching_option');
  assert.equal(r[s.gender], 'failed:no_matching_option', 'a made-up answer no option contains');
  // The detail tells "options were offered, none exact" (and lists them: the
  // caller corrects its answer from them) apart from "the control's own filter
  // offered nothing for that text". Live 2026-10-05: an applications dry fill
  // with made-up answers read "0 options offered" on every combobox as a
  // regression in option reading; it was the site's filter rejecting the text.
  const d = Object.fromEntries(fill.fields.map(f => [f.selector, f.detail || '']));
  assert.match(d[s.country], /^3 options offered, none matches exactly: United States \| United States Minor Outlying Islands \| United Kingdom$/, d[s.country]);
  assert.match(d[s.gender], /offered no options for the typed answer/, d[s.gender]);
  assert.ok(!/options offered|none matches exactly/.test(d[s.gender]), `an empty list must not read as offered options: ${d[s.gender]}`);
  assert.equal(r[s.privacy], 'failed:answer_type_mismatch');
  assert.equal(r[hp], 'failed:hidden_control');
  assert.deepEqual(fill.unknownAnswerKeys, ['#not_on_this_form']);
  assert.equal(out.success, true, 'a done fill with failures is still a completed run');
  assert.equal(verdictInputsFromFill(fill).extracted, false, 'but it does not earn "working"');
  const st = ats.state() || {};
  assert.ok(!st.first_name, 'the multi-line answer must not have been typed at all');
  assert.equal(st.country || '', '', 'no option was chosen');
  assert.equal(ats.counters.enterKey, 0);
  assert.equal(ats.submits(), 0, JSON.stringify(ats.counters));
  // Details never echo an answer.
  const json = JSON.stringify(fill);
  for (const v of ['Enter would submit', 'Carrier pigeon', 'Fixture gender', 'bot bait']) assert.ok(!json.includes(v), `output echoes an answer: ${v}`);
});

test('a description that no longer matches the page is flagged formChanged', async () => {
  const url = ats.url('greenhouse');
  const forms = await describe(url);
  const stale = forms.fields.map(f => (f.selector === '#first_name' ? { ...f, label: 'Given name*' } : f));
  const out = await run('fill_test_step', { url, fields: stale, answers: {} });
  assertContract(out.fill, stale);
  assert.equal(out.fill.formChanged, true);
  assert.notEqual(out.fill.formHash, out.fill.descriptionHash);
  assert.ok(out.fill.fields.every(f => f.outcome === 'unfilled'), 'an empty answer map fills nothing');
  assert.ok(out.fill.requiredNotFilled.includes('#first_name'));
});

test('missing inputs are an error with every field still accounted for', async () => {
  const forms = await describe(ats.url('greenhouse'));
  const out = await run('fill_test_step', { url: ats.url('greenhouse'), fields: forms.fields, answers: 'not an object' });
  assertContract(out.fill, forms.fields);
  assert.equal(out.fill.status, 'error');
  assert.ok(out.fill.fields.every(f => f.reason === 'not_attempted'));
  const none = await run('fill_test_step', { url: ats.url('greenhouse'), answers: {} });
  assertContract(none.fill);
  assert.equal(none.fill.status, 'error');
  assert.equal(none.success, false);
});

test('answers never reach scrape_runs: only their keys are logged', async () => {
  const url = ats.url('greenhouse');
  const forms = await describe(url);
  const { A } = answerMaps(forms.fields);
  // Through `@file`, the documented way to pass answers (docs/fill-output.md).
  const pfile = path.join(tmp, 'params.json');
  fs.writeFileSync(pfile, JSON.stringify({ noSession: true, noDiagnostics: true, url, fields: forms.fields, answers: A }));
  let stdout;
  try {
    ({ stdout } = await execFileAsync(process.execPath, ['engine.js', '127.0.0.1#action:fill_test_step', `@${pfile}`], { cwd: REPO_ROOT, encoding: 'utf8' }));
  } catch (e) {
    stdout = e.stdout;
  }
  assert.equal(JSON.parse(stdout).fill?.status, 'done', 'params from @file did not reach the fill');
  const row = db
    .prepare('SELECT params_json FROM scrape_runs WHERE site_id = ? ORDER BY id DESC LIMIT 1')
    .get(siteIds.fill_test_step);
  assert.ok(row, 'the run was not logged');
  for (const v of ['Fixturea', 'fixture.a@example.invalid', '5550100001', 'Fake cover letter A']) {
    assert.ok(!row.params_json.includes(v), `scrape_runs.params_json holds an answer value: ${v}`);
  }
  const logged = JSON.parse(row.params_json);
  assert.equal(logged.answers.redacted, true);
  assert.deepEqual(logged.answers.keys.sort(), Object.keys(A).sort());
  assert.deepEqual(logged.fields, { count: forms.fields.length });
  assert.deepEqual(redactRunParams({ answers: '{"#a":"secret"}' }).answers, { redacted: true, keys: ['#a'] });
});

// verify.js reads params from @file too (since 2026-10-06; inline only before,
// so a fill verify put answers on argv), and its fill report carries the two
// facts that say nothing was sent. Before, the dry-run proof needed a second
// scrape.sh run.
test('verify.js takes a fill by @file and reports dryRun and navigatedDuringFill', async () => {
  const url = ats.url('greenhouse');
  const forms = await describe(url);
  const { A } = answerMaps(forms.fields);
  const pfile = path.join(tmp, 'verify-params.json');
  fs.writeFileSync(pfile, JSON.stringify({ noSession: true, noDiagnostics: true, url, fields: forms.fields, answers: A }));
  ats.reset();
  let stdout;
  try {
    ({ stdout } = await execFileAsync(process.execPath, ['verify.js', '127.0.0.1#action:fill_test_fill', `@${pfile}`, '--dry'], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  } catch (e) {
    stdout = e.stdout;
  }
  const v = JSON.parse(stdout);
  assert.equal(v.fill?.status, 'done', JSON.stringify(v).slice(0, 600));
  assert.equal(v.fill.dryRun, true);
  assert.equal(v.fill.navigatedDuringFill, false);
  assert.equal(v.verdict, 'working');
  assert.equal(ats.state().first_name, 'Fixturea', 'the answers from the file reached the page');
  assert.ok(!stdout.includes('fixture.a@example.invalid'), 'verify.js output must not echo an answer value');
  assert.equal(ats.submits(), 0);
});

test('formHash covers structure, not state: hasValue and placeholder do not change it', () => {
  const f = [{ selector: '#a', tag: 'input', type: 'text', name: 'a', label: 'A', required: true, role: null, ariaHidden: false, hasValue: false, placeholder: 'x' }];
  assert.equal(formHash(f), formHash([{ ...f[0], hasValue: true, placeholder: 'y' }]));
  assert.notEqual(formHash(f), formHash([{ ...f[0], required: false }]));
  assert.notEqual(formHash(f), formHash([{ ...f[0], label: 'B' }]));
  assert.match(formHash(f), /^[0-9a-f]{16}$/);
});

test('formHash ignores CAPTCHA response fields, so a stored description that has one matches a live read that does not', () => {
  const f = [{ selector: '#a', tag: 'input', type: 'text', name: 'a', label: 'A', required: true, role: null, ariaHidden: false }];
  const cap = { selector: '#g-recaptcha-response-100000', tag: 'textarea', type: 'textarea', name: 'g-recaptcha-response', label: null, required: false, role: null, ariaHidden: false };
  assert.equal(formHash([...f, cap]), formHash(f));
  assert.equal(formHash([...f, { ...cap, name: null }]), formHash(f), 'matched by the id alone (suffixed widget id)');
  assert.equal(formHash([...f, { ...cap, selector: 'textarea[name="h-captcha-response"]', name: 'h-captcha-response' }]), formHash(f));
  // Control: an ordinary late field is still a change.
  assert.notEqual(formHash([...f, { ...cap, selector: '#notes', name: 'notes' }]), formHash(f));
});

test('forms probe: a late reCAPTCHA textarea neither changes formHash nor appears as a field, and is counted', async () => {
  const without = await describe(ats.url('greenhouse'));
  const withCap = await describe(ats.url('greenhouse', 'captcha=1'));
  // Control: the textarea really was on the page the second time.
  assert.equal(withCap.captchaFieldsExcluded, 1);
  assert.equal(without.captchaFieldsExcluded, 0);
  assert.equal(withCap.formHash, without.formHash);
  assert.ok(!withCap.fields.some(f => /recaptcha/i.test(f.selector || '')), 'the captcha field must not be offered for filling');
  // fill_form's live read takes the same path: no formChanged, nothing undescribed.
  const out = await run('fill_test_fill', { url: ats.url('greenhouse', 'captcha=1'), fields: without.fields, answers: {} });
  assert.equal(out.fill.formChanged, false, JSON.stringify(out.fill).slice(0, 400));
  assert.deepEqual(out.fill.undescribedFields, []);
});

test('forms probe: a file input in a role=group takes the group label and its aria-required (live Greenhouse markup)', async () => {
  const forms = await describe(ats.url('greenhouse'));
  const resume = forms.fields.find(f => f.selector === '#resume');
  assert.ok(resume, 'resume not described');
  assert.equal(resume.label, 'Resume/CV*', 'not the hidden "Attach" of its button');
  assert.equal(resume.required, true);
  assert.equal(resume.requiredEvidence, 'group aria-required');
});

// --- the published contract (docs/fill-output.md) ---------------------------

const DOC = path.join(REPO_ROOT, 'docs', 'fill-output.md');

test('docs/fill-output.md lists exactly the reason codes the code emits, with the right outcome', () => {
  const text = fs.readFileSync(DOC, 'utf8');
  const documented = [...text.matchAll(/^\|\s*`([a-z_]+)`\s*\|\s*(filled|failed|unfilled)\s*\|/gm)].map(m => `${m[2]}:${m[1]}`).sort();
  const implemented = Object.entries(REASONS).flatMap(([o, rs]) => rs.map(r => `${o}:${r}`)).sort();
  assert.deepEqual(documented, implemented, 'doc reason table and lib/fillContract.js REASONS disagree');
  for (const o of OUTCOMES) assert.ok(text.includes(`\`${o}\``), `outcome ${o} undocumented`);
});

test('the example output in docs/fill-output.md passes the contract validator', () => {
  const text = fs.readFileSync(DOC, 'utf8');
  const blocks = [...text.matchAll(/```json\n([\s\S]*?)```/g)].map(m => JSON.parse(m[1]));
  const fills = blocks.filter(b => b.kind === 'fill');
  assert.ok(fills.length >= 2, 'the doc must show a done example and a blocked-attn example');
  for (const b of fills) assert.deepEqual(validateFillResult(b), [], `doc example invalid: ${JSON.stringify(b).slice(0, 120)}`);
  assert.ok(fills.some(b => b.status === 'blocked-attn'));
});
