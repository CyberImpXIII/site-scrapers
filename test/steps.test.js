// Behavior tests for ui_steps primitives that other things are built on:
// the "optional step" pattern every overlay-handling generic action relies
// on, and the remove_element step. Both are load-bearing — a regression in
// either silently changes what recipes do rather than failing loudly.
//
// Run via `npm test` / `./test.sh` (needs the same Node as scrape.sh).

const test = require('node:test');
const assert = require('node:assert/strict');
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

// Page state is chosen per-request by query string, so one server covers
// every case without restarting between tests.
function pageFor(query) {
  const banner =
    query.get('banner') === 'none'
      ? ''
      : `<div id="cookie-banner" role="dialog" aria-modal="true">
           <button onclick="document.getElementById('out').textContent='CLICKED'">Dismiss</button>
         </div>`;
  return `<html><body style="overflow:hidden">
    ${banner}<div id="out">NO_CLICK</div><div id="content">CONTENT_MARKER</div>
  </body></html>`;
}

test.before(async () => {
  server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
      const query = new URL(req.url, 'http://x').searchParams;
      res.setHeader('Content-Type', 'text/html');
      res.end(pageFor(query));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/`;
  db = openDb();
});

test.after(() => {
  for (const id of createdSiteIds) {
    deleteSite(db, id);
  }
  server.close();
});

async function runSteps(name, steps) {
  const id = upsertSite(db, {
    hostname: '127.0.0.1',
    page_type: 'article',
    recipe_name: name,
    status: 'working',
    nav_method: 'ui_steps',
    nav_template: JSON.stringify(steps),
    card_min_text_len: 1,
    ready_timeout_ms: 4000,
    notes: 'Test-only recipe for test/steps.test.js. Safe to delete if found stray.',
  });
  if (!createdSiteIds.includes(id)) createdSiteIds.push(id);
  insertField(db, id, { field_name: 'body', extract_kind: 'full_blob' }, 0);
  const args = ['engine.js', `127.0.0.1#article:${name}`, '{"noSession":true,"noDiagnostics":true}'];
  try {
    const { stdout } = await execFileAsync(process.execPath, args, { cwd: REPO_ROOT, encoding: 'utf8' });
    return JSON.parse(stdout);
  } catch (e) {
    return JSON.parse(e.stdout);
  }
}

test('an optional step (repeat+stop_if_missing) does not abort the rest when its element is absent', async () => {
  // Without the enclosing repeat, a top-level StopRepeat ends the whole
  // step list — so the marker step after it would never run and the
  // omission would be silent.
  const result = await runSteps('opt_absent', [
    { action: 'goto', url: `${baseUrl}?banner=none` },
    { action: 'repeat', times: 1, steps: [{ action: 'click', selector: 'button::-p-text(Dismiss)', stop_if_missing: true, timeout: 600 }] },
    { action: 'goto', url: `${baseUrl}?banner=none&marker=1` },
  ]);
  assert.equal(result.success, true);
  assert.ok(result.url.includes('marker=1'), `steps after the optional one should still run; ended at ${result.url}`);
});

test('an optional step still acts when its element is present', async () => {
  const result = await runSteps('opt_present', [
    { action: 'goto', url: baseUrl },
    { action: 'repeat', times: 1, steps: [{ action: 'click', selector: 'button::-p-text(Dismiss)', stop_if_missing: true, timeout: 1200 }] },
  ]);
  assert.equal(result.success, true);
  assert.match(result.article.body, /CLICKED/, 'expected the click to have fired');
});

test('remove_element deletes matching nodes and leaves the rest of the page', async () => {
  const result = await runSteps('remove_basic', [
    { action: 'goto', url: baseUrl },
    { action: 'remove_element', selector: '#cookie-banner', restore_scroll: true },
  ]);
  assert.equal(result.success, true);
  assert.doesNotMatch(result.article.body, /Dismiss/, 'the overlay should be gone');
  assert.doesNotMatch(result.article.body, /CLICKED/, 'removal must not click anything');
  assert.match(result.article.body, /CONTENT_MARKER/, 'the real content must survive');
});

test('remove_element is a no-op, not a failure, when nothing matches', async () => {
  const result = await runSteps('remove_absent', [
    { action: 'goto', url: `${baseUrl}?banner=none` },
    { action: 'remove_element', selector: '#nothing-matches-this' },
    { action: 'goto', url: `${baseUrl}?banner=none&marker=1` },
  ]);
  assert.equal(result.success, true);
  assert.ok(result.url.includes('marker=1'), 'a non-matching remove_element must not stop later steps');
});

test('remove_element restores scrolling that an overlay locked', async () => {
  // The page ships with body{overflow:hidden}; without restore_scroll a
  // later scroll_bottom / infinite_scroll would silently do nothing.
  const result = await runSteps('remove_scroll', [
    { action: 'goto', url: baseUrl },
    { action: 'remove_element', selector: '#cookie-banner', restore_scroll: true },
  ]);
  assert.equal(result.success, true);
  assert.match(result.article.body, /CONTENT_MARKER/);
});

// --- Failure localization -------------------------------------------------
// Building a recipe is iterative, and every iteration used to replay the
// whole sequence from a cold browser just to find out WHERE it broke. A
// failure now carries its own position, so the next iteration can start
// from the actual problem.

test('a failing step reports its position in the sequence', async () => {
  const result = await runSteps('fail_locate', [
    { action: 'goto', url: `${baseUrl}?banner=none` },
    { action: 'waitForSelector', selector: '#content' },
    { action: 'waitForSelector', selector: '#never-appears', timeout: 800 },
  ]);

  assert.equal(result.success, false);
  assert.ok(result.failedStep, 'a step failure must say which step');
  assert.equal(result.failedStep.index, 2, 'the third step (0-based) is the one that fails');
  assert.equal(result.failedStep.of, 3);
  assert.equal(result.failedStep.action, 'waitForSelector');
  assert.equal(result.failedStep.selector, '#never-appears');
  assert.deepEqual(result.failedStep.path, [2]);
});

test('a step pulled in from a generic action says where it came from', async () => {
  // Expansion inlines a referenced action's steps, which used to erase the
  // fact that a failure happened inside dismiss_overlay rather than in the
  // recipe. Positions shift too -- the recipe's own third step is no longer
  // at index 2 once the generic action's steps are spliced in.
  const result = await runSteps('fail_from_generic', [
    { action: 'goto', url: `${baseUrl}?banner=none` },
    { action: 'run_generic_action', ref: 'dismiss_overlay' },
    { action: 'waitForSelector', selector: '#never-appears', timeout: 800 },
  ]);

  assert.equal(result.success, false);
  assert.ok(result.failedStep.of > 3, 'the generic action contributes extra steps');
  assert.equal(result.failedStep.index, result.failedStep.of - 1, 'the recipe step runs last');
  assert.equal(result.failedStep.selector, '#never-appears');
  assert.equal(result.failedStep.from, null, 'this step belongs to the recipe, not the generic action');
});

test('a credential-shaped step reports that text was supplied, never the text', async () => {
  const result = await runSteps('fail_no_secret', [
    { action: 'goto', url: `${baseUrl}?banner=none` },
    { action: 'type', selector: '#nope', text: 'hunter2-should-never-appear', timeout: 800 },
  ]);

  assert.equal(result.success, false);
  assert.equal(result.failedStep.action, 'type');
  assert.equal(result.failedStep.hasText, true, 'the fact that text was supplied is useful');
  assert.ok(
    !JSON.stringify(result).includes('hunter2-should-never-appear'),
    'a substituted value may be a password and must never reach the output'
  );
});
