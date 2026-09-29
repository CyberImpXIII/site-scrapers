// Borrowing another host's session jar, read-only.
//
// lab.js's diagnostic probes run under the hostname `lab-prober.internal`
// while navigating to whatever URL is being diagnosed. Session jars are keyed
// by hostname and saveSessionCookies filters cookies by domain, so the prober
// could never carry or keep a real site's cookies. On a page that needs one it
// therefore loaded logged out and reported "card_selector matched nothing" --
// a confidently WRONG statement about the page rather than an admission that
// it could not read it. joblist.ala.org returns 21 records with its session
// and times out without one, so every probe against it was wrong that way.
//
// params.sessionHostname lets a run key the jar to the host it is actually
// visiting. The danger it introduces is the opposite one: a diagnostic writing
// into the jar a real recipe depends on. joblist persists filter and view
// state in cookies, so that would change what the next real run returns and
// the failure would look like the site changing. A borrowed jar is therefore
// read-only, and this file pins that -- including the counterfactual that the
// check can detect a write at all.
//
// Run via `npm test` / `./test.sh`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const { openDb, upsertSite, insertField, deleteSite } = require('../db');
const { sessionFilePath, SESSION_DIR } = require('../lib/runner');
const { authorizeForTests } = require('../lib/writeGuard');

const REPO_ROOT = path.join(__dirname, '..');
// A host that does not resolve: nothing here ever navigates to it, it only
// names a jar to borrow.
const LENDER = 'borrowtest.example';
const RECIPE = 'session_borrow_fixture_test';

let server;
let baseUrl;
let db;
let siteId;
const createdJars = [];

function jarPath(hostname) {
  return sessionFilePath(hostname, 'default');
}

function writeJar(hostname, cookies) {
  const file = jarPath(hostname);
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ hostname, sessionName: 'default', savedAt: '2020-01-01T00:00:00.000Z', cookies }, null, 2),
    { mode: 0o600 }
  );
  if (!createdJars.includes(file)) createdJars.push(file);
  return file;
}

test.before(async () => {
  authorizeForTests();
  // The fixture SETS a cookie, so a run that persists its jar demonstrably
  // changes the file -- which is what makes the read-only assertion meaningful.
  server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Set-Cookie', `fixture_marker=${Date.now()}; Path=/`);
      res.end(
        '<!doctype html><html><body><ul>' +
          Array.from({ length: 3 }, (_, i) => `<li class="card"><h2>Engineer ${i}</h2><a href="/job/${i}">View job</a></li>`).join('') +
          '</ul></body></html>'
      );
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/`;
  db = openDb();
  siteId = upsertSite(db, {
    hostname: '127.0.0.1',
    page_type: 'listing',
    recipe_name: RECIPE,
    status: 'working',
    nav_method: 'url_param',
    nav_template: baseUrl,
    card_selector: 'li.card',
    card_min_text_len: 1,
    ready_timeout_ms: 8000,
    notes: 'Test-only recipe for test/session-borrow.test.js. Safe to delete if found stray.',
  });
  insertField(db, siteId, { field_name: 'title', extract_kind: 'child_text', regex_pattern: 'h2' }, 0);
});

test.after(() => {
  if (siteId) deleteSite(db, siteId);
  for (const f of createdJars) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* already gone */
    }
  }
  server.close();
});

async function run(params) {
  const args = ['engine.js', `127.0.0.1#listing:${RECIPE}`, JSON.stringify({ noDiagnostics: true, ...params })];
  try {
    const { stdout } = await execFileAsync(process.execPath, args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (e) {
    return JSON.parse(e.stdout);
  }
}

// The counterfactual FIRST. If a normal run did not rewrite its own jar, the
// read-only assertion below would pass for the wrong reason and prove nothing.
test('a run with its OWN jar writes to it', async () => {
  const file = writeJar('127.0.0.1', []);
  const before = fs.readFileSync(file, 'utf8');
  const r = await run({});
  assert.equal(r.success, true, 'the fixture recipe must actually run');
  const after = fs.readFileSync(file, 'utf8');
  assert.notEqual(after, before, 'a normal run persists its session — if this fails the next test is vacuous');
});

test('a BORROWED jar is loaded but never written', async () => {
  const lender = writeJar(LENDER, [
    { name: 'borrowed_marker', value: 'do-not-touch', domain: LENDER, path: '/', httpOnly: false, secure: false },
  ]);
  const before = fs.readFileSync(lender, 'utf8');
  const r = await run({ sessionHostname: LENDER });
  assert.equal(r.success, true);
  assert.equal(r.count, 3, 'borrowing a jar must not change what the recipe extracts');
  assert.equal(fs.readFileSync(lender, 'utf8'), before, 'the borrowed jar must be byte-identical after the run');
});

test('borrowing does not write the runner-hostname jar either', async () => {
  // The write must be SKIPPED, not merely redirected -- otherwise a probe
  // silently accumulates state under whichever hostname it ran as.
  writeJar(LENDER, [{ name: 'borrowed_marker', value: 'x', domain: LENDER, path: '/' }]);
  const own = writeJar('127.0.0.1', []);
  const before = fs.readFileSync(own, 'utf8');
  await run({ sessionHostname: LENDER });
  assert.equal(fs.readFileSync(own, 'utf8'), before);
});

test('naming your OWN hostname is not borrowing, so it still persists', async () => {
  // sessionHostname equal to the recipe's hostname is a no-op, not a
  // read-only switch -- otherwise passing it explicitly would quietly stop a
  // real recipe saving its login.
  const file = writeJar('127.0.0.1', []);
  const before = fs.readFileSync(file, 'utf8');
  await run({ sessionHostname: '127.0.0.1' });
  assert.notEqual(fs.readFileSync(file, 'utf8'), before);
});

test('noSession still beats sessionHostname', async () => {
  const lender = writeJar(LENDER, [{ name: 'borrowed_marker', value: 'x', domain: LENDER, path: '/' }]);
  const before = fs.readFileSync(lender, 'utf8');
  const r = await run({ sessionHostname: LENDER, noSession: true });
  assert.equal(r.success, true);
  assert.equal(fs.readFileSync(lender, 'utf8'), before, 'noSession must not read or write any jar');
});

test('a missing borrowed jar is not an error', async () => {
  // The prober points at arbitrary hosts, most of which have no jar at all.
  const absent = jarPath('nojar.example');
  try {
    fs.unlinkSync(absent);
  } catch {
    /* expected */
  }
  const r = await run({ sessionHostname: 'nojar.example' });
  assert.equal(r.success, true);
  assert.equal(fs.existsSync(absent), false, 'a borrowed run must not CREATE the jar it failed to find');
});
