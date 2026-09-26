// Regression tests for failure-diagnostics capture (see lib/debug.js and
// README.md "Failure diagnostics"): a failed run should leave behind a
// screenshot + DOM + console/network logs to actually look at, and a
// successful run should leave nothing behind.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const { startFixtureServer } = require('./fixtures/listing_server');
const { openDb, upsertSite, insertField } = require('../db');
const { DEBUG_DIR, listDebugCaptures } = require('../lib/debug');

const REPO_ROOT = path.join(__dirname, '..');
const RECIPE_NAME = 'diagnostics_fixture_test';
const CARD_COUNT = 5;

let fixture;
let db;
let siteId;

test.before(async () => {
  fixture = await startFixtureServer(CARD_COUNT);
  db = openDb();
  // card_anchor_text intentionally wrong — 'View job' never appears (the
  // fixture uses that exact text, so this deliberately can't match) —
  // guaranteeing a timeout + zero results without needing a live site to
  // misbehave.
  siteId = upsertSite(db, {
    hostname: '127.0.0.1',
    page_type: 'listing',
    recipe_name: RECIPE_NAME,
    status: 'working',
    nav_method: 'url_param',
    nav_template: fixture.url,
    card_anchor_text: 'This text does not exist on the page',
    card_min_text_len: 20,
    ready_timeout_ms: 2000,
    notes: 'Test-only fixture recipe for test/diagnostics.test.js. Safe to delete if found stray.',
  });
  insertField(db, siteId, { field_name: 'title', extract_kind: 'positional_segment', segment_index: 1 }, 0);
});

test.after(() => {
  db.prepare('DELETE FROM site_fields WHERE site_id = ?').run(siteId);
  db.prepare('DELETE FROM scrape_runs WHERE site_id = ?').run(siteId);
  db.prepare('DELETE FROM sites WHERE id = ?').run(siteId);
  fixture.server.close();
});

async function runEngine(recipeName, extraParams = {}) {
  const params = JSON.stringify({ noSession: true, ...extraParams });
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      ['engine.js', `127.0.0.1#listing:${recipeName}`, params],
      { cwd: REPO_ROOT, encoding: 'utf8' }
    );
    return JSON.parse(stdout);
  } catch (e) {
    // engine.js exits 1 on success:false, which execFile treats as a
    // rejection — its own stdout is still the real JSON output we want.
    return JSON.parse(e.stdout);
  }
}

function captureDirsBefore() {
  if (!fs.existsSync(DEBUG_DIR)) return new Set();
  return new Set(fs.readdirSync(DEBUG_DIR));
}

test('a failing run captures diagnostics and reports the directory', async () => {
  const before = captureDirsBefore();
  const result = await runEngine(RECIPE_NAME);

  assert.equal(result.success, false);
  assert.ok(result.debugDir, 'expected a debugDir to be reported for a failed run');
  assert.ok(fs.existsSync(result.debugDir), `expected ${result.debugDir} to actually exist`);

  const after = captureDirsBefore();
  const newDirs = [...after].filter(d => !before.has(d));
  assert.equal(newDirs.length, 1, 'expected exactly one new capture directory');

  const files = fs.readdirSync(result.debugDir);
  for (const expected of ['screenshot.png', 'dom.html', 'console.json', 'network_failures.json', 'meta.json']) {
    assert.ok(files.includes(expected), `expected ${expected} in the capture directory, got: ${files.join(', ')}`);
  }

  const meta = JSON.parse(fs.readFileSync(path.join(result.debugDir, 'meta.json'), 'utf8'));
  assert.equal(meta.hostname, '127.0.0.1');
  assert.equal(meta.recipeName, RECIPE_NAME);
});

test('a failing run with noDiagnostics:true captures nothing', async () => {
  const before = captureDirsBefore();
  const result = await runEngine(RECIPE_NAME, { noDiagnostics: true });

  assert.equal(result.success, false);
  assert.equal(result.debugDir, null);

  const after = captureDirsBefore();
  assert.deepEqual(after, before, 'expected no new capture directory when diagnostics are disabled');
});

test('listDebugCaptures reflects what was captured', async () => {
  await runEngine(RECIPE_NAME);
  const captures = listDebugCaptures();
  const ours = captures.filter(c => c.recipeName === RECIPE_NAME);
  assert.ok(ours.length > 0, 'expected at least one listed capture for the fixture recipe');
  assert.ok(ours[0].capturedAt, 'expected a capturedAt timestamp');
});
