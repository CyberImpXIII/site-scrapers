// The child_text extract kind, and the failure it exists to end.
//
// positional_segment splits a card's text on " | " and takes the Nth piece,
// which assumes every card has the same parts. Cards routinely do not: an
// optional company rating, a sponsored badge, a missing location. Everything
// after the variable part shifts by one — SILENTLY — and the record stays
// plausible while being wrong. Real examples, all shipped before this kind
// existed: a location reported as "An Hour Ago" (builtin.com), a location
// reported as "$52k – $104k • No equity" (wellfound.com), an ad slogan reported
// as a job title (ziprecruiter.com).
//
// Each was patched with a regex guarding one field at a time. child_text
// addresses the element directly, so a missing element yields null instead of
// shifting its neighbours — the whole class rather than one symptom.
//
// The fixture below is built so that SOME cards carry an extra part, which is
// exactly the shape that breaks positional extraction. Both kinds are run over
// the same page, so the test shows the difference rather than asserting it.
//
// Run via `npm test` / `./test.sh`.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const { openDb, upsertSite, insertField, deleteSite } = require('../db');
const { authorizeForTests } = require('../lib/writeGuard');

const REPO_ROOT = path.join(__dirname, '..');
let server;
let baseUrl;
let db;
const createdSiteIds = [];

// Cards 0,2,4… carry a rating; 1,3,5… do not. That single optional part is
// enough to shift every positional field on half the cards.
// The optional element is BLOCK-level on purpose. Inline elements merge into
// their neighbour's text ("Company 04.5") rather than creating a new part, which
// is a different bug; a block element creates a real boundary and shifts every
// index after it, which is the drift this kind exists to end.
function cardHtml(i) {
  const rating = i % 2 === 0 ? `<div class="rating">4.5</div>` : '';
  return `<li class="card">
    <div class="company">Company ${i}</div>
    ${rating}
    <h2 class="title">Engineer ${i}</h2>
    <div class="loc">City ${i}</div>
    <a href="/job/${i}">View job</a>
  </li>`;
}

test.before(async () => {
  authorizeForTests();
  server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html');
      const cards = Array.from({ length: 6 }, (_, i) => cardHtml(i)).join('\n');
      res.end(`<!doctype html><html><body><ul>${cards}</ul></body></html>`);
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

async function runWithFields(name, fields) {
  const id = upsertSite(db, {
    hostname: '127.0.0.1',
    page_type: 'listing',
    recipe_name: name,
    status: 'working',
    nav_method: 'url_param',
    nav_template: baseUrl,
    card_selector: 'li.card',
    card_min_text_len: 1,
    ready_timeout_ms: 4000,
    notes: 'Test-only recipe for test/extraction.test.js. Safe to delete if found stray.',
  });
  if (!createdSiteIds.includes(id)) createdSiteIds.push(id);
  db.prepare('DELETE FROM site_fields WHERE site_id = ?').run(id);
  fields.forEach((f, i) => insertField(db, id, f, i));

  const args = ['engine.js', `127.0.0.1#listing:${name}`, '{"noSession":true,"noDiagnostics":true}'];
  try {
    const { stdout } = await execFileAsync(process.execPath, args, { cwd: REPO_ROOT, encoding: 'utf8' });
    return JSON.parse(stdout);
  } catch (e) {
    return JSON.parse(e.stdout);
  }
}

test('positional_segment drifts when a card has an optional part', async () => {
  // Establishes the problem on this fixture rather than asserting it from
  // memory: with a rating present on half the cards, segment 1 is the title on
  // some and the rating on others.
  const r = await runWithFields('drift_positional', [
    { field_name: 'company', extract_kind: 'positional_segment', segment_index: 0 },
    { field_name: 'title', extract_kind: 'positional_segment', segment_index: 1 },
  ]);
  assert.equal(r.count, 6);
  const titles = r.records.map(j => j.title);
  assert.ok(
    titles.some(t => /^\d\.\d$/.test(t)),
    `expected the rating to land in the title field on some cards, got ${JSON.stringify(titles)}`
  );
});

test('child_text is immune to the same drift', async () => {
  const r = await runWithFields('drift_child_text', [
    { field_name: 'company', extract_kind: 'child_text', regex_pattern: '.company' },
    { field_name: 'title', extract_kind: 'child_text', regex_pattern: '.title' },
    { field_name: 'location', extract_kind: 'child_text', regex_pattern: '.loc' },
  ]);
  assert.equal(r.count, 6);
  for (const [i, job] of r.records.entries()) {
    assert.equal(job.title, `Engineer ${i}`, 'every title should be a title, rating or not');
    assert.equal(job.company, `Company ${i}`);
    assert.equal(job.location, `City ${i}`);
  }
});

test('a missing element yields null rather than shifting its neighbours', async () => {
  // The heart of it. The rating is absent on odd cards; the fields around it
  // must be unaffected, and the rating itself must read null rather than
  // borrowing the next element's text.
  const r = await runWithFields('drift_missing', [
    { field_name: 'rating', extract_kind: 'child_text', regex_pattern: '.rating' },
    { field_name: 'title', extract_kind: 'child_text', regex_pattern: '.title' },
  ]);
  for (const [i, job] of r.records.entries()) {
    assert.equal(job.title, `Engineer ${i}`, 'the neighbour must not move');
    if (i % 2 === 0) assert.equal(job.rating, '4.5');
    else assert.equal(job.rating, null, 'an absent element is null, not the next element');
  }
});

test('segment_index picks the nth match, and counts from the end when negative', async () => {
  const r = await runWithFields('child_text_nth', [
    { field_name: 'firstSpan', extract_kind: 'child_text', regex_pattern: 'div', segment_index: 0 },
    { field_name: 'lastSpan', extract_kind: 'child_text', regex_pattern: 'div', segment_index: -1 },
  ]);
  // Even cards: company, rating, loc. Odd cards: company, loc.
  assert.equal(r.records[0].firstSpan, 'Company 0');
  assert.equal(r.records[0].lastSpan, 'City 0');
  assert.equal(r.records[1].firstSpan, 'Company 1');
  assert.equal(r.records[1].lastSpan, 'City 1', 'negative indexing must work on the shorter card too');
});

test('a malformed selector yields null without losing the other fields', async () => {
  // A bad selector must not take down the rest of the card — the run should
  // still return usable records with one field empty.
  const r = await runWithFields('child_text_bad_selector', [
    { field_name: 'broken', extract_kind: 'child_text', regex_pattern: '>>>not a selector<<<' },
    { field_name: 'title', extract_kind: 'child_text', regex_pattern: '.title' },
  ]);
  assert.equal(r.count, 6);
  for (const [i, job] of r.records.entries()) {
    assert.equal(job.broken, null);
    assert.equal(job.title, `Engineer ${i}`, 'the other fields must survive a bad selector');
  }
});

test('child_text collapses whitespace so values are comparable', async () => {
  // Card markup is indented, so innerText carries newlines and runs of spaces.
  // A value that differs only by whitespace is a value that breaks equality
  // checks and de-duplication downstream.
  const r = await runWithFields('child_text_ws', [
    { field_name: 'card', extract_kind: 'child_text', regex_pattern: 'h2' },
  ]);
  for (const job of r.records) {
    assert.ok(!/\s{2,}|\n/.test(job.card), `expected collapsed whitespace, got ${JSON.stringify(job.card)}`);
    assert.equal(job.card, job.card.trim());
  }
});
