// bandcamp.com#article (TODO.md 0f): the release date AND what it means.
//
// The page writes "released <date>" for an album that is out and "releases
// <date>" for a pre-order, so the same date means opposite things; a track
// on an album writes "from <album>, released <date>". The recipe reads the
// credits block and anchors at its START, so a later "released" in free-text
// credits ("originally released 1999 on ...") is never taken.
//
// Proven here by running the STORED recipe's own fields through engine.js
// against local pages, so the regexes and the engine's semantics are tested
// together (not a copy of either). The stored recipe lives in the gitignored
// DB: on a fresh clone without it, the tests SKIP and say so -- they cannot
// pass vacuously.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const { openDb, getSite, getFields, upsertSite, insertField, deleteSite } = require('../db');
const { authorizeForTests } = require('../lib/writeGuard');

const REPO_ROOT = path.join(__dirname, '..');
const HOST = 'bandcamp-release.internal';

// Shapes taken from the live pages (2026-10-04): the credits block and the
// page title "<title> | <artist>".
const PAGES = {
  album: { title: 'Minecraft - Volume Alpha | C418', credits: ['released March 4, 2011', 'All music by C418'] },
  track: { title: 'Sweden | C418', credits: ['from Minecraft - Volume Alpha, released March 4, 2011'] },
  preorder: { title: 'Next Thing | Some Artist', credits: ['releases September 25, 2030'] },
  // No release line first: the later "released" must NOT be taken.
  nolead: { title: 'Old Tapes | Some Artist', credits: ['Mixed by A. Person', 'originally released June 1, 1999 on Old Label'] },
  // A "|" inside the album title: the artist is the LAST segment.
  pipe: { title: 'Side A | Side B | Pipe Band', credits: ['released January 2, 2020'] },
};

function html({ title, credits }) {
  return `<!doctype html><html><head><title>${title}</title></head><body>
<div id="name-section"><h2 class="trackTitle">${title.split(' | ')[0]}</h2></div>
<div class="tralbumData tralbum-credits">${credits.join('<br>\n')}</div>
<div class="tralbumData tralbum-about">This album was released to great acclaim.</div>
</body></html>`;
}

let server;
let base;
let db;
let id = null;
let stored = null;

test.before(async () => {
  authorizeForTests();
  db = openDb();
  const site = getSite(db, 'bandcamp.com', 'article', 'default');
  if (site) stored = { site, fields: getFields(db, site.id) };
  server = http.createServer((req, res) => {
    const page = PAGES[req.url.slice(1)];
    res.statusCode = page ? 200 : 404;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(page ? html(page) : 'not found');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  if (!stored) return;
  id = upsertSite(db, {
    hostname: HOST,
    page_type: 'article',
    recipe_name: 'default',
    status: 'working',
    nav_method: 'direct_url',
    nav_template: '{{url}}',
    content_selector: stored.site.content_selector,
    card_min_text_len: 1,
    ready_timeout_ms: 5000,
    session_mode: 'none',
    notes: 'Test-only copy of bandcamp.com#article for test/bandcamp-release.test.js. Safe to delete if found stray.',
  });
  stored.fields.forEach((f, i) =>
    insertField(db, id, { field_name: f.field_name, extract_kind: f.extract_kind, segment_index: f.segment_index, regex_pattern: f.regex_pattern, attribute_name: f.attribute_name }, i)
  );
});

test.after(() => {
  if (id !== null) deleteSite(db, id);
  server.close();
});

async function scrape(name) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync('./scrape.sh', [`${HOST}#article`, JSON.stringify({ url: `${base}/${name}` })], { cwd: REPO_ROOT, maxBuffer: 16 << 20 }));
  } catch (e) {
    stdout = e.stdout;
  }
  const out = JSON.parse(stdout);
  assert.ok(out.article, `no article for ${name}: ${String(stdout).slice(0, 300)}`);
  return out.article;
}

const skip = () => (stored ? false : 'bandcamp.com#article is not in this DB (fresh clone?) -- NOT TESTED');

test('the stored recipe has the fields its consumer reads', { skip: skip() }, () => {
  const names = stored.fields.map(f => f.field_name);
  for (const n of ['title', 'artist', 'release_state', 'release_date']) assert.ok(names.includes(n), `missing field ${n}`);
});

test('released = out, releases = pre-order, with the date as written', { skip: skip() }, async () => {
  const album = await scrape('album');
  assert.deepEqual([album.title, album.artist, album.release_state, album.release_date], ['Minecraft - Volume Alpha', 'C418', 'released', 'March 4, 2011']);
  const pre = await scrape('preorder');
  assert.deepEqual([pre.release_state, pre.release_date], ['releases', 'September 25, 2030']);
});

test("a track on an album carries the album's date", { skip: skip() }, async () => {
  const t = await scrape('track');
  assert.deepEqual([t.title, t.artist, t.release_state, t.release_date], ['Sweden', 'C418', 'released', 'March 4, 2011']);
});

test('a later "released" in the credits is never taken: null, not a guess', { skip: skip() }, async () => {
  const n = await scrape('nolead');
  assert.equal(n.release_state, null);
  assert.equal(n.release_date, null);
});

test('a "|" in the title leaves the artist as the last segment', { skip: skip() }, async () => {
  const p = await scrape('pipe');
  assert.equal(p.artist, 'Pipe Band');
  assert.equal(p.title, 'Side A | Side B');
});
