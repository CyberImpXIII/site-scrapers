// Regression tests for the token-efficiency claims this project makes (see
// README.md "Why this saves tokens" and "Token-efficiency instrumentation").
// These can't test the qualitative handoff argument (that's a claim about
// an LLM caller's own tool-call behavior, not something engine.js can
// observe) - what they CAN test, and do: that a listing recipe's output
// stays small/structured rather than silently regressing toward a raw
// dump, and that --raw's documented "roughly doubles" behavior holds.
//
// Run with the same Node used for scrape.sh (>=22.5, for node:sqlite):
//   ~/.nvm/versions/node/v22.20.0/bin/node --test test/efficiency.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const { startFixtureServer, makePage } = require('./fixtures/listing_server');
const { openDb, upsertSite, insertField, getSite, getEfficiencyStats, deleteSite } = require('../db');

const REPO_ROOT = path.join(__dirname, '..');
const RECIPE_NAME = 'efficiency_fixture_test';
const CARD_COUNT = 10;

let fixture;
let db;
let siteId;

test.before(async () => {
  fixture = await startFixtureServer(CARD_COUNT);
  db = openDb();
  siteId = upsertSite(db, {
    hostname: '127.0.0.1',
    page_type: 'listing',
    recipe_name: RECIPE_NAME,
    status: 'working',
    nav_method: 'url_param',
    nav_template: fixture.url,
    card_anchor_text: 'View job',
    card_min_text_len: 20,
    ready_timeout_ms: 5000,
    notes: 'Test-only fixture recipe for test/efficiency.test.js. Safe to delete if found stray.',
  });
  insertField(db, siteId, { field_name: 'posted_ago', extract_kind: 'positional_segment', segment_index: 0 }, 0);
  insertField(db, siteId, { field_name: 'title', extract_kind: 'positional_segment', segment_index: 1 }, 1);
  insertField(db, siteId, { field_name: 'location', extract_kind: 'positional_segment', segment_index: 2 }, 2);
  insertField(db, siteId, { field_name: 'href', extract_kind: 'anchor_attribute', attribute_name: 'href' }, 3);
});

test.after(() => {
  deleteSite(db, siteId);
  fixture.server.close();
});

async function runEngine(extraArgs = []) {
  // Async (not execFileSync): the fixture HTTP server runs in THIS same
  // process, and a *synchronous* exec call blocks this process's whole
  // event loop for the child's entire lifetime — including the server's
  // ability to accept the connection the child is waiting to make. That
  // deadlock (server can't respond because the process hosting it is
  // frozen) was the real cause of an earlier "Navigation timeout of 30000
  // ms" failure here, not an engine.js bug.
  // noSession: true keeps this test independent of session-persistence
  // behavior (covered separately) — irrelevant to what's being measured here.
  const { stdout } = await execFileAsync(
    process.execPath,
    ['engine.js', `127.0.0.1#listing:${RECIPE_NAME}`, '{"noSession":true}', ...extraArgs],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  );
  return { text: stdout.trim(), json: JSON.parse(stdout) };
}

test('extracts all fixture cards correctly', async () => {
  const { json } = await runEngine();
  assert.equal(json.success, true);
  assert.equal(json.count, CARD_COUNT);
  assert.equal(json.jobs[0].title, 'Support Engineer 1');
  assert.equal(json.jobs[0].href, '/job/1');
});

test('structured output is much smaller than the raw page it was extracted from', async () => {
  const { text } = await runEngine();
  const rawPageSize = makePage(CARD_COUNT).length;
  // Generous bound (structured JSON should easily beat raw HTML, which also
  // carries markup/attributes this recipe never touches) - guards against a
  // regression toward dumping something close to the raw page, not a tight
  // byte-for-byte assertion.
  assert.ok(
    text.length < rawPageSize * 0.9,
    `expected structured output (${text.length} chars) to be well under the raw fixture page (${rawPageSize} chars)`
  );
});

test('--raw increases output size, roughly matching the documented ~2x', async () => {
  const { text: withoutRaw } = await runEngine();
  const { text: withRaw } = await runEngine(['--raw']);
  assert.ok(
    withRaw.length > withoutRaw.length,
    '--raw should produce strictly more output than the default (each record also carries _raw)'
  );
  const ratio = withRaw.length / withoutRaw.length;
  // "Roughly doubles" per README — loose bounds since exact ratio depends on
  // how much whitespace/markup collapses per card; this just guards against
  // --raw silently becoming a no-op (ratio ~1) or something absurd (ratio
  // in the double digits).
  assert.ok(ratio > 1.2 && ratio < 4, `expected --raw to roughly double output size, got ${ratio.toFixed(2)}x`);
});

test('output_chars is logged and queryable via getEfficiencyStats', async () => {
  await runEngine();
  const stats = getEfficiencyStats(db).find(
    s => s.hostname === '127.0.0.1' && s.recipe_name === RECIPE_NAME
  );
  assert.ok(stats, 'expected an efficiency stats row for the fixture recipe');
  assert.ok(stats.avgOutputChars > 0);
  assert.ok(stats.avgEstTokens > 0);
});
