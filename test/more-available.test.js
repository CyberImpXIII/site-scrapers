// `moreAvailable` in a listing run's output (lib/moreAvailable.js): the site's
// own result count is larger than what the run returned.
//
// The fault (2026-10-09, scripts' dry sweep): linkedin.com returned exactly 60
// records for 45 different searches while each page said "11,000+ ... Jobs
// in". A silent per-search cap looked like a small result set.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { moreAvailable, parseClaimed } = require('../lib/moreAvailable');
const { openDb, upsertSite, insertField, deleteSite } = require('../db');
const { authorizeForTests } = require('../lib/writeGuard');

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.join(__dirname, '..');

test('linkedin\'s shape: 60 of "11,000+" is more available, as a floor', () => {
  assert.deepEqual(moreAvailable('11,000+', 60), { claimed: 11000, atLeast: true, returned: 60 });
  assert.deepEqual(moreAvailable('120', 20), { claimed: 120, atLeast: false, returned: 20 });
  assert.deepEqual(moreAvailable('1', 0), { claimed: 1, atLeast: false, returned: 0 });
});

test('nothing is claimed when the site says no more than we returned', () => {
  assert.equal(moreAvailable('60', 60), null);
  assert.equal(moreAvailable('59', 60), null);
  assert.equal(moreAvailable('0', 0), null);
});

test('an unclear count is null, never a guess', () => {
  for (const c of [null, undefined, '', 'many', '1.234', '1.2K', '1,23', '12,3456', '-5', '3 results']) {
    assert.equal(parseClaimed(c), null, String(c));
    assert.equal(moreAvailable(c, 0), null, String(c));
  }
  assert.equal(moreAvailable('100', null), null, 'no returned count, no comparison');
  assert.equal(moreAvailable('100', -1), null);
});

// ---- the engine ----------------------------------------------------------------

let server;
let port;
let db;
const createdSiteIds = [];

test.before(async () => {
  authorizeForTests();
  server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html');
      const claim = req.url === '/capped' ? '1,200+' : req.url === '/all' ? '2' : null;
      if (!claim) {
        res.statusCode = 404;
        return res.end('not found');
      }
      return res.end('<!doctype html><title>Jobs</title><body>' +
        `<p>${claim} open Jobs in Testville</p>` +
        '<div class="card"><h3>First Job</h3></div><div class="card"><h3>Second Job</h3></div></body>');
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

async function runListing(name, route, regex) {
  const id = upsertSite(db, {
    hostname: '127.0.0.1',
    page_type: 'listing',
    recipe_name: name,
    status: 'working',
    nav_method: 'url_param',
    nav_template: `http://127.0.0.1:${port}${route}`,
    card_selector: 'div.card',
    card_min_text_len: 1,
    ready_timeout_ms: 2500,
    result_count_regex: regex,
    notes: 'Test-only recipe for test/more-available.test.js. Safe to delete if found stray.',
  });
  if (!createdSiteIds.includes(id)) createdSiteIds.push(id);
  insertField(db, id, { field_name: 'title', extract_kind: 'child_text', regex_pattern: 'h3' }, 0);
  const args = ['engine.js', `127.0.0.1#listing:${name}`, JSON.stringify({ noSession: true, noDiagnostics: true })];
  try {
    const { stdout } = await execFileAsync(process.execPath, args, { cwd: REPO_ROOT, encoding: 'utf8' });
    return JSON.parse(stdout);
  } catch (e) {
    return JSON.parse(e.stdout);
  }
}

// linkedin's own regex, so the test holds the shape that recipe produces.
const LINKEDIN_REGEX = '([\\d,]+\\+?) [^\\n]*? Jobs in';

test('engine: a page claiming 1,200+ with 2 cards reports moreAvailable', async () => {
  const r = await runListing('more_capped', '/capped', LINKEDIN_REGEX);
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 500));
  assert.equal(r.count, 2);
  assert.equal(r.claimedCount, '1,200+');
  assert.deepEqual(r.moreAvailable, { claimed: 1200, atLeast: true, returned: 2 });
});

test('engine: the counterfactuals carry no moreAvailable key', async () => {
  const all = await runListing('more_all', '/all', '(\\d+) open Jobs in');
  assert.equal(all.success, true, JSON.stringify(all).slice(0, 500));
  assert.equal(all.claimedCount, '2');
  assert.equal('moreAvailable' in all, false, 'the site claims exactly what came back');
  const noRegex = await runListing('more_noregex', '/capped', null);
  assert.equal(noRegex.success, true);
  assert.equal(noRegex.claimedCount, null);
  assert.equal('moreAvailable' in noRegex, false, 'no result_count_regex: we cannot know, so we do not say');
});
