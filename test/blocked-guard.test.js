// blocked-guard (lib/blockedGuard.js): a `blocked-attn` recipe is refused by
// the CLI itself unless the run is attended -- PLAN-hard-gates.md §3 row 21,
// §7 phase 5. The troubleshooting.sh hook blocks the same retry earlier; this
// holds when the hook is absent or does not parse the command.
//
// No browser opens in this file. Every fixture's nav steps are a run_action
// with no `ref`, which engine.js rejects at step expansion -- AFTER the status
// gates and BEFORE any launch. So "got past the guard" reads as that exact
// error, and "refused" reads as `refused: "blocked-attn"`: one input changed,
// two different outputs, and an attended run that never needs a window.
//
// Hostname `blockedguard.test` on purpose: no `working` recipe lives there, so
// the hook tests that pick "the first not-working host" from the live DB while
// this runs still see a host the prefer-recipes hook must allow, and the
// troubleshooting hook test that picks a blocked-attn recipe gets one it must
// block -- both correct for this fixture.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { openDb, upsertSite, insertField, deleteSite, getSite } = require('../db');
const { authorizeForTests } = require('../lib/writeGuard');
const { blockedAttnGate, isAttended, isBlockedRefusal, blockedAttnRefusal } = require('../lib/blockedGuard');
const { auditParameters } = require('../audit');

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.join(__dirname, '..');
const HOST = 'blockedguard.test';
const PAST_GUARD = /run_action step is missing "ref"/;

let db;
const created = [];

function fixture(name, status, overrides = {}) {
  const id = upsertSite(db, {
    hostname: HOST,
    page_type: 'listing',
    recipe_name: name,
    status,
    nav_method: 'ui_steps',
    nav_template: JSON.stringify([{ action: 'run_action' }]),
    card_selector: 'li.card',
    notes: 'Test-only recipe for test/blocked-guard.test.js. Safe to delete if found stray.',
    ...overrides,
  });
  if (!created.includes(id)) created.push(id);
  db.prepare('DELETE FROM site_fields WHERE site_id = ?').run(id);
  insertField(db, id, { field_name: 'title', extract_kind: 'full_blob' }, 0);
  return `${HOST}#listing:${name}`;
}

async function run(script, args) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [script, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
    return { code: 0, out: JSON.parse(stdout) };
  } catch (e) {
    return { code: e.code, out: JSON.parse(e.stdout) };
  }
}
const engine = (...args) => run('engine.js', args);

test.before(() => {
  authorizeForTests();
  db = openDb();
});

test.after(() => {
  for (const id of created) deleteSite(db, id);
});

// --- the decision, every status x attended ----------------------------------

test('the gate: only blocked-attn is its business, and attended alone opens it', () => {
  for (const status of ['working', 'needs-review', 'broken', 'blocked']) {
    for (const params of [{}, { attended: true }, { allowUnverified: true }]) {
      assert.equal(blockedAttnGate({ status }, params), null, `${status} ${JSON.stringify(params)}`);
    }
  }
  assert.equal(blockedAttnGate({ status: 'blocked-attn' }, {}), 'refuse');
  assert.equal(blockedAttnGate({ status: 'blocked-attn' }, { allowUnverified: true }), 'refuse', 'allowUnverified does not open it');
  assert.equal(blockedAttnGate({ status: 'blocked-attn' }, { attended: true }), 'attended');
  assert.equal(blockedAttnGate(null, {}), null);
  assert.equal(isAttended(undefined), false);
});

test('the refusal names the sanctioned next step and is recognisable', () => {
  const r = blockedAttnRefusal({ hostname: 'x.test', page_type: 'listing', recipe_name: 'default', notes: 'n' });
  assert.equal(r.success, false);
  assert.equal(r.status, 'blocked-attn');
  assert.equal(r.next, "node verify.js x.test#listing:default '<params>' --attended");
  assert.ok(isBlockedRefusal(r));
  assert.ok(!isBlockedRefusal({ success: false, status: 'blocked-attn', error: 'other' }), 'only the guard\'s own key counts');
});

// --- the CLI: engine.js / scrape.sh ----------------------------------------

test('engine: a blocked-attn recipe is refused, allowUnverified or not', async () => {
  const t = fixture('attn_refused', 'blocked-attn');
  for (const params of ['{}', '{"allowUnverified":true}']) {
    const r = await engine(t, params);
    assert.equal(r.code, 1);
    assert.equal(r.out.refused, 'blocked-attn', `${params}: ${JSON.stringify(r.out)}`);
    assert.match(r.out.next, /--attended$/);
    assert.doesNotMatch(r.out.error, PAST_GUARD, 'refused before anything else ran');
  }
});

test('engine: --attended passes the guard (flag after params, flag in the params slot, or the param)', async () => {
  const t = fixture('attn_attended', 'blocked-attn');
  for (const args of [[t, '{}', '--attended'], [t, '--attended'], [t, '{"attended":true}']]) {
    const r = await engine(...args);
    assert.equal(r.out.refused, undefined, `${args.join(' ')}: ${JSON.stringify(r.out)}`);
    assert.match(r.out.error, PAST_GUARD, `${args.join(' ')} should reach step expansion`);
  }
});

test('engine: an unrelated recipe is unaffected', async () => {
  const working = fixture('attn_unrelated_working', 'working');
  const r1 = await engine(working, '{}');
  assert.equal(r1.out.refused, undefined);
  assert.match(r1.out.error, PAST_GUARD);

  const review = fixture('attn_unrelated_review', 'needs-review');
  const r2 = await engine(review, '{"allowUnverified":true}');
  assert.equal(r2.out.refused, undefined);
  assert.match(r2.out.error, PAST_GUARD);
  // ...and the ordinary status gate still refuses it without allowUnverified,
  // with its own message, not blocked-guard's.
  const r3 = await engine(review, '{}');
  assert.equal(r3.out.refused, undefined);
  assert.match(r3.out.error, /status="needs-review"/);
});

test('engine: the input changes the output -- one flag, one status, each flips the result', async () => {
  const t = fixture('attn_flip', 'blocked-attn');
  const [off, on] = [await engine(t, '{}'), await engine(t, '{}', '--attended')];
  assert.notDeepEqual(off.out, on.out);
  assert.equal(off.out.refused, 'blocked-attn');
  assert.equal(on.out.refused, undefined);

  fixture('attn_flip', 'working'); // same recipe, same args, status changed
  const after = await engine(t, '{}');
  assert.equal(after.out.refused, undefined);
  assert.match(after.out.error, PAST_GUARD);
});

// --- documented == implemented ----------------------------------------------

test('help and docs name --attended wherever the guard accepts it', async () => {
  const fs = require('node:fs');
  const usage = await engine();
  assert.match(usage.out.error, /--attended/, 'engine.js usage');
  const v = await run('verify.js', []);
  assert.match(v.out.error, /--attended/, 'verify.js usage');
  const claude = fs.readFileSync(path.join(REPO_ROOT, 'CLAUDE.md'), 'utf8');
  assert.match(claude, /^scrape\.sh .*\[--attended\]/m, 'CLAUDE.md Commands block');
  assert.match(claude, /lib\/blockedGuard\.js/, 'CLAUDE.md rule 3 names the guard');
  const recipes = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'recipes.md'), 'utf8');
  assert.match(recipes, /refused: "blocked-attn"/, 'docs/recipes.md names the refusal key callers test');
});

// --- the callers that interpret a run ---------------------------------------

test('lab.js: a refusal is printed as the answer, never read as a run', async () => {
  const t = fixture('attn_lab', 'blocked-attn');
  const peek = await run('lab.js', ['peek', t, '{}']);
  assert.equal(peek.code, 1);
  assert.equal(peek.out.refused, 'blocked-attn');
  // `params` compares two runs; two refusals read as runs said "Parameters
  // change the result set" -- a wrong answer, not a failure.
  const params = await run('lab.js', ['params', t, '{"q":"a"}', '{"q":"b"}']);
  assert.equal(params.code, 1);
  assert.equal(params.out.refused, 'blocked-attn');
  assert.equal(params.out.verdict, undefined);
  // and --attended on lab.js's own command line passes through
  const attended = await run('lab.js', ['peek', t, '{}', '--attended']);
  assert.equal(attended.out.refused, undefined, JSON.stringify(attended.out));
});

test('verify.js: an unattended refusal writes no status', async () => {
  const t = fixture('attn_verify', 'blocked-attn');
  const r = await run('verify.js', [t, '{}']);
  assert.equal(r.code, 1);
  assert.equal(r.out.refused, 'blocked-attn');
  assert.equal(getSite(db, HOST, 'listing', 'attn_verify').status, 'blocked-attn', 'a refusal must not demote the recipe');
});

test('audit.js params skips a blocked-attn recipe instead of sweeping it unattended', async () => {
  const t = fixture('attn_audit', 'blocked-attn', {
    nav_method: 'url_param',
    nav_template: 'https://blockedguard.test/jobs?q={{q}}',
    nav_params_schema: JSON.stringify({ q: 'search' }),
    param_probe_values: JSON.stringify([{ q: 'a' }, { q: 'b' }]),
  });
  let ran = 0;
  const findings = await auditParameters(db, { run: async (target) => { if (target === t) ran++; return { success: true, count: 1 }; } });
  const f = findings.find(x => x.recipe === t);
  assert.equal(f.result, 'skipped');
  assert.match(f.why, /blocked-attn/);
  assert.equal(ran, 0);
});
