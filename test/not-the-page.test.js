// `expect_url` (lib/notThePage.js) and `goto_frame`, the two ui_steps step
// types added 2026-10-05.
//
// The fault: a CLOSED Greenhouse posting 302s to the company's board on the
// same host (job-boards.greenhouse.io/allianceus/jobs/4361897009 ->
// /allianceus?error=true), and both Greenhouse recipes reported success there
// -- `#article` returned the board's intro as the job description,
// `#action:describe_application_form` returned the board's search box as the
// form. Held here four ways: the rule; the engine on a local server that
// redirects a "closed posting" the same way, through all three result paths
// (article, action, listing); goto_frame on a page embedding a form in an
// iframe; and the patterns the STORED Greenhouse recipes carry, against the
// real URLs from that report.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { checkExpectUrl, compileExpectUrl, NotThePage } = require('../lib/notThePage');
const { openDb, upsertSite, insertField, deleteSite, getSite, parseSiteArg } = require('../db');
const { authorizeForTests } = require('../lib/writeGuard');

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.join(__dirname, '..');

// The pattern the Greenhouse recipes use: a posting (/jobs/<id>) or an embed
// form (token=<id>). Path-only on purpose, so it holds for boards.greenhouse.io,
// job-boards.greenhouse.io and this file's local server alike.
const GH_POSTING = '/jobs/\\d+|[?&]token=\\d+';

// ---- the rule ----------------------------------------------------------------

test('expect_url: a matching URL passes, a redirected one is NOT-THE-PAGE with where it went', () => {
  assert.strictEqual(checkExpectUrl({ pattern: GH_POSTING, landed: 'https://job-boards.greenhouse.io/figma/jobs/5691911004' }), null);
  assert.strictEqual(checkExpectUrl({ pattern: GH_POSTING, landed: 'https://job-boards.greenhouse.io/embed/job_app?for=rstudio&token=7999513003' }), null);
  const miss = checkExpectUrl({
    pattern: GH_POSTING,
    landed: 'https://job-boards.greenhouse.io/allianceus?error=true',
    requested: 'https://job-boards.greenhouse.io/allianceus/jobs/4361897009',
    reason: 'closed posting',
  });
  assert.ok(miss instanceof NotThePage);
  assert.deepStrictEqual(miss.notThePage, {
    requested: 'https://job-boards.greenhouse.io/allianceus/jobs/4361897009',
    landed: 'https://job-boards.greenhouse.io/allianceus?error=true',
    expected: GH_POSTING,
    reason: 'closed posting',
  });
});

test('expect_url: an unreadable landed URL is not the page; a bad pattern is a plain error, not a verdict', () => {
  assert.ok(checkExpectUrl({ pattern: GH_POSTING, landed: undefined }) instanceof NotThePage);
  assert.throws(() => compileExpectUrl('(unclosed'), (e) => !(e instanceof NotThePage) && /not a valid regular expression/.test(e.message));
  assert.throws(() => compileExpectUrl(''), (e) => !(e instanceof NotThePage) && /non-empty "pattern"/.test(e.message));
  assert.throws(() => checkExpectUrl({ pattern: undefined, landed: 'https://x.example.com/' }), /non-empty "pattern"/);
});

// ---- the engine ----------------------------------------------------------------
//
// Local server routes:
//   /co/jobs/1   302 -> /co?error=true   -- a CLOSED posting (Alliance's shape)
//   /co/jobs/2   an open posting, with an application form
//   /co          the company's board: intro text, a search box, job rows
//   /emp         an employer page embedding /embed/job_app?token=2 in iframe#grnhse_iframe
//   /emp-nosrc   the same, iframe with no src
//   /embed/job_app?token=2   the embedded form

let server;
let port;
let db;
const createdSiteIds = [];

const FORM = '<form><label for="fn">First name</label><input id="fn" name="first_name" required>' +
  '<label for="em">Email</label><input id="em" name="email" type="email" required>' +
  '<button type="submit">Submit application</button></form>';

test.before(async () => {
  authorizeForTests();
  server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      if (req.url === '/co/jobs/1') { res.writeHead(302, { Location: '/co?error=true' }); return res.end(); }
      res.setHeader('Content-Type', 'text/html');
      if (req.url === '/co/jobs/2') {
        return res.end(`<!doctype html><title>Engineer</title><div class="job__description body">${'An open role doing real work. '.repeat(6)}</div>${FORM}`);
      }
      if (req.url.startsWith('/co')) {
        return res.end('<!doctype html><title>Jobs at Co</title><body><p>Find your perfect job at Co. ' +
          'We are a company that does things, and these are our current openings across every team.</p>' +
          '<form><input name="q" placeholder="Search"><button>Search</button></form>' +
          '<table><tr class="job-post"><td><a href="/co/jobs/2">Engineer</a></td></tr></table></body>');
      }
      if (req.url === '/emp') {
        return res.end('<!doctype html><title>Careers</title><body>Careers at Emp<iframe id="grnhse_iframe" src="/embed/job_app?for=emp&token=2"></iframe></body>');
      }
      if (req.url === '/emp-nosrc') {
        return res.end('<!doctype html><title>Careers</title><body>Careers at Emp<iframe id="grnhse_iframe"></iframe></body>');
      }
      if (req.url.startsWith('/embed/job_app')) {
        return res.end(`<!doctype html><title>Apply</title><body>${FORM}</body>`);
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

async function runFixture(def, params = {}) {
  const id = upsertSite(db, {
    hostname: '127.0.0.1',
    // `working`, like test/forwarded.test.js's fixtures: the hook test picks
    // fixtures from the live DB and a not-working 127.0.0.1 row skews it.
    status: 'working',
    card_min_text_len: 1,
    ready_timeout_ms: 2500,
    notes: 'Test-only recipe for test/not-the-page.test.js. Safe to delete if found stray.',
    ...def,
    nav_template: JSON.stringify(def.nav_template),
  });
  if (!createdSiteIds.includes(id)) createdSiteIds.push(id);
  db.prepare('DELETE FROM site_fields WHERE site_id = ?').run(id);
  insertField(db, id, { field_name: 'title', extract_kind: 'full_blob' }, 0);
  const target = `127.0.0.1#${def.page_type}:${def.recipe_name}`;
  const args = ['engine.js', target, JSON.stringify({ noSession: true, noDiagnostics: true, ...params })];
  try {
    const { stdout } = await execFileAsync(process.execPath, args, { cwd: REPO_ROOT, encoding: 'utf8' });
    return JSON.parse(stdout);
  } catch (e) {
    return JSON.parse(e.stdout);
  }
}

const base = () => `http://127.0.0.1:${port}`;
const articleDef = (name) => ({
  page_type: 'article',
  recipe_name: name,
  nav_method: 'ui_steps',
  nav_template: [{ action: 'goto', url: '{{url}}' }, { action: 'expect_url', pattern: GH_POSTING, reason: 'a closed posting redirects to its board' }],
  content_selector: 'div.job__description.body',
});

test('engine (article): a closed posting is NOT-THE-PAGE, article null -- not the board read as a job', async () => {
  const r = await runFixture(articleDef('ntp_article'), { url: `${base()}/co/jobs/1` });
  assert.strictEqual(r.success, false, JSON.stringify(r).slice(0, 500));
  assert.deepStrictEqual(r.notThePage, {
    requested: `${base()}/co/jobs/1`,
    landed: `${base()}/co?error=true`,
    expected: GH_POSTING,
    reason: 'a closed posting redirects to its board',
  });
  assert.strictEqual(r.article, null, 'null, not the board text');
  assert.strictEqual(r.url, `${base()}/co?error=true`);
  assert.match(r.error, /not a page this recipe reads/);
});

test('engine (article): the counterfactual -- without expect_url the same closed posting "succeeds" on the board', async () => {
  // The fault itself, reproduced: the content wait falls back to <body>, so
  // the board's intro reads as a job description. If this ever stops
  // succeeding, the test above no longer proves expect_url is what catches it.
  const def = articleDef('ntp_article_unguarded');
  def.nav_template = def.nav_template.slice(0, 1);
  def.content_selector = null;
  const r = await runFixture(def, { url: `${base()}/co/jobs/1` });
  assert.strictEqual(r.success, true, JSON.stringify(r).slice(0, 500));
  assert.strictEqual(r.notThePage, undefined);
  assert.match(JSON.stringify(r.article), /Find your perfect job at Co/);
});

test('engine (article): an open posting passes expect_url and is read', async () => {
  const r = await runFixture(articleDef('ntp_article'), { url: `${base()}/co/jobs/2` });
  assert.strictEqual(r.success, true, JSON.stringify(r).slice(0, 500));
  assert.strictEqual(r.notThePage, undefined);
  assert.match(JSON.stringify(r.article), /An open role/);
});

test('engine (action): describe_form on a closed posting is NOT-THE-PAGE, not the board search box as a form', async () => {
  const def = {
    page_type: 'action',
    recipe_name: 'ntp_describe',
    action_type: 'describe_form',
    nav_method: 'ui_steps',
    nav_template: [
      { action: 'goto', url: '{{url}}' },
      { action: 'expect_url', pattern: GH_POSTING },
      { action: 'run_generic_action', ref: 'describe_form' },
    ],
  };
  const closed = await runFixture(def, { url: `${base()}/co/jobs/1` });
  assert.strictEqual(closed.success, false, JSON.stringify(closed).slice(0, 500));
  assert.strictEqual(closed.notThePage.landed, `${base()}/co?error=true`);
  assert.strictEqual(closed.article, null);
  assert.strictEqual(closed.diagnostics, undefined, 'no form was described');
  const open = await runFixture(def, { url: `${base()}/co/jobs/2` });
  assert.strictEqual(open.success, true, JSON.stringify(open).slice(0, 500));
  const forms = (open.diagnostics || []).find((d) => d && d.kind === 'forms');
  assert.ok(forms && forms.fields.length >= 2, JSON.stringify(open.diagnostics).slice(0, 500));
});

test('engine (listing): expect_url in a listing recipe gives records and count null', async () => {
  const r = await runFixture({
    page_type: 'listing',
    recipe_name: 'ntp_listing',
    nav_method: 'ui_steps',
    nav_template: [{ action: 'goto', url: '{{url}}' }, { action: 'expect_url', pattern: '/co/jobs/\\d+$' }],
    card_selector: 'tr.job-post',
  }, { url: `${base()}/co/jobs/1` });
  assert.strictEqual(r.success, false, JSON.stringify(r).slice(0, 500));
  assert.strictEqual(r.notThePage.landed, `${base()}/co?error=true`);
  assert.strictEqual(r.records, null, 'null, not [] -- nothing was read');
  assert.strictEqual(r.count, null);
});

test('engine: a recipe whose expect_url pattern does not compile fails as an engine error, not NOT-THE-PAGE', async () => {
  const def = articleDef('ntp_badpattern');
  def.nav_template[1] = { action: 'expect_url', pattern: '(unclosed' };
  const r = await runFixture(def, { url: `${base()}/co/jobs/2` });
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.notThePage, undefined);
  assert.match(r.error, /Engine threw: .*not a valid regular expression/);
});

// ---- goto_frame -------------------------------------------------------------------

const frameDef = (name) => ({
  page_type: 'action',
  recipe_name: name,
  action_type: 'describe_form',
  nav_method: 'ui_steps',
  nav_template: [
    { action: 'goto', url: '{{url}}' },
    { action: 'goto_frame', selector: 'iframe#grnhse_iframe', timeout: 3000 },
    { action: 'expect_url', pattern: GH_POSTING },
    { action: 'run_generic_action', ref: 'describe_form' },
  ],
});

test('engine: goto_frame opens the embedded form as the page, and expect_url sees the frame URL', async () => {
  const r = await runFixture(frameDef('ntp_frame'), { url: `${base()}/emp` });
  assert.strictEqual(r.success, true, JSON.stringify(r).slice(0, 500));
  assert.strictEqual(r.url, `${base()}/embed/job_app?for=emp&token=2`);
  const forms = (r.diagnostics || []).find((d) => d && d.kind === 'forms');
  assert.ok(forms && forms.fields.length >= 2, JSON.stringify(r.diagnostics).slice(0, 500));
});

test('engine: goto_frame on an iframe with no src is an error naming it, not a run on the outer page', async () => {
  const r = await runFixture(frameDef('ntp_frame'), { url: `${base()}/emp-nosrc` });
  assert.strictEqual(r.success, false, JSON.stringify(r).slice(0, 500));
  assert.match(r.error, /goto_frame: iframe#grnhse_iframe has no http\(s\) src/);
});

// ---- the stored Greenhouse recipes ------------------------------------------------
//
// The recipes live in the gitignored DB, so a fresh clone has none: that is a
// visible skip, never a pass. Where they exist, each must carry an expect_url
// right after its goto whose pattern rejects the closed posting's landing URL
// from the report and accepts the open shapes.

const CLOSED_LANDED = 'https://job-boards.greenhouse.io/allianceus?error=true';
const CLOSED_EMBED_LANDED = 'https://job-boards.greenhouse.io/embed/job_board?for=pantheon&error=true';
const OPEN = [
  'https://job-boards.greenhouse.io/figma/jobs/5691911004',
  'https://job-boards.greenhouse.io/embed/job_app?for=rstudio&token=7999513003',
];

for (const target of ['job-boards.greenhouse.io#article', 'job-boards.greenhouse.io#action:describe_application_form']) {
  test(`stored recipe ${target}: expect_url rejects a closed posting's board, accepts an open posting`, (t) => {
    const { hostname, pageType, recipeName } = parseSiteArg(target);
    const site = getSite(db, hostname, pageType, recipeName);
    if (!site) return t.skip(`no ${target} in this DB (a fresh clone has no recipes)`);
    assert.strictEqual(site.nav_method, 'ui_steps', `${target} must run steps so expect_url can run`);
    const steps = JSON.parse(site.nav_template);
    const at = steps.findIndex((s) => s.action === 'expect_url');
    assert.ok(at > 0, `${target} has no expect_url step: a closed posting reads as a success`);
    assert.strictEqual(steps[at - 1].action, 'goto', `${target}: expect_url must follow the goto directly`);
    const pattern = steps[at].pattern;
    for (const landed of [CLOSED_LANDED, CLOSED_EMBED_LANDED]) {
      assert.ok(checkExpectUrl({ pattern, landed }), `${target} pattern ${pattern} accepts ${landed}`);
    }
    for (const landed of OPEN) {
      assert.strictEqual(checkExpectUrl({ pattern, landed }), null, `${target} pattern ${pattern} rejects ${landed}`);
    }
  });
}

// ---- the stored wellfound recipe ------------------------------------------------
//
// Found 2026-10-09 (scripts' dry sweep, scripts/TODO.md item 15): 38 of 52
// profile titles returned exactly 48 records each from wellfound.com#listing.
// Counterfactual run the same day: role=zzqx-nonsense-slug-4471 asked for
// /role/r/zzqx-nonsense-slug-4471, landed on https://wellfound.com/remote (same
// host, so lib/forwarded.js stays quiet) and returned success:true with 48
// records of the general remote listing -- the role parameter changed nothing
// for any slug wellfound does not know. Real slugs (sales, software-engineer)
// stay on /role/r/<slug>. So the stored recipe must reject the /remote landing
// and accept the real shapes; a run of an unknown slug is then notThePage with
// records null (the engine side is held by the listing test above).

const WELLFOUND_FALLBACK = [
  'https://wellfound.com/remote',
  'https://wellfound.com/role/r/', // a blank slug is not a role page either
  'https://wellfound.com/jobs',
];
const WELLFOUND_REAL = [
  'https://wellfound.com/role/r/sales',
  'https://wellfound.com/role/r/software-engineer',
  'https://wellfound.com/role/r/software-engineer?page=2',
];

test('stored recipe wellfound.com#listing: expect_url rejects the /remote fallback, accepts a real role page', (t) => {
  const site = getSite(db, 'wellfound.com', 'listing', 'default');
  if (!site) return t.skip('no wellfound.com#listing in this DB (a fresh clone has no recipes)');
  assert.strictEqual(site.nav_method, 'ui_steps', 'wellfound must run steps so expect_url can run');
  const steps = JSON.parse(site.nav_template);
  const at = steps.findIndex((s) => s.action === 'expect_url');
  assert.ok(at > 0, 'wellfound has no expect_url step: an unknown role slug reads as the /remote listing');
  assert.strictEqual(steps[at - 1].action, 'goto', 'wellfound: expect_url must follow the goto directly');
  assert.match(steps[at - 1].url, /\{\{role\}\}/, 'wellfound: the goto must carry the role parameter');
  const pattern = steps[at].pattern;
  for (const landed of WELLFOUND_FALLBACK) {
    assert.ok(checkExpectUrl({ pattern, landed }), `wellfound pattern ${pattern} accepts the fallback ${landed}`);
  }
  for (const landed of WELLFOUND_REAL) {
    assert.strictEqual(checkExpectUrl({ pattern, landed }), null, `wellfound pattern ${pattern} rejects ${landed}`);
  }
});
