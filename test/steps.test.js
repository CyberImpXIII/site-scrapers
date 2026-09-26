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
