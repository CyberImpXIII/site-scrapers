// prefer-recipes.sh, in the direction no test exercised before 2026-10-04: a
// recipe on a PARENT host covers its subdomains. bandcamp.com#article serves
// every `<artist>.bandcamp.com` page (TODO.md 0f), so a browser call to
// `someartist.bandcamp.com` must be refused while that recipe is working,
// and a host that merely CONTAINS the name must not be.
//
// test-prefer-recipes.sh covers the other direction (a subdomain's recipe
// does not cover its parent) from whatever the live DB holds; this one makes
// its own fixture, so it never skips.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { openDb, upsertSite, insertField, deleteSite } = require('../db');
const { authorizeForTests } = require('../lib/writeGuard');

const REPO_ROOT = path.join(__dirname, '..');
const HOOK = path.join(REPO_ROOT, '.claude', 'hooks', 'prefer-recipes.sh');
const HOST = 'subdomain-cover.internal';

let db;
let id;
let marker;

function hook(url) {
  const input = JSON.stringify({ tool_name: 'WebFetch', tool_input: { url } });
  // A private, absent override marker: a real browser-ok window must not
  // make a block case pass as "allowed" (or the reverse).
  return spawnSync('bash', [HOOK], { input, encoding: 'utf8', env: { ...process.env, SS_BROWSER_OK: marker } }).status;
}

test.before(() => {
  authorizeForTests();
  db = openDb();
  marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-subdomain-')), 'browser-ok');
  id = upsertSite(db, {
    hostname: HOST,
    page_type: 'article',
    recipe_name: 'default',
    status: 'working',
    nav_method: 'direct_url',
    nav_template: '{{url}}',
    card_min_text_len: 1,
    notes: 'Test-only recipe for test/prefer-recipes-subdomain.test.js. Safe to delete if found stray.',
  });
  insertField(db, id, { field_name: 'body', extract_kind: 'full_blob' }, 0);
});

test.after(() => {
  deleteSite(db, id);
  fs.rmSync(path.dirname(marker), { recursive: true, force: true });
});

test('a working recipe on a parent host blocks the browser on its subdomains', () => {
  assert.equal(hook(`https://${HOST}/x`), 2, 'the host itself (control)');
  assert.equal(hook(`https://someartist.${HOST}/album/a-record`), 2, 'one level down');
  assert.equal(hook(`https://a.b.${HOST}/track/t`), 2, 'two levels down');
});

test('a host that only contains the name is not covered', () => {
  assert.equal(hook(`https://${HOST}.example.invalid/x`), 0, 'the name as a prefix of another domain');
  assert.equal(hook(`https://not${HOST}/x`), 0, 'the name as a suffix without a dot boundary');
});
