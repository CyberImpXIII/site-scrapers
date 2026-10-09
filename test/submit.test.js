// Run by ./dev.sh check (the suite), the gate gates.json names for this file.
// Gates for the `submit_form` step and the `submit_application_form` generic
// action (PLAN-applications.md §3.5, §4 "Submit", §12.2 step 3). Everything
// runs offline against test/fixtures/ats/ (loopback only), through engine.js --
// the path ./scrape.sh takes for the applications repo.
//
// Each test name starts with the gate it proves, in brackets. Every gate has a
// refusing run AND a run where only that input differs and the outcome moves,
// so a gate that refuses everything (or nothing) cannot pass. Every refusal
// asserts ZERO submit attempts at the fixture (click on a submit control,
// submit event, Enter, POST to /apply); the positive runs prove that counter
// is live by counting exactly one of each.
//
// Uses only obviously fake values (example.invalid, "Fixturea Testperson").

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const { openDb, upsertSite, insertField, deleteSite } = require('../db');
const { authorizeForTests } = require('../lib/writeGuard');
const { startAtsServer } = require('./fixtures/ats/server');
const {
  CONTRACT,
  REASONS,
  STATUSES,
  CLICKED_STATUSES,
  APPROVAL_MAX_MS,
  submissionHash,
  checkApproval,
  validateSubmitResult,
} = require('../lib/submitContract');
const { LIVE_SUBMIT_HOSTS, isSubmitHostArmed, submitStepProblem, stepsSubmit, fillVerdict } = require('../lib/submitForm');
const ledger = require('../lib/submitLedger');

const REPO_ROOT = path.join(__dirname, '..');
const SAFE_ENTRY = 'button[type=button]::-p-text(Apply), a::-p-text(Apply)';
// The Greenhouse recipe's outcome signals (unverified live: TODO.md).
const SIGNALS = { confirm_text: 'Thank you for applying', confirm_url_includes: '/confirmation', error_selector: '[role=alert], .error' };

let ats;
let db;
let tmp;
let ledgerDir;
const createdSiteIds = [];

function recipe(name, steps, extra = {}) {
  const id = upsertSite(db, {
    ...extra,
    hostname: '127.0.0.1',
    page_type: 'action',
    recipe_name: name,
    status: 'working',
    nav_method: 'ui_steps',
    nav_template: JSON.stringify(steps),
    card_min_text_len: 1,
    ready_timeout_ms: 4000,
    notes: 'Test-only recipe for test/submit.test.js. Safe to delete if found stray.',
  });
  if (!createdSiteIds.includes(id)) createdSiteIds.push(id);
  insertField(db, id, { field_name: 'body', extract_kind: 'full_blob' }, 0);
}

async function run(name, params, env = {}) {
  const args = ['engine.js', `127.0.0.1#action:${name}`, JSON.stringify({ noSession: true, noDiagnostics: true, ...params })];
  let stdout;
  try {
    ({ stdout } = await execFileAsync(process.execPath, args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, SS_SUBMIT_LEDGER_DIR: ledgerDir, ...env },
    }));
  } catch (e) {
    stdout = e.stdout;
  }
  return { out: JSON.parse(stdout), stdout };
}

const describeCache = new Map();
async function describe(url) {
  if (describeCache.has(url)) return describeCache.get(url);
  const { out } = await run('submit_test_describe', { url });
  const forms = (out.diagnostics || []).find(d => d.kind === 'forms');
  assert.ok(forms && Array.isArray(forms.fields), `describe returned no forms probe: ${JSON.stringify(out).slice(0, 300)}`);
  describeCache.set(url, forms.fields);
  return forms.fields;
}

function sel(fields, pred, what) {
  const f = fields.find(pred);
  assert.ok(f, `fixture field not described: ${what}`);
  return f.selector;
}

// Every required question answered, so the fill verdict passes.
function answers(fields, variant = 'a') {
  const a = variant === 'a';
  return {
    [sel(fields, f => f.selector === '#first_name', 'first_name')]: a ? 'Fixturea' : 'Fixtureb',
    [sel(fields, f => f.selector === '#last_name', 'last_name')]: 'Testperson',
    [sel(fields, f => f.selector === '#email', 'email')]: a ? 'fixture.a@example.invalid' : 'fixture.b@example.invalid',
    [sel(fields, f => f.selector === '#phone', 'phone')]: '5550100001',
    [sel(fields, f => f.selector === '#country', 'country')]: 'United States',
    [sel(fields, f => f.selector === '#question_1001', 'work authorization')]: 'Yes',
    [sel(fields, f => /^Gender/.test(f.label || ''), 'gender')]: 'Decline To Self Identify',
    [sel(fields, f => f.selector === '#resume', 'resume')]: path.join(tmp, 'fixture-resume-a.txt'),
    [sel(fields, f => f.selector === '#source', 'source')]: 'LinkedIn',
    [sel(fields, f => f.name === 'question_2002[]', 'privacy checkbox')]: true,
  };
}

function newBatchId() {
  return `b-${crypto.randomBytes(8).toString('hex')}`;
}

// What applications' approve step produces (docs/submit-output.md).
function approval(entries, { at = Date.now(), lifeMs = 60 * 60 * 1000, batchId = newBatchId() } = {}) {
  return {
    batchId,
    approvedAt: new Date(at).toISOString(),
    expiresAt: new Date(at + lifeMs).toISOString(),
    submissions: entries.map(([packetId, hash]) => ({ packetId, submissionHash: hash })),
  };
}

// A complete, approved submission for `url`, ready to run.
async function prepared(url, { variant = 'a', packetId = 'pkt-0001', approvalOpts = {} } = {}) {
  const fields = await describe(url);
  const ans = answers(fields, variant);
  const h = submissionHash({ url, fields, answers: ans });
  assert.ok(!h.error, h.error);
  return { url, fields, answers: ans, packetId, hash: h.hash, approval: approval([[packetId, h.hash]], approvalOpts) };
}

async function submit(p, { recipeName = 'submit_test_action', extra = {}, env = {} } = {}) {
  const { out, stdout } = await run(recipeName, { url: p.url, fields: p.fields, answers: p.answers, packetId: p.packetId, approval: p.approval, ...extra }, env);
  return { out, s: out.submit, stdout };
}

function assertValid(s) {
  assert.ok(s, 'the engine output has no top-level `submit`');
  assert.deepEqual(validateSubmitResult(s), [], `submit output violates the contract: ${JSON.stringify(s).slice(0, 500)}`);
}

function assertRefusedNoSubmit(out, status, reason) {
  assertValid(out.submit);
  assert.equal(`${out.submit.status}/${out.submit.reason}`, `${status}/${reason}`, JSON.stringify(out.submit).slice(0, 600));
  assert.equal(out.submit.clicked, false);
  assert.equal(out.submit.submitClicks, 0);
  assert.equal(out.success, false, 'a refused submit is never success');
  assert.equal(ats.submits(), 0, `submit attempts on a refusal: ${JSON.stringify(ats.counters)}`);
}

test.before(async () => {
  authorizeForTests();
  ats = await startAtsServer();
  db = openDb();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'submit-test-'));
  ledgerDir = path.join(tmp, 'ledger');
  fs.writeFileSync(path.join(tmp, 'fixture-resume-a.txt'), 'FAKE RESUME A -- test fixture, not a real person.\n');
  fs.writeFileSync(path.join(tmp, 'fixture-resume-b.txt'), 'FAKE RESUME B -- test fixture, not a real person.\n');
  recipe('submit_test_describe', [{ action: 'goto', url: '{{url}}' }, { action: 'probe', kind: 'forms' }]);
  // The shape of the real Greenhouse recipe: open the form, then the action.
  recipe('submit_test_action', [
    { action: 'goto', url: '{{url}}' },
    { action: 'run_generic_action', ref: 'open_apply_form', with: { entry_selector: SAFE_ENTRY, settle_ms: '200' } },
    { action: 'run_generic_action', ref: 'submit_application_form', with: { ...SIGNALS, outcome_timeout_ms: '4000' } },
  ]);
  // The bare step with the same signals: isolates submit_form from the action.
  // It declares params and probe values, so the live audits WOULD run it but for the submit guard.
  recipe(
    'submit_test_bare',
    [
      { action: 'goto', url: '{{url}}' },
      {
        action: 'submit_form', fields: '{{fields}}', answers: '{{answers}}', approval: '{{approval}}', packet_id: '{{packetId}}', url: '{{url}}',
        confirm_text: SIGNALS.confirm_text, confirm_url_includes: SIGNALS.confirm_url_includes, error_selector: SIGNALS.error_selector, outcome_timeout_ms: '4000',
      },
    ],
    { nav_params_schema: JSON.stringify({ url: 'string' }), param_probe_values: JSON.stringify([{ url: 'http://127.0.0.1:9/a' }, { url: 'http://127.0.0.1:9/b' }]) }
  );
  // A control for the guards: the same shape, no submit.
  recipe('submit_test_nosubmit', [{ action: 'goto', url: '{{url}}' }, { action: 'probe', kind: 'forms' }], {
    nav_params_schema: JSON.stringify({ url: 'string' }),
    param_probe_values: JSON.stringify([{ url: 'http://127.0.0.1:9/a' }, { url: 'http://127.0.0.1:9/b' }]),
  });
  // The bare step, with no confirmation signal at all.
  recipe('submit_test_nosignal', [
    { action: 'goto', url: '{{url}}' },
    { action: 'submit_form', fields: '{{fields}}', answers: '{{answers}}', approval: '{{approval}}', packet_id: '{{packetId}}', url: '{{url}}' },
  ]);
  // Lands somewhere other than the approved URL (goto `start`, approve `url`).
  recipe('submit_test_redirect', [
    { action: 'goto', url: '{{start}}' },
    { action: 'submit_form', fields: '{{fields}}', answers: '{{answers}}', approval: '{{approval}}', packet_id: '{{packetId}}', url: '{{url}}', confirm_text: SIGNALS.confirm_text },
  ]);
  // Never navigates: the page stays at about:blank, a host nothing arms.
  recipe('submit_test_nonav', [
    { action: 'submit_form', fields: '{{fields}}', answers: '{{answers}}', approval: '{{approval}}', packet_id: '{{packetId}}', url: '{{url}}', confirm_text: SIGNALS.confirm_text },
  ]);
  // Structural refusals: these never launch a browser.
  const step = { action: 'submit_form', confirm_text: 'x' };
  recipe('submit_test_not_last', [{ action: 'goto', url: '{{url}}' }, step, { action: 'wait', ms: 10 }]);
  recipe('submit_test_twice', [{ action: 'goto', url: '{{url}}' }, step, step]);
  recipe('submit_test_in_repeat', [{ action: 'goto', url: '{{url}}' }, { action: 'repeat', times: 1, steps: [step] }]);
});

test.after(async () => {
  for (const id of createdSiteIds) deleteSite(db, id);
  await ats.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// --- the positive path: proves every refusal's zero is a real zero -----------

for (const recipeName of ['submit_test_bare', 'submit_test_action']) test(`[click once] an approved fixture submission clicks exactly once and reports submitted (served with HTTP 500: the status plays no part) -- ${recipeName}`, async () => {
  ats.reset();
  const p = await prepared(ats.url('greenhouse', 'outcome=confirm&status=500'));
  const { out, s, stdout } = await submit(p, { recipeName });
  assertValid(s);
  assert.equal(`${s.status}/${s.reason}`, 'submitted/confirmation_seen', JSON.stringify(s).slice(0, 800));
  assert.equal(out.success, true);
  assert.equal(s.clicked, true);
  assert.equal(s.submitClicks, 1);
  assert.equal(s.packetId, p.packetId);
  assert.equal(s.batchId, p.approval.batchId);
  assert.equal(s.submissionHash, p.hash);
  assert.equal(s.formChanged, false);
  assert.equal(s.pageHost, '127.0.0.1');
  assert.match(s.finalUrl, /\/greenhouse\/confirmation$/, 'finalUrl is origin + path, no query');
  assert.deepEqual(s.observed, { confirmation: true, error: false, formPresent: false, dialogs: 0 });
  assert.equal(s.fill.status, 'done');
  assert.equal(out.article, null, 'the page text is dropped');
  // Exactly one of each submit signal: one click, one submit event, one POST.
  assert.deepEqual(
    { submitClick: ats.counters.submitClick, submitEvent: ats.counters.submitEvent, enterKey: ats.counters.enterKey, applyPost: ats.counters.applyPost },
    { submitClick: 1, submitEvent: 1, enterKey: 0, applyPost: 1 }
  );
  // What was sent is what was approved.
  const [sent] = ats.applyBodies();
  assert.equal(sent.first_name, 'Fixturea');
  assert.equal(sent.email, 'fixture.a@example.invalid');
  // No answer value reaches stdout except inside nothing: the result never echoes them.
  for (const v of ['Fixturea', 'fixture.a@example.invalid', '5550100001']) assert.ok(!stdout.includes(v), `stdout echoes an answer value (${v.length} chars)`);
});

test('[click once] a different approved answer map sends a different body (the input reaches the POST)', async () => {
  ats.reset();
  const p = await prepared(ats.url('greenhouse', 'outcome=confirm'), { variant: 'b' });
  const { s } = await submit(p);
  assertValid(s);
  assert.equal(s.status, 'submitted', JSON.stringify(s).slice(0, 600));
  const [sent] = ats.applyBodies();
  assert.equal(sent.first_name, 'Fixtureb');
  assert.equal(sent.email, 'fixture.b@example.invalid');
  assert.equal(ats.counters.applyPost, 1);
});

// --- approval gates (§4: no approval, no submit) -------------------------------

test('[approval] no approval -> refused/no_approval, nothing touched (the same packet approved submits: [click once])', async () => {
  ats.reset();
  const p = await prepared(ats.url('greenhouse', 'outcome=confirm'));
  const { out } = await submit({ ...p, approval: undefined });
  assertRefusedNoSubmit(out, 'refused', 'no_approval');
  assert.equal(out.submit.fill, null, 'nothing was filled');
  assert.equal(ats.state(), null, 'not one field was touched');
});

test('[approval] an approval that is not an object, or has a bad batch id -> refused/approval_invalid', async () => {
  ats.reset();
  const p = await prepared(ats.url('greenhouse', 'outcome=confirm'));
  assertRefusedNoSubmit((await submit({ ...p, approval: 'yes' })).out, 'refused', 'approval_invalid');
  assertRefusedNoSubmit((await submit({ ...p, approval: { ...p.approval, batchId: 'b-1' } })).out, 'refused', 'approval_invalid');
});

test('[approval expiry] an expired approval -> refused/approval_expired', async () => {
  ats.reset();
  const p = await prepared(ats.url('greenhouse', 'outcome=confirm'), { approvalOpts: { at: Date.now() - 2 * 60 * 60 * 1000, lifeMs: 60 * 60 * 1000 } });
  assertRefusedNoSubmit((await submit(p)).out, 'refused', 'approval_expired');
});

test('[approval expiry] an approval living past 24h, or dated in the future -> refused/approval_invalid', async () => {
  ats.reset();
  const long = await prepared(ats.url('greenhouse', 'outcome=confirm'), { approvalOpts: { lifeMs: APPROVAL_MAX_MS + 1000 } });
  assertRefusedNoSubmit((await submit(long)).out, 'refused', 'approval_invalid');
  const future = await prepared(ats.url('greenhouse', 'outcome=confirm'), { approvalOpts: { at: Date.now() + 60 * 60 * 1000 } });
  assertRefusedNoSubmit((await submit(future)).out, 'refused', 'approval_invalid');
});

test('[approval binds packet] a packet not in the approved batch -> refused/packet_not_in_batch', async () => {
  ats.reset();
  const p = await prepared(ats.url('greenhouse', 'outcome=confirm'));
  assertRefusedNoSubmit((await submit({ ...p, packetId: 'pkt-9999' })).out, 'refused', 'packet_not_in_batch');
});

test('[approval binds answers] answers changed after approval -> refused/packet_changed', async () => {
  ats.reset();
  const p = await prepared(ats.url('greenhouse', 'outcome=confirm'));
  const first = Object.keys(p.answers)[0];
  assertRefusedNoSubmit((await submit({ ...p, answers: { ...p.answers, [first]: 'Changedafter' } })).out, 'refused', 'packet_changed');
});

test('[approval binds file bytes] the resume file rewritten after approval -> refused/packet_changed', async () => {
  ats.reset();
  const file = path.join(tmp, 'fixture-resume-swap.txt');
  fs.writeFileSync(file, 'FAKE RESUME version 1\n');
  const p = await prepared(ats.url('greenhouse', 'outcome=confirm'));
  const answersF = { ...p.answers, '#resume': file };
  const h = submissionHash({ url: p.url, fields: p.fields, answers: answersF }).hash;
  const appr = approval([[p.packetId, h]]);
  fs.writeFileSync(file, 'FAKE RESUME version 2, same path\n');
  assertRefusedNoSubmit((await submit({ ...p, answers: answersF, approval: appr })).out, 'refused', 'packet_changed');
});

test('[approval binds url] the same packet approved for another URL -> refused/packet_changed', async () => {
  ats.reset();
  const p = await prepared(ats.url('greenhouse', 'outcome=confirm'));
  const other = submissionHash({ url: ats.url('greenhouse', 'outcome=confirm&x=1'), fields: p.fields, answers: p.answers }).hash;
  assertRefusedNoSubmit((await submit({ ...p, approval: approval([[p.packetId, other]]) })).out, 'refused', 'packet_changed');
});

test('[signals] a recipe with no confirmation signal -> refused/bad_params (an outcome it could not read is not run)', async () => {
  ats.reset();
  const p = await prepared(ats.url('greenhouse', 'outcome=confirm'));
  const { out } = await submit(p, { recipeName: 'submit_test_nosignal' });
  assertRefusedNoSubmit(out, 'refused', 'bad_params');
});

// --- never twice --------------------------------------------------------------

test('[ledger] a second run of the same approved packet -> refused/already_attempted; a new batch is not refused by it', async () => {
  ats.reset();
  const p = await prepared(ats.url('greenhouse', 'outcome=confirm'));
  const first = await submit(p);
  assert.equal(first.s.status, 'submitted', JSON.stringify(first.s).slice(0, 400));
  ats.reset();
  assertRefusedNoSubmit((await submit(p)).out, 'refused', 'already_attempted');
  // An `unknown` is never retried either: the ledger does not care how it ended.
  ats.reset();
  const again = await submit({ ...p, approval: approval([[p.packetId, p.hash]]) });
  assert.equal(again.s.status, 'submitted', 'a new yes (new batch id) is the way to send it again');
});

test('[ledger] an unreadable ledger -> refused/ledger_unavailable (fails safe, not open)', async () => {
  ats.reset();
  const notADir = path.join(tmp, 'ledger-is-a-file');
  fs.writeFileSync(notADir, 'x');
  const p = await prepared(ats.url('greenhouse', 'outcome=confirm'));
  const { out } = await submit(p, { env: { SS_SUBMIT_LEDGER_DIR: notADir } });
  assertRefusedNoSubmit(out, 'refused', 'ledger_unavailable');
});

test('[ledger] entries hold ids, the hash and the outcome, never an answer value; files are 0600', async () => {
  const files = fs.readdirSync(ledgerDir);
  assert.ok(files.length > 0, 'the runs above left ledger entries');
  const allowed = ['batchId', 'claimedAt', 'packetId', 'reason', 'recordedAt', 'status', 'submissionHash'];
  for (const f of files) {
    const text = fs.readFileSync(path.join(ledgerDir, f), 'utf8');
    for (const v of ['Fixturea', 'Fixtureb', 'example.invalid', '5550100001']) assert.ok(!text.includes(v), `ledger entry ${f} holds an answer value`);
    for (const k of Object.keys(JSON.parse(text))) assert.ok(allowed.includes(k), `unexpected ledger key ${k}`);
    assert.equal(fs.statSync(path.join(ledgerDir, f)).mode & 0o077, 0, 'ledger entries are 0600');
  }
  // attempted() is what the gate reads: true for a claimed pair, false for a new one.
  const one = JSON.parse(fs.readFileSync(path.join(ledgerDir, files[0]), 'utf8'));
  const prev = process.env.SS_SUBMIT_LEDGER_DIR;
  process.env.SS_SUBMIT_LEDGER_DIR = ledgerDir;
  try {
    assert.equal(ledger.attempted(one.batchId, one.packetId), true);
    assert.equal(ledger.attempted(newBatchId(), one.packetId), false);
  } finally {
    if (prev === undefined) delete process.env.SS_SUBMIT_LEDGER_DIR;
    else process.env.SS_SUBMIT_LEDGER_DIR = prev;
  }
});

// --- live disarm (§12.2 step 3: nothing may submit a real application) ---------

test('[live disarm] LIVE_SUBMIT_HOSTS is empty: no real host is armed (changing this is Jacob\'s decision, and this test with it)', () => {
  assert.deepEqual([...LIVE_SUBMIT_HOSTS], []);
  assert.equal(Object.isFrozen(LIVE_SUBMIT_HOSTS), true);
  for (const h of ['job-boards.greenhouse.io', 'boards.greenhouse.io', 'jobs.lever.co', 'jobs.ashbyhq.com', 'example.com', '', null, undefined]) {
    assert.equal(isSubmitHostArmed(h), false, `${h} must not be armed`);
  }
  assert.equal(isSubmitHostArmed('127.0.0.1'), true, 'loopback (the fixtures) is the only thing armed');
});

test('[live disarm] a page on an unarmed host -> refused/live_submit_disarmed, with a valid approval', async () => {
  ats.reset();
  const p = await prepared(ats.url('greenhouse', 'outcome=confirm'));
  const { out } = await submit(p, { recipeName: 'submit_test_nonav' });
  assertRefusedNoSubmit(out, 'refused', 'live_submit_disarmed');
});

// --- the page is the approved one -------------------------------------------------

test('[url] the page landed elsewhere (a redirect) -> needs-review/url_changed; started at the URL itself, it submits', async () => {
  ats.reset();
  const p = await prepared(ats.url('greenhouse', 'outcome=confirm'));
  const { out } = await submit(p, { recipeName: 'submit_test_redirect', extra: { start: ats.redirectUrl('/greenhouse/form?outcome=confirm&status=200') } });
  assertRefusedNoSubmit(out, 'needs-review', 'url_changed');
  ats.reset();
  const ok = await submit({ ...p, approval: approval([[p.packetId, p.hash]]) }, { recipeName: 'submit_test_redirect', extra: { start: p.url } });
  assert.equal(ok.s.status, 'submitted', JSON.stringify(ok.s).slice(0, 400));
});

test('[wall] a wall on the form page -> blocked-attn/wall_before_fill, nothing touched', async () => {
  ats.reset();
  // Approved against the clean form; the page now shows a CAPTCHA wall too.
  const clean = await prepared(ats.url('greenhouse', 'outcome=confirm'));
  const walledUrl = ats.url('greenhouse', 'outcome=confirm&wall=captcha');
  const p = { ...clean, url: walledUrl };
  p.hash = submissionHash({ url: walledUrl, fields: clean.fields, answers: clean.answers }).hash;
  p.approval = approval([[p.packetId, p.hash]]);
  const { out } = await submit(p);
  assertRefusedNoSubmit(out, 'blocked-attn', 'wall_before_fill');
  assert.ok(out.submit.wall.signals.length > 0);
  assert.equal(ats.state(), null, 'not one field was touched');
});

test('[drift] the live form is not the described one -> needs-review/form_changed before anything is filled', async () => {
  ats.reset();
  // Described on the clean form; the page now carries an extra required question.
  const clean = await prepared(ats.url('greenhouse', 'outcome=confirm'));
  const driftUrl = ats.url('greenhouse', 'outcome=confirm&drift=1');
  const p = { ...clean, url: driftUrl };
  p.hash = submissionHash({ url: driftUrl, fields: clean.fields, answers: clean.answers }).hash;
  p.approval = approval([[p.packetId, p.hash]]);
  const { out } = await submit(p);
  assertRefusedNoSubmit(out, 'needs-review', 'form_changed');
  assert.equal(out.submit.formChanged, true);
  assert.equal(out.submit.fill, null);
  assert.equal(ats.state(), null, 'not one field was touched');
});

test('[drift] a question that appears during the fill -> needs-review/form_changed_during_fill, never submitted', async () => {
  ats.reset();
  const clean = await prepared(ats.url('greenhouse', 'outcome=confirm'));
  const driftUrl = ats.url('greenhouse', 'outcome=confirm&drift=fill');
  const p = { ...clean, url: driftUrl };
  p.hash = submissionHash({ url: driftUrl, fields: clean.fields, answers: clean.answers }).hash;
  p.approval = approval([[p.packetId, p.hash]]);
  const { out } = await submit(p);
  assertValid(out.submit);
  assert.equal(out.submit.status, 'needs-review', JSON.stringify(out.submit).slice(0, 600));
  assert.equal(out.submit.reason, 'form_changed_during_fill');
  // The fill itself saw nothing wrong: only the re-describe after it caught the new question.
  assert.equal(out.submit.fill.status, 'done');
  assert.equal(out.submit.fill.formChanged, false);
  assert.equal(out.submit.clicked, false);
  assert.equal(ats.submits(), 0, JSON.stringify(ats.counters));
});

test('[fill complete] an approved answer map that leaves a required question open -> needs-review/fill_incomplete', async () => {
  ats.reset();
  const url = ats.url('greenhouse', 'outcome=confirm');
  const fields = await describe(url);
  const ans = answers(fields);
  delete ans['#email'];
  const h = submissionHash({ url, fields, answers: ans }).hash;
  const { out } = await submit({ url, fields, answers: ans, packetId: 'pkt-0001', hash: h, approval: approval([['pkt-0001', h]]) });
  assertRefusedNoSubmit(out, 'needs-review', 'fill_incomplete');
  assert.ok(out.submit.fill.requiredNotFilled.includes('#email'), JSON.stringify(out.submit.fill.requiredNotFilled));
});

test('[fill complete] fillVerdict: each way a fill can fall short refuses; a clean one passes', () => {
  const clean = {
    status: 'done',
    navigatedDuringFill: false,
    formChanged: false,
    wallCheck: 'clear',
    counts: { failed: 0 },
    fields: [{ selector: '#a', outcome: 'filled' }],
    requiredNotFilled: [],
    requiredGroupsNotFilled: [],
    unknownAnswerKeys: [],
    undescribedFields: [],
  };
  const ans = { '#a': 'x' };
  assert.equal(fillVerdict(clean, ans), null);
  const cases = [
    [{ status: 'blocked-attn' }, 'wall_during_fill'],
    [{ navigatedDuringFill: true }, 'navigated_during_fill'],
    [{ formChanged: true }, 'form_changed'],
    [{ formChanged: null }, 'form_changed'],
    [{ wallCheck: 'unknown' }, 'wall_unknown'],
    [{ status: 'error' }, 'fill_incomplete'],
    [{ counts: { failed: 1 } }, 'fill_incomplete'],
    [{ fields: [{ selector: '#a', outcome: 'failed' }] }, 'fill_incomplete'],
    [{ requiredNotFilled: ['#b'] }, 'fill_incomplete'],
    [{ requiredGroupsNotFilled: ['g'] }, 'fill_incomplete'],
    [{ unknownAnswerKeys: ['#z'] }, 'fill_incomplete'],
    [{ undescribedFields: ['#u'] }, 'fill_incomplete'],
  ];
  for (const [patch, reason] of cases) assert.equal(fillVerdict({ ...clean, ...patch }, ans)?.reason, reason, JSON.stringify(patch));
});

test('[one control] two submit controls -> needs-review/submit_control_not_unique; none -> no_submit_control', async () => {
  for (const [q, reason] of [['submit=two', 'submit_control_not_unique'], ['submit=none', 'no_submit_control']]) {
    ats.reset();
    const p = await prepared(ats.url('greenhouse', `outcome=confirm&${q}`));
    assertRefusedNoSubmit((await submit(p)).out, 'needs-review', reason);
  }
});

test('[one control] a submit control outside the <form> (form= attribute) is still the form\'s one control', async () => {
  ats.reset();
  const p = await prepared(ats.url('greenhouse', 'outcome=confirm&submit=form_attr'));
  const { s } = await submit(p);
  assertValid(s);
  assert.equal(s.status, 'submitted', JSON.stringify(s).slice(0, 400));
  assert.equal(ats.counters.applyPost, 1);
});

test('[outcome readable] an error already on the form page -> needs-review/signals_present_before_submit', async () => {
  ats.reset();
  const p = await prepared(ats.url('greenhouse', 'outcome=confirm&banner=error'));
  assertRefusedNoSubmit((await submit(p)).out, 'needs-review', 'signals_present_before_submit');
});

// --- outcomes: judged by the page, never the status code ------------------------

test('[outcome] an error page served with HTTP 200 -> failed/error_page (clicked once)', async () => {
  ats.reset();
  const p = await prepared(ats.url('greenhouse', 'outcome=error&status=200'));
  const { out, s } = await submit(p);
  assertValid(s);
  assert.equal(`${s.status}/${s.reason}`, 'failed/error_page', JSON.stringify(s).slice(0, 400));
  assert.equal(out.success, false);
  assert.equal(s.clicked, true);
  assert.equal(ats.counters.applyPost, 1);
});

test('[outcome] a wall after the click -> blocked-attn/wall_after_submit (clicked once, never a workaround)', async () => {
  ats.reset();
  const p = await prepared(ats.url('greenhouse', 'outcome=wall'));
  const { out, s } = await submit(p);
  assertValid(s);
  assert.equal(`${s.status}/${s.reason}`, 'blocked-attn/wall_after_submit', JSON.stringify(s).slice(0, 400));
  assert.equal(out.success, false);
  assert.equal(s.wall.phase, 'after_submit');
  assert.equal(ats.counters.applyPost, 1);
});

test('[outcome] a page that says neither -> unknown/no_signal (clicked once; never retried)', async () => {
  ats.reset();
  const p = await prepared(ats.url('greenhouse', 'outcome=silent'));
  const { out, s } = await submit(p);
  assertValid(s);
  assert.equal(`${s.status}/${s.reason}`, 'unknown/no_signal', JSON.stringify(s).slice(0, 400));
  assert.equal(out.success, false);
  assert.equal(ats.counters.applyPost, 1);
  ats.reset();
  assertRefusedNoSubmit((await submit(p)).out, 'refused', 'already_attempted');
});

// --- where a submit may appear at all ---------------------------------------------

test('[structure] submit_form not last, twice, or inside a repeat is refused before a browser launches', async () => {
  for (const [name, re] of [
    ['submit_test_not_last', /must be the last step/],
    ['submit_test_twice', /appears 2 times/],
    ['submit_test_in_repeat', /inside a repeat/],
  ]) {
    ats.reset();
    const { out } = await run(name, { url: ats.url('greenhouse') });
    assert.equal(out.success, false);
    assert.match(out.error, re);
    assert.equal(out.submit, undefined);
    assert.equal(ats.submits(), 0);
  }
});

test('[structure] submitStepProblem: only an action recipe; stepsSubmit finds a nested one', () => {
  const s = { action: 'submit_form' };
  assert.equal(submitStepProblem([{ action: 'goto' }, s], { pageType: 'action' }), null);
  assert.match(submitStepProblem([{ action: 'goto' }, s], { pageType: 'listing' }), /only in an action recipe/);
  assert.match(submitStepProblem([s], { pageType: 'action', where: 'pagination_config' }), /not allowed in pagination_config/);
  assert.equal(submitStepProblem([{ action: 'goto' }], { pageType: 'listing' }), null);
  assert.equal(stepsSubmit([{ action: 'repeat', steps: [{ action: 'wait' }, s] }]), true);
  assert.equal(stepsSubmit([{ action: 'repeat', steps: [{ action: 'wait' }] }]), false);
});

test('[structure] only submit_application_form expands to a submit: fill and describe never do', async () => {
  // Read from the export (what a clone gets), following run_generic_action
  // refs through the library, so a submit hidden one action deep is found.
  const { BUILTIN_ACTIONS } = require('../lib/builtinActions');
  const byName = Object.fromEntries(BUILTIN_ACTIONS.map(a => [a.name, a]));
  const reaches = (steps, seen) =>
    (Array.isArray(steps) ? steps : []).some(
      s =>
        s &&
        (s.action === 'submit_form' ||
          reaches(s.steps, seen) ||
          (s.action === 'run_generic_action' && byName[s.ref] && !seen.has(s.ref) && reaches(byName[s.ref].steps, new Set([...seen, s.ref]))))
    );
  const holders = BUILTIN_ACTIONS.filter(a => reaches(a.steps, new Set([a.name]))).map(a => a.name);
  assert.deepEqual(holders, ['submit_application_form']);
  // ...and the test recipe shaped like the Greenhouse one does reach it (the walk is live).
  assert.equal(reaches([{ action: 'run_generic_action', ref: 'submit_application_form' }], new Set()), true);
});

// --- nothing unattended runs a submit (lib/submitGuard.js) ---------------------------

function siteRow(name) {
  return db.prepare("SELECT * FROM sites WHERE hostname = '127.0.0.1' AND page_type = 'action' AND recipe_name = ?").get(name);
}

async function cli(args) {
  try {
    const { stdout } = await execFileAsync(process.execPath, args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, SS_SUBMIT_LEDGER_DIR: ledgerDir } });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.code, stdout: e.stdout || '' };
  }
}

test('[unattended] recipeSubmits / actionSubmits: a submit directly or through the action is found; a recipe without one is not', () => {
  const g = require('../lib/submitGuard');
  assert.equal(g.recipeSubmits(db, siteRow('submit_test_bare')), true);
  assert.equal(g.recipeSubmits(db, siteRow('submit_test_action')), true, 'through run_generic_action');
  assert.equal(g.recipeSubmits(db, siteRow('submit_test_in_repeat')), true, 'inside a repeat');
  assert.equal(g.recipeSubmits(db, siteRow('submit_test_nosubmit')), false);
  assert.equal(g.recipeSubmits(db, siteRow('submit_test_describe')), false);
  assert.equal(g.recipeSubmits(db, { ...siteRow('submit_test_nosubmit'), pagination_config: JSON.stringify([{ action: 'run_generic_action', ref: 'submit_application_form' }]) }), true, 'in pagination_config');
  // The fail path: an expansion that throws (an unknown ref) is not a submit the
  // engine could run -- the engine refuses that recipe on the same expansion.
  assert.equal(g.recipeSubmits(db, { ...siteRow('submit_test_nosubmit'), nav_template: JSON.stringify([{ action: 'run_generic_action', ref: 'no_such_action_xyz' }]) }), false);
  assert.equal(g.recipeSubmits(db, null), false);
  assert.equal(g.actionSubmits(db, 'no_such_action_xyz'), false);
  assert.equal(g.actionSubmits(db, 'submit_application_form'), true);
  assert.equal(g.actionSubmits(db, 'fill_application_form'), false);
  assert.equal(g.actionSubmits(db, 'describe_application_form'), false);
});

test('[unattended] verify.js refuses a submit recipe before any run; the status is untouched', async () => {
  ats.reset();
  const before = siteRow('submit_test_bare');
  const r = await cli(['verify.js', '127.0.0.1#action:submit_test_bare', JSON.stringify({ url: ats.url('greenhouse', 'outcome=confirm') })]);
  const out = JSON.parse(r.stdout);
  assert.notEqual(r.code, 0);
  assert.equal(out.refused, 'submits');
  assert.match(out.error, /SUBMITS/);
  assert.equal(siteRow('submit_test_bare').status, before.status);
  assert.equal(ats.counters.applyPost + ats.submits(), 0);
  // The control is not refused by the guard (it runs, dry).
  const c = await cli(['verify.js', '127.0.0.1#action:submit_test_nosubmit', JSON.stringify({ url: ats.url('greenhouse') }), '--dry']);
  assert.notEqual(JSON.parse(c.stdout).refused, 'submits', c.stdout.slice(0, 300));
});

test('[unattended] lab.js refuses to run a submit recipe', async () => {
  const r = await cli(['lab.js', 'raw', '127.0.0.1#action:submit_test_bare', JSON.stringify({ url: ats.url('greenhouse') })]);
  assert.notEqual(r.code, 0);
  assert.match(JSON.parse(r.stdout).error, /SUBMITS/);
});

test('[unattended] primitives.js try refuses a submitting action before a browser starts', async () => {
  const r = await cli(['primitives.js', 'try', ats.url('greenhouse'), '--actions=submit_application_form']);
  assert.notEqual(r.code, 0);
  assert.match(JSON.parse(r.stdout).error, /submit_application_form: refused: this recipe SUBMITS/);
  assert.equal(ats.submits(), 0);
});

test('[unattended] the live audits skip a submit recipe and never call the runner for it', async () => {
  const { auditParameters, auditWorking } = require('../audit');
  const called = [];
  const run = async target => {
    called.push(target);
    return { success: false, count: 0 };
  };
  const params = await auditParameters(db, { run });
  const working = await auditWorking(db, { run });
  const t = '127.0.0.1#action:submit_test_bare';
  assert.deepEqual(params.find(f => f.recipe === t)?.result, 'skipped');
  assert.match(params.find(f => f.recipe === t).why, /submits/);
  assert.deepEqual(working.find(f => f.recipe === t)?.result, 'skipped');
  assert.ok(!called.includes(t), 'the runner was called for a submit recipe');
  assert.ok(!called.includes('127.0.0.1#action:submit_test_action'));
  // The control IS run: the skip is specific to submitting.
  assert.ok(called.includes('127.0.0.1#action:submit_test_nosubmit'), 'the non-submitting control was not run: the guard skips too much');
});

// --- the contract seams ------------------------------------------------------------

test('[contract] `node submit.js hash` (what applications calls at approve time) equals the hash the action checks', async () => {
  const url = ats.url('greenhouse', 'outcome=confirm');
  const fields = await describe(url);
  const ans = answers(fields);
  const file = path.join(tmp, 'hash-params.json');
  fs.writeFileSync(file, JSON.stringify({ url, fields, answers: ans }), { mode: 0o600 });
  const { stdout } = await execFileAsync(process.execPath, ['submit.js', 'hash', `@${file}`], { cwd: REPO_ROOT, encoding: 'utf8' });
  const cli = JSON.parse(stdout);
  assert.equal(cli.success, true);
  assert.equal(cli.contract, CONTRACT);
  assert.equal(cli.submissionHash, submissionHash({ url, fields, answers: ans }).hash);
  assert.equal(cli.files, 1);
  // The input matters: a different answer, a different hash.
  fs.writeFileSync(file, JSON.stringify({ url, fields, answers: answers(fields, 'b') }), { mode: 0o600 });
  const other = JSON.parse((await execFileAsync(process.execPath, ['submit.js', 'hash', `@${file}`], { cwd: REPO_ROOT, encoding: 'utf8' })).stdout);
  assert.notEqual(other.submissionHash, cli.submissionHash);
  // A malformed file is reported without quoting it.
  fs.writeFileSync(file, '{"answers": {"#email": "fixture.secret@example.invalid", }');
  let bad;
  try {
    await execFileAsync(process.execPath, ['submit.js', 'hash', `@${file}`], { cwd: REPO_ROOT, encoding: 'utf8' });
  } catch (e) {
    bad = e.stdout;
  }
  assert.ok(bad, 'a malformed params file must exit non-zero');
  assert.equal(JSON.parse(bad).success, false);
  assert.ok(!bad.includes('fixture.secret'), 'the error quotes the params file');
});

test('[contract] checkApproval: each gate in order, and a good approval passes', () => {
  const h = 'a'.repeat(64);
  const now = Date.parse('2026-10-08T12:00:00Z');
  const good = { batchId: 'b-0123456789abcdef', approvedAt: '2026-10-08T11:00:00Z', expiresAt: '2026-10-08T13:00:00Z', submissions: [{ packetId: 'p1', submissionHash: h }] };
  assert.equal(checkApproval(good, { packetId: 'p1', computedHash: h, now }).ok, true);
  const r = (a, o = {}) => checkApproval(a, { packetId: 'p1', computedHash: h, now, ...o }).reason;
  assert.equal(r(null), 'no_approval');
  assert.equal(r([]), 'approval_invalid');
  assert.equal(r({ ...good, batchId: 'b-0123' }), 'approval_invalid');
  assert.equal(r({ ...good, approvedAt: 'yesterday' }), 'approval_invalid');
  assert.equal(r({ ...good, expiresAt: good.approvedAt }), 'approval_invalid');
  assert.equal(r({ ...good, expiresAt: '2026-10-09T11:00:01Z' }), 'approval_invalid', '24h + 1s');
  assert.equal(r({ ...good, approvedAt: '2026-10-08T12:10:00Z', expiresAt: '2026-10-08T13:10:00Z' }), 'approval_invalid', 'future-dated');
  assert.equal(r({ ...good, approvedAt: '2026-10-08T12:04:00Z', expiresAt: '2026-10-08T13:00:00Z' }), undefined, 'inside the clock skew');
  assert.equal(r({ ...good, approvedAt: '2026-10-08T10:00:00Z', expiresAt: '2026-10-08T12:00:00Z' }), 'approval_expired');
  assert.equal(r({ ...good, submissions: [] }), 'approval_invalid');
  assert.equal(r({ ...good, submissions: [{ packetId: 'p1', submissionHash: 'short' }] }), 'approval_invalid');
  assert.equal(r({ ...good, submissions: [good.submissions[0], good.submissions[0]] }), 'approval_invalid', 'duplicate packet');
  assert.equal(r(good, { packetId: '' }), 'bad_params');
  assert.equal(r(good, { packetId: 'p2' }), 'packet_not_in_batch');
  assert.equal(r(good, { computedHash: 'b'.repeat(64) }), 'packet_changed');
  assert.equal(r(good, { computedHash: null }), 'packet_changed');
});

test('[contract] validateSubmitResult rejects what the step must never emit', () => {
  const base = {
    kind: 'submit', contract: CONTRACT, status: 'refused', reason: 'no_approval', error: 'x', clicked: false, submitClicks: 0,
    packetId: null, batchId: null, submissionHash: null, descriptionHash: null, formHash: null, formChanged: null,
    pageHost: null, fill: null, wall: null, observed: null, finalUrl: null,
  };
  assert.deepEqual(validateSubmitResult(base), []);
  const bad = [
    { status: 'submitted', reason: 'confirmation_seen' }, // clicked false on a submitted
    { clicked: true, submitClicks: 1 }, // a refusal that clicked
    { status: 'refused', reason: 'confirmation_seen' },
    { status: 'maybe' },
    { answers: { '#a': 'x' } },
    { finalUrl: 'http://127.0.0.1/x?email=a' },
    { status: 'blocked-attn', reason: 'wall_before_fill' }, // no wall signals
  ];
  for (const patch of bad) assert.notDeepEqual(validateSubmitResult({ ...base, ...patch }), [], JSON.stringify(patch));
  const submitted = { ...base, status: 'submitted', reason: 'confirmation_seen', error: null, clicked: true, submitClicks: 1, observed: { confirmation: true, error: false, formPresent: true } };
  assert.notDeepEqual(validateSubmitResult(submitted), [], 'submitted with the form still present');
  assert.deepEqual(validateSubmitResult({ ...submitted, observed: { confirmation: true, error: false, formPresent: false } }), []);
});

test('[contract] docs/submit-output.md lists exactly the code\'s status/reason pairs, and its examples validate', () => {
  const doc = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'submit-output.md'), 'utf8');
  const docPairs = new Set([...doc.matchAll(/^\| `([a-z-]+)` \| `([a-z_]+)` \|/gm)].map(m => `${m[1]}/${m[2]}`));
  const codePairs = new Set(STATUSES.flatMap(s => REASONS[s].map(r => `${s}/${r}`)));
  assert.deepEqual([...docPairs].sort(), [...codePairs].sort());
  const clickedDoc = doc.match(/clicked statuses: `([^`]+)`/);
  assert.ok(clickedDoc, 'the doc names the clicked statuses');
  assert.deepEqual(clickedDoc[1].split('|'), CLICKED_STATUSES);
  const examples = [...doc.matchAll(/```json submit-example\n([\s\S]*?)```/g)].map(m => JSON.parse(m[1]));
  assert.ok(examples.length >= 3, 'the doc carries examples');
  for (const ex of examples) assert.deepEqual(validateSubmitResult(ex), [], JSON.stringify(ex).slice(0, 200));
});

test('[no values logged] scrape_runs keeps the keys of answers and approval, never their values', async () => {
  const rows = db
    .prepare("SELECT r.params_json, r.success, r.result_count FROM scrape_runs r JOIN sites s ON s.id = r.site_id WHERE s.hostname = '127.0.0.1' AND s.recipe_name LIKE 'submit_test_%' AND s.recipe_name != 'submit_test_describe' ORDER BY r.id DESC LIMIT 200")
    .all();
  assert.ok(rows.length > 0, 'the runs above were logged');
  // A submitted run logs one result; every other submit run logs none.
  assert.ok(rows.some(r => r.success === 1 && r.result_count === 1), 'a submitted run is logged with result_count 1');
  for (const r of rows) if (r.success !== 1) assert.ok(r.result_count === 0 || r.result_count === null, `a failed run logged result_count ${r.result_count}`);
  for (const { params_json: pj } of rows) {
    for (const v of ['Fixturea', 'Fixtureb', 'fixture.a@example.invalid', '5550100001']) assert.ok(!pj.includes(v), 'a run log holds an answer value');
  }
});
