// A listing page asked for on one site that lands on another is reported as
// forwarded, never as a slow page with no records (lib/forwarded.js, used by
// engine.js's url_param listing path and mirrored in `./dev.sh board`).
// Reported 2026-10-05 by applications: Greenhouse slugs stabilityai and
// dotmatics forward to the companies' own sites. Held three ways here: the
// rule, the engine against a local server that forwards from 127.0.0.1 to
// `localhost` (two sites by the rule, one process), and `dev.sh board` against
// a fake curl.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { forwardedOff, sameSite } = require('../lib/forwarded');
const { openDb, upsertSite, insertField, deleteSite } = require('../db');
const { authorizeForTests } = require('../lib/writeGuard');

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.join(__dirname, '..');

test('the cases applications reported are forwards, with where they went', () => {
  assert.deepStrictEqual(
    forwardedOff('https://job-boards.greenhouse.io/stabilityai', 'https://stability.ai/careers'),
    { from: 'https://job-boards.greenhouse.io/stabilityai', to: 'https://stability.ai/careers',
      fromHost: 'job-boards.greenhouse.io', toHost: 'stability.ai' });
  assert.strictEqual(
    forwardedOff('https://job-boards.greenhouse.io/dotmatics', 'https://www.dotmatics.com/jobs').toHost, 'dotmatics.com');
});

test('staying on the site is not a forward', () => {
  for (const [a, b] of [
    ['https://job-boards.greenhouse.io/splice', 'https://job-boards.greenhouse.io/splice?page=1'],
    ['https://boards.greenhouse.io/splice', 'https://job-boards.greenhouse.io/splice'],
    ['https://example.com/jobs', 'https://www.example.com/jobs'],
    ['https://jobs.example.co.uk/', 'https://careers.example.co.uk/'],
  ]) assert.strictEqual(forwardedOff(a, b), null, `${a} -> ${b}`);
});

test('an unparseable URL is no verdict, not a forward', () => {
  assert.strictEqual(forwardedOff('not a url', 'https://stability.ai/'), null);
  assert.strictEqual(forwardedOff('https://job-boards.greenhouse.io/x', 'about:blank'), null);
  assert.strictEqual(forwardedOff('https://job-boards.greenhouse.io/x', ''), null);
});

test('same-site is symmetric', () => {
  for (const [a, b] of [['a.example.com', 'example.com'], ['x.io', 'y.io'], ['greenhouse.io', 'stability.ai']]) {
    assert.strictEqual(sameSite(a, b), sameSite(b, a), `${a} ${b}`);
  }
});

// ---- the engine: a listing whose url_param page forwards off-site ----------
//
// The fixture server listens on 127.0.0.1 and forwards to `localhost` on the
// same port: one process, two sites by lib/forwarded.js's rule. Routes:
//   /board     cards                     -- the control: a board that is there
//   /empty     no cards                  -- the control: a plain timeout stays one
//   /fwd       302 to localhost/landing  -- an HTTP forward (stabilityai's shape)
//   /jsfwd     script forward after load -- a forward the card wait sits through
//   /landing   a company careers page, no cards

let server;
let port;
let db;
const createdSiteIds = [];

test.before(async () => {
  authorizeForTests();
  server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const landing = `http://localhost:${s.address().port}/landing`;
      if (req.url === '/fwd') { res.writeHead(302, { Location: landing }); return res.end(); }
      res.setHeader('Content-Type', 'text/html');
      if (req.url === '/jsfwd') {
        return res.end(`<!doctype html><title>Board</title><body>loading<script>setTimeout(() => { location.href = ${JSON.stringify(landing)}; }, 300);</script></body>`);
      }
      if (req.url === '/board') {
        return res.end('<!doctype html><title>Board</title><table><tr class="job-post"><td><a href="/j/1">Engineer</a></td></tr></table>');
      }
      return res.end('<!doctype html><title>Careers | Example</title><body>We are hiring. See our careers page.</body>');
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

async function runListing(name, urlPath) {
  const id = upsertSite(db, {
    hostname: '127.0.0.1',
    page_type: 'listing',
    recipe_name: name,
    // `working`, like test/extraction.test.js's 127.0.0.1 fixtures, never
    // needs-review: the hook test (test-prefer-recipes.sh, run by
    // hooks.test.js alongside this file) takes the first NOT-working host as
    // one the hook must allow, and 127.0.0.1 is covered while extraction's
    // fixtures exist -- a needs-review row here made it pick a covered host
    // and fail (2026-10-05).
    status: 'working',
    nav_method: 'url_param',
    nav_template: `http://127.0.0.1:${port}${urlPath}`,
    card_selector: 'tr.job-post',
    card_min_text_len: 1,
    ready_timeout_ms: 2500,
    notes: 'Test-only recipe for test/forwarded.test.js. Safe to delete if found stray.',
  });
  if (!createdSiteIds.includes(id)) createdSiteIds.push(id);
  db.prepare('DELETE FROM site_fields WHERE site_id = ?').run(id);
  insertField(db, id, { field_name: 'title', extract_kind: 'full_blob' }, 0);
  const args = ['engine.js', `127.0.0.1#listing:${name}`, '{"noSession":true,"noDiagnostics":true}'];
  try {
    const { stdout } = await execFileAsync(process.execPath, args, { cwd: REPO_ROOT, encoding: 'utf8' });
    return JSON.parse(stdout);
  } catch (e) {
    return JSON.parse(e.stdout);
  }
}

test('engine: a board that is there is not called forwarded', async () => {
  const r = await runListing('fwd_control_board', '/board');
  assert.strictEqual(r.success, true, JSON.stringify(r).slice(0, 400));
  assert.strictEqual(r.count, 1);
  assert.strictEqual(r.forwarded, undefined);
});

test('engine: a page with no cards on the same site is still a plain timeout', async () => {
  const r = await runListing('fwd_control_empty', '/empty');
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.timedOut, true);
  assert.strictEqual(r.forwarded, undefined);
  assert.strictEqual(r.count, 0);
  assert.ok(r.failureContext, 'a plain timeout keeps its failureContext');
});

test('engine: an HTTP forward off-site is reported as forwarded, records null, no wait', async () => {
  const started = Date.now();
  const r = await runListing('fwd_http', '/fwd');
  const took = Date.now() - started;
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.timedOut, false, 'no card wait on a page that can never have the cards');
  assert.deepStrictEqual(r.forwarded, {
    from: `http://127.0.0.1:${port}/fwd`, to: `http://localhost:${port}/landing`,
    fromHost: '127.0.0.1', toHost: 'localhost',
  });
  assert.strictEqual(r.records, null, 'null, not [] -- the board was not read, so its size is unknown');
  assert.strictEqual(r.count, null);
  assert.strictEqual(r.failureContext, undefined, 'not a wait failure, so no wait-failure context');
  assert.match(r.error, /forwarded off 127\.0\.0\.1 to http:\/\/localhost:\d+\/landing/);
  // 2500 ms is the card wait it must skip; a browser launch is well under the rest.
  assert.ok(took < 2500 + 15000, `took ${took} ms`);
});

test('engine: a script forward during the card wait is reported as forwarded too', async () => {
  const r = await runListing('fwd_js', '/jsfwd');
  assert.strictEqual(r.success, false);
  assert.ok(r.forwarded, JSON.stringify(r).slice(0, 400));
  assert.strictEqual(r.forwarded.toHost, 'localhost');
  assert.strictEqual(r.records, null);
  assert.strictEqual(r.count, null);
});

// ---- dev.sh board: a forwarded board is not a board ------------------------
//
// curl is replaced on PATH by a fake that prints a page and then the effective
// URL on its last line, the way `curl -w` does: `fwdco` forwards off
// greenhouse.io, `realco` stays, every other URL is empty (no board).

const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

test('dev.sh board: a forwarded slug prints FORWARDED with where it went, and is not a hit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fakecurl-'));
  try {
    fs.writeFileSync(path.join(dir, 'curl'), [
      '#!/usr/bin/env bash',
      'url="${@: -1}"',
      'case "$url" in',
      '  https://job-boards.greenhouse.io/fwdco) printf "<title>Careers | FwdCo</title>\\nhttps://www.fwdco.example/careers" ;;',
      '  https://job-boards.greenhouse.io/realco) printf "<title>Jobs at RealCo</title>\\n%s" "$url" ;;',
      '  https://boards.greenhouse.io/realco) printf "<title>Jobs at RealCo</title>\\nhttps://job-boards.greenhouse.io/realco" ;;',
      '  *) exit 6 ;;',
      'esac',
      '',
    ].join('\n'), { mode: 0o755 });
    const r = spawnSync('bash', [path.join(REPO_ROOT, 'dev.sh'), 'board', 'fwdco', 'realco'], {
      encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });
    const lines = r.stdout.split('\n');
    assert.ok(lines.some((l) => /job-boards\.greenhouse\.io\/fwdco\s+FORWARDED -> https:\/\/www\.fwdco\.example\/careers$/.test(l)), r.stdout);
    assert.ok(!lines.some((l) => /^fwdco\s.*Careers \| FwdCo/.test(l)), `the forwarded page's title must not read as a board:\n${r.stdout}`);
    assert.ok(lines.some((l) => /^fwdco\s+no candidate board found/.test(l)), r.stdout);
    assert.ok(lines.some((l) => /^realco\s+https:\/\/job-boards\.greenhouse\.io\/realco\s.*Jobs at RealCo/.test(l)), r.stdout);
    assert.ok(lines.some((l) => /^realco\s+https:\/\/boards\.greenhouse\.io\/realco\s.*Jobs at RealCo/.test(l)),
      `a redirect between greenhouse hosts is the same site:\n${r.stdout}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
