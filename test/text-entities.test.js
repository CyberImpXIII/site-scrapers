// Decoding the HTML entities a site left in its visible text (lib/textEntities.js).
//
// The fault (2026-10-09, scripts' dry sweep): builtin.com shows the title
// "Software Engineer Lead (ETL/Regulatory Risk &amp; Compliance)" -- the site
// encoded it twice, so innerText (already decoded once by the browser) still
// carries `&amp;`, and it was headed for job-history.md as-is. Reproduced
// live the same day with {"search":"Software Engineer Lead"}.
//
// Most of these tests are about what must NOT change: one level only, a name
// we would have to look up stays, an attribute (a URL) is never rewritten.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { decodeEntitiesOnce, decodeTextFields } = require('../lib/textEntities');
const { openDb, upsertSite, insertField, deleteSite } = require('../db');
const { authorizeForTests } = require('../lib/writeGuard');

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.join(__dirname, '..');

// ---- the rule ------------------------------------------------------------------

test('the reported title decodes to the ampersand the site meant', () => {
  assert.equal(
    decodeEntitiesOnce('Software Engineer Lead (ETL/Regulatory Risk &amp; Compliance)'),
    'Software Engineer Lead (ETL/Regulatory Risk & Compliance)'
  );
});

test('the XML five, nbsp and numeric references decode', () => {
  assert.equal(decodeEntitiesOnce('a &lt;b&gt; &quot;c&quot; &apos;d&apos;'), 'a <b> "c" \'d\'');
  assert.equal(decodeEntitiesOnce('R&amp;D&nbsp;team'), 'R&D team');
  assert.equal(decodeEntitiesOnce('caf&#233; &#x2013; ok'), 'café – ok');
});

test('exactly ONE level: a triple encoding keeps one level, never collapses to the bare character', () => {
  assert.equal(decodeEntitiesOnce('Risk &amp;amp; Compliance'), 'Risk &amp; Compliance');
});

test('anything not on the list is left as the site wrote it', () => {
  // A name we would have to look up is a value we might get wrong.
  assert.equal(decodeEntitiesOnce('&eacute;t&eacute;'), '&eacute;t&eacute;');
  assert.equal(decodeEntitiesOnce('AT&T and R & D'), 'AT&T and R & D');
  assert.equal(decodeEntitiesOnce('&amp no semicolon'), '&amp no semicolon');
  // Not a character: zero, a surrogate, past the last code point.
  assert.equal(decodeEntitiesOnce('&#0; &#xD800; &#x110000;'), '&#0; &#xD800; &#x110000;');
  assert.equal(decodeEntitiesOnce(null), null);
  assert.equal(decodeEntitiesOnce(42), 42);
});

test('decodeTextFields: text fields change and are counted; attribute fields never do', () => {
  const fields = [
    { field_name: 'title', extract_kind: 'child_text' },
    { field_name: 'company_name', extract_kind: 'regex_anywhere' },
    { field_name: 'href', extract_kind: 'anchor_attribute', attribute_name: 'href' },
    { field_name: 'job_id', extract_kind: 'anchor_attribute', attribute_name: 'data-id' },
  ];
  const records = [
    { title: 'Risk &amp; Compliance', company_name: 'PNC Bank', href: 'https://x.example/j?a=1&amp;b=2', job_id: 'a&amp;b' },
    { title: 'Plain', company_name: 'Smith &amp; Sons', href: null },
    { title: 'No company' },
  ];
  const r = decodeTextFields(records, fields);
  assert.deepEqual(r, { values: 2, fields: ['company_name', 'title'] });
  assert.equal(records[0].title, 'Risk & Compliance');
  assert.equal(records[1].company_name, 'Smith & Sons');
  assert.equal(records[0].href, 'https://x.example/j?a=1&amp;b=2', 'a URL is not ours to rewrite');
  assert.equal(records[0].job_id, 'a&amp;b', 'no attribute is touched');
  assert.equal('company_name' in records[2], false, 'a missing key is not invented');
});

test('decodeTextFields: nothing to decode is null, so the run output carries no key', () => {
  assert.equal(decodeTextFields([{ title: 'Plain' }], [{ field_name: 'title', extract_kind: 'child_text' }]), null);
  assert.equal(decodeTextFields(null, null), null);
});

// ---- the engine ----------------------------------------------------------------
//
// A listing page whose source holds `&amp;amp;`, i.e. `&amp;` on screen --
// builtin's shape. The engine must return the decoded title, say it did
// (`entitiesDecoded`), and leave the href's query exactly as written.

let server;
let port;
let db;
const createdSiteIds = [];

test.before(async () => {
  authorizeForTests();
  server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html');
      if (req.url === '/encoded') {
        return res.end('<!doctype html><title>Jobs</title><body>' +
          '<div class="card"><h3>Risk &amp;amp; Compliance</h3><a href="/j?a=1&amp;amp;b=2">Apply</a></div>' +
          '<div class="card"><h3>Plain Title</h3><a href="/j?a=3">Apply</a></div></body>');
      }
      if (req.url === '/plain') {
        return res.end('<!doctype html><title>Jobs</title><body>' +
          '<div class="card"><h3>R &amp; D Lead</h3><a href="/j?a=4">Apply</a></div></body>');
      }
      res.statusCode = 404;
      return res.end('not found');
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  port = server.address().port;
  db = openDb();
});

test.after(() => {
  for (const id of createdSiteIds) deleteSite(db, id);
  if (server) server.close();
});

async function runListing(name, route) {
  const id = upsertSite(db, {
    hostname: '127.0.0.1',
    page_type: 'listing',
    recipe_name: name,
    // `working`, like the other 127.0.0.1 fixtures: the hook test picks
    // fixtures from the DB and a not-working 127.0.0.1 row skews it.
    status: 'working',
    nav_method: 'url_param',
    nav_template: `http://127.0.0.1:${port}${route}`,
    card_selector: 'div.card',
    card_min_text_len: 1,
    ready_timeout_ms: 2500,
    notes: 'Test-only recipe for test/text-entities.test.js. Safe to delete if found stray.',
  });
  if (!createdSiteIds.includes(id)) createdSiteIds.push(id);
  db.prepare('DELETE FROM site_fields WHERE site_id = ?').run(id);
  insertField(db, id, { field_name: 'title', extract_kind: 'child_text', regex_pattern: 'h3' }, 0);
  insertField(db, id, { field_name: 'href', extract_kind: 'anchor_attribute', regex_pattern: 'a', attribute_name: 'href' }, 1);
  const args = ['engine.js', `127.0.0.1#listing:${name}`, JSON.stringify({ noSession: true, noDiagnostics: true })];
  try {
    const { stdout } = await execFileAsync(process.execPath, args, { cwd: REPO_ROOT, encoding: 'utf8' });
    return JSON.parse(stdout);
  } catch (e) {
    return JSON.parse(e.stdout);
  }
}

test('engine (listing): a double-encoded title comes back decoded, counted, href untouched', async () => {
  const r = await runListing('entities_encoded', '/encoded');
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 500));
  assert.deepEqual(r.records.map((x) => x.title), ['Risk & Compliance', 'Plain Title']);
  assert.deepEqual(r.entitiesDecoded, { values: 1, fields: ['title'] });
  assert.equal(r.records[0].href, `http://127.0.0.1:${port}/j?a=1&amp;b=2`, 'the href keeps the query the site wrote');
});

test('engine (listing): a page with a real ampersand and no entity carries no entitiesDecoded key', async () => {
  // The counterfactual: `&amp;` in the SOURCE is a plain "&" on screen, which
  // the browser already decoded -- nothing for us to do, and nothing reported.
  const r = await runListing('entities_plain', '/plain');
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 500));
  assert.equal(r.records[0].title, 'R & D Lead');
  assert.equal('entitiesDecoded' in r, false);
});
