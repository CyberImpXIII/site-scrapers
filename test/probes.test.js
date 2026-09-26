// Probes report rather than act (see lib/probes.js and README.md
// "Diagnosing a recipe"). The properties that matter:
//
//   - a probe never fails a run, even when it's malformed
//   - repeated_structure actually finds the cards, including the shared
//     line that makes a good card_anchor_text
//   - blockers tells apart the walls that all look like a bare timeout
//   - a probe never reports the VALUE of a form field (may be a password)
//   - a FAILING run gets the sweep automatically, so it explains itself
//     without a second run
//
// Run via `npm test` / `./test.sh`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const { openDb, upsertSite, insertField, deleteSite } = require('../db');

const REPO_ROOT = path.join(__dirname, '..');
let server;
let baseUrl;
let db;
const createdSiteIds = [];

function pageFor(query) {
  if (query.get('page') === 'login') {
    return `<html><head><meta charset="utf-8"></head><body>
      <h1>Sign in to continue</h1>
      <form><label for="u">Email</label><input id="u" name="email" type="email">
      <input id="p" name="password" type="password" value="prefilled-secret-value">
      <input type="submit" value="Sign in"></form></body></html>`;
  }
  const cards = Array.from({ length: 6 }, (_, i) =>
    `<div class="job-card"><h3>Engineer ${i}</h3>
     <p>Acme Corp - Remote - Full Time. A description long enough to clear the average-length threshold.</p>
     <a href="/job/${i}">View job</a></div>`
  ).join('');
  return `<html><head><meta charset="utf-8"></head><body>
    <nav><a href="/">Home</a><a href="/x">X</a></nav>
    <div id="results">${cards}</div></body></html>`;
}

test.before(async () => {
  server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(pageFor(new URL(req.url, 'http://x').searchParams));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/`;
  db = openDb();
});

test.after(() => {
  for (const id of createdSiteIds) deleteSite(db, id);
  server.close();
});

async function run(name, steps, params = '{"noSession":true,"noDiagnostics":true}') {
  const id = upsertSite(db, {
    hostname: '127.0.0.1',
    page_type: 'action',
    recipe_name: name,
    action_type: 'login',
    status: 'working',
    nav_method: 'ui_steps',
    nav_template: JSON.stringify(steps),
    content_selector: 'body',
    card_min_text_len: 1,
    ready_timeout_ms: 4000,
    notes: 'Test-only recipe for test/probes.test.js. Safe to delete if found stray.',
  });
  if (!createdSiteIds.includes(id)) createdSiteIds.push(id);
  insertField(db, id, { field_name: 'body', extract_kind: 'full_blob' }, 0);
  const args = ['engine.js', `127.0.0.1#action:${name}`, params];
  try {
    const { stdout } = await execFileAsync(process.execPath, args, { cwd: REPO_ROOT, encoding: 'utf8' });
    return JSON.parse(stdout);
  } catch (e) {
    return JSON.parse(e.stdout);
  }
}

const byKind = (result, kind) => (result.diagnostics || []).find(p => p.kind === kind);

test('repeated_structure finds the cards and the line that identifies them', async () => {
  const result = await run('probe_cards', [
    { action: 'goto', url: baseUrl },
    { action: 'run_generic_action', ref: 'probe_card_candidates' },
  ]);
  assert.equal(result.success, true);

  const cards = byKind(result, 'repeated_structure');
  assert.ok(cards, 'expected a repeated_structure probe result');
  const top = cards.candidates[0];
  assert.equal(top.count, 6, 'six cards on the fixture page');
  assert.equal(top.childrenWithLinks, 6);
  assert.equal(top.sharedLine, 'View job', 'the repeated line is the card_anchor_text candidate');
  // The two-link <nav> must not win: short text, below the length threshold.
  assert.ok(top.avgTextLength > 20);
});

test('blockers tells a login wall apart from a working page', async () => {
  const wall = await run('probe_wall', [
    { action: 'goto', url: `${baseUrl}?page=login` },
    { action: 'run_generic_action', ref: 'diagnose_blockers' },
  ]);
  const blocked = byKind(wall, 'blockers');
  assert.equal(blocked.blocked, true);
  assert.ok(blocked.flags.includes('loginWall'), `expected loginWall, got ${blocked.flags.join(',')}`);

  const fine = await run('probe_fine', [
    { action: 'goto', url: baseUrl },
    { action: 'run_generic_action', ref: 'diagnose_blockers' },
  ]);
  assert.equal(byKind(fine, 'blockers').blocked, false);
});

test('a form probe never reports a field value', async () => {
  const result = await run('probe_forms', [
    { action: 'goto', url: `${baseUrl}?page=login` },
    { action: 'run_generic_action', ref: 'diagnose_page' },
  ]);
  const forms = byKind(result, 'forms');
  assert.equal(forms.passwordFieldPresent, true);
  const pw = forms.fields.find(f => f.type === 'password');
  assert.equal(pw.hasValue, true, 'that a value exists is useful');
  assert.ok(!('value' in pw), 'the value itself must never be reported');
  assert.ok(
    !JSON.stringify(result).includes('prefilled-secret-value'),
    'a form value may be a password and must not reach the output'
  );
});

test('probe_selectors reports match counts for candidates', async () => {
  const result = await run('probe_sel', [
    { action: 'goto', url: baseUrl },
    { action: 'run_generic_action', ref: 'probe_selectors', with: { selectors: '.job-card, .nope' } },
  ]);
  const m = byKind(result, 'selectors').matches;
  assert.equal(m.find(x => x.selector === '.job-card').count, 6);
  assert.equal(m.find(x => x.selector === '.nope').count, 0, 'a selector matching nothing reports 0, not an error');
});

test('a malformed probe reports an error instead of failing the run', async () => {
  const result = await run('probe_bad', [
    { action: 'goto', url: baseUrl },
    { action: 'probe', kind: 'no_such_kind', label: 'bogus' },
    { action: 'probe', kind: 'selectors', label: 'busted', selectors: '>>>not a selector<<<' },
  ]);
  assert.equal(result.success, true, 'diagnostics run when things are already broken; they must not add failures');
  const bogus = (result.diagnostics || []).find(p => p.label === 'bogus');
  assert.match(bogus.error, /unknown probe kind/);
  const busted = (result.diagnostics || []).find(p => p.label === 'busted');
  assert.ok(busted.matches[0].error, 'an invalid selector is reported per-selector, not thrown');
});

test('a failing run is diagnosed automatically, with no probe in the recipe', async () => {
  // This is the point of the feature: the run that broke explains itself,
  // rather than needing a second run with probes added -- which may not
  // even reproduce the failure.
  const result = await run(
    'probe_autofail',
    [
      { action: 'goto', url: baseUrl },
      { action: 'waitForSelector', selector: '#does-not-exist', timeout: 900 },
    ],
    '{"noSession":true,"rollingFrames":0}'
  );
  assert.equal(result.success, false);
  assert.ok(result.debugDir);

  const file = path.join(result.debugDir, 'diagnostics.json');
  assert.ok(fs.existsSync(file), 'a failed run should leave diagnostics.json behind');
  const probes = JSON.parse(fs.readFileSync(file, 'utf8'));

  const cards = probes.find(p => p.kind === 'repeated_structure');
  assert.equal(cards.candidates[0].sharedLine, 'View job',
    'the failing run should still reveal what the selector ought to have been');
  assert.equal(probes.find(p => p.kind === 'blockers').blocked, false,
    'and should rule out a wall as the cause');
});

// --- Concurrency guard ----------------------------------------------------
// The failedStep breadcrumb is a single module-level slot, correct only
// while one sequence runs at a time. Nested `repeat` recursion is still
// sequential and fine; two OVERLAPPING sequences would interleave writes and
// the survivor would name a step that never failed. The guard makes that
// admit itself rather than answer confidently and wrongly.

test('overlapping sequences mark the failure position as untrustworthy', async () => {
  const { runUiSteps, progress } = require('../engine.js');

  // A fake page: each step type used below just resolves, except the one
  // selector that never appears, which rejects after a beat. No browser
  // needed -- this is about bookkeeping, not the DOM.
  const fakePage = {
    async waitForSelector(sel) {
      await new Promise(r => setTimeout(r, sel === '#slow-fail' ? 40 : 10));
      if (sel.includes('fail')) throw new Error(`Waiting for selector \`${sel}\` failed`);
    },
    url: () => 'about:blank',
  };
  const meta = { hostname: 'x', pageType: 'action', recipeName: 'guard' };
  const seq = sel => [{ action: 'waitForSelector', selector: '#ok' }, { action: 'waitForSelector', selector: sel }];

  progress.concurrentDetected = false;
  const [a, b] = await Promise.allSettled([
    runUiSteps(fakePage, seq('#slow-fail'), {}, meta),
    runUiSteps(fakePage, seq('#quick-fail'), {}, meta),
  ]);

  assert.equal(a.status, 'rejected');
  assert.equal(b.status, 'rejected');
  // allSettled, not all: `all` would have surfaced whichever rejected first
  // and discarded the other, which is the information this test is about.
  for (const outcome of [a, b]) {
    assert.ok(outcome.reason.failedStep, 'a position is still reported');
    assert.equal(
      outcome.reason.failedStep.breadcrumbUnreliable,
      true,
      'overlapping runs must admit the position may belong to another branch'
    );
    assert.match(outcome.reason.failedStep.note, /parallelise across processes/i);
  }
});

test('a single sequence reports its position with no such caveat', async () => {
  const { runUiSteps, progress } = require('../engine.js');
  const fakePage = {
    async waitForSelector(sel) {
      if (sel.includes('fail')) throw new Error(`Waiting for selector \`${sel}\` failed`);
    },
    url: () => 'about:blank',
  };
  progress.concurrentDetected = false;

  await assert.rejects(
    runUiSteps(fakePage, [{ action: 'waitForSelector', selector: '#nope-fail' }], {}, { hostname: 'x' }),
    err => {
      assert.equal(err.failedStep.index, 0);
      assert.equal(err.failedStep.selector, '#nope-fail');
      assert.ok(!err.failedStep.breadcrumbUnreliable, 'a sequential run has a trustworthy position');
      return true;
    }
  );
});
