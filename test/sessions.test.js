// Session persistence (lib/sessions.js, lib/runner.js).
//
// This handles authenticated session state — the saved cookie jars that let a
// login survive between runs. It had no tests, which is the worst place not to
// have them: a jar holds live credentials, and the module's whole job is to
// expose what exists WITHOUT exposing what it contains.
//
// The domain-matching rule here also has history. It was one-directional, which
// silently dropped LinkedIn's host-only `li_at` cookie: 5 junk cookies were
// saved instead of 11, and every run started logged out while appearing to have
// a session.
//
// Run via `npm test` / `./test.sh`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { listSessions, clearSession } = require('../lib/sessions');
const { sessionFilePath, SESSION_DIR, domainsMatch } = require('../lib/runner');

const HOST = 'sessiontest.example';
const created = [];

function writeJar(hostname, sessionName, cookies, mode = 0o600) {
  const file = sessionFilePath(hostname, sessionName);
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ hostname, sessionName, savedAt: new Date().toISOString(), cookies }, null, 2),
    { mode }
  );
  created.push(file);
  return file;
}

test.after(() => {
  for (const f of created) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* already gone */
    }
  }
});

// --- domainsMatch ----------------------------------------------------------

test('a cookie scoped to the exact host matches', () => {
  assert.equal(domainsMatch('example.com', 'example.com'), true);
});

test('a dot-prefixed parent domain matches a subdomain host', () => {
  // The ordinary case: ".example.com" is set for the whole family.
  assert.equal(domainsMatch('.example.com', 'www.example.com'), true);
  assert.equal(domainsMatch('example.com', 'www.example.com'), true);
});

test('a HOST-ONLY cookie on the bare domain matches a www host', () => {
  // The LinkedIn li_at case. A one-directional check dropped this, so a login
  // appeared to persist while every run actually started logged out.
  assert.equal(
    domainsMatch('linkedin.com', 'www.linkedin.com'),
    true,
    'the saved cookie domain may be shorter than the hostname being scraped'
  );
  assert.equal(
    domainsMatch('www.linkedin.com', 'linkedin.com'),
    true,
    'and longer — the match has to work in both directions'
  );
});

test('an unrelated domain does not match', () => {
  // The important negative: matching too broadly would write another site's
  // cookies into this jar, and send them on a later run.
  assert.equal(domainsMatch('evil.com', 'example.com'), false);
  assert.equal(domainsMatch('example.com', 'evil.com'), false);
  assert.equal(domainsMatch('notexample.com', 'example.com'), false);
});

// --- listSessions ----------------------------------------------------------

test('listSessions reports metadata and never a cookie value', () => {
  writeJar(HOST, 'default', [
    { name: 'li_at', value: 'SECRET-SESSION-TOKEN-must-not-appear', domain: HOST },
    { name: 'other', value: 'ANOTHER-SECRET-VALUE', domain: HOST },
  ]);
  const listed = listSessions(HOST);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].cookieCount, 2, 'the count is the useful part');
  assert.ok(listed[0].savedAt);

  const serialized = JSON.stringify(listed);
  assert.ok(!serialized.includes('SECRET-SESSION-TOKEN-must-not-appear'), 'a cookie value must never be listed');
  assert.ok(!serialized.includes('ANOTHER-SECRET-VALUE'));
  assert.ok(!serialized.includes('li_at'), 'not even a cookie NAME — it identifies the auth scheme');
});

test('listSessions filters by hostname', () => {
  writeJar(HOST, 'default', [{ name: 'a', value: 'x', domain: HOST }]);
  writeJar('other-sessiontest.example', 'default', [{ name: 'b', value: 'y', domain: 'other-sessiontest.example' }]);
  assert.deepEqual(listSessions(HOST).map(s => s.hostname), [HOST]);
  assert.ok(listSessions().length >= 2, 'with no filter it lists everything');
});

test('a corrupt jar is skipped rather than taking down the listing', () => {
  // A half-written file must not make `query.js sessions` unusable — that is the
  // command someone runs to find out what state they are in.
  const file = sessionFilePath('corrupt-sessiontest.example', 'default');
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.writeFileSync(file, '{ this is not json', { mode: 0o600 });
  created.push(file);
  assert.doesNotThrow(() => listSessions());
  assert.ok(!listSessions().some(s => s.hostname === 'corrupt-sessiontest.example'));
});

test('parallel sessions for one host are listed separately', () => {
  // Two accounts on one site must not share a jar, which is the whole point of
  // the sessionName.
  writeJar(HOST, 'accountA', [{ name: 'a', value: 'x', domain: HOST }]);
  writeJar(HOST, 'accountB', [{ name: 'b', value: 'y', domain: HOST }]);
  const names = listSessions(HOST).map(s => s.sessionName).sort();
  assert.ok(names.includes('accountA') && names.includes('accountB'));
});

// --- clearSession ----------------------------------------------------------

test('clearSession removes the named jar and reports whether it existed', () => {
  const file = writeJar(HOST, 'toclear', [{ name: 'a', value: 'x', domain: HOST }]);
  assert.equal(fs.existsSync(file), true);
  assert.equal(clearSession(HOST, 'toclear'), true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(clearSession(HOST, 'toclear'), false, 'a second clear reports that there was nothing to clear');
});

test('clearSession removes only the named session, not every jar for the host', () => {
  const keep = writeJar(HOST, 'keepme', [{ name: 'a', value: 'x', domain: HOST }]);
  writeJar(HOST, 'dropme', [{ name: 'b', value: 'y', domain: HOST }]);
  clearSession(HOST, 'dropme');
  assert.equal(fs.existsSync(keep), true, 'clearing one account must not log out the other');
});

test('clearSession defaults to the "default" session', () => {
  const file = writeJar(HOST, 'default', [{ name: 'a', value: 'x', domain: HOST }]);
  assert.equal(clearSession(HOST), true);
  assert.equal(fs.existsSync(file), false);
});

// --- File naming and permissions ------------------------------------------

test('a hostname cannot escape the session directory', () => {
  // The hostname reaches this from a recipe, so it is input. An unsanitised
  // "../../" would let a jar be written or deleted outside data/.sessions.
  for (const nasty of ['../../etc/passwd', 'a/b/c', '..', 'x\u0000y']) {
    const file = sessionFilePath(nasty, 'default');
    assert.equal(
      path.dirname(path.resolve(file)),
      path.resolve(SESSION_DIR),
      `"${nasty}" produced a path outside the session directory: ${file}`
    );
  }
});

test('the session name is sanitised too', () => {
  const file = sessionFilePath('example.com', '../../escape');
  assert.equal(path.dirname(path.resolve(file)), path.resolve(SESSION_DIR));
});

test('existing jars on disk are owner-only', () => {
  // These hold live authenticated cookies. writeFileSync's `mode` applies only on
  // CREATION, so a jar that predates that setting would otherwise keep a
  // world-readable mode indefinitely.
  if (!fs.existsSync(SESSION_DIR)) return;
  for (const f of fs.readdirSync(SESSION_DIR).filter(x => x.endsWith('.json'))) {
    const mode = fs.statSync(path.join(SESSION_DIR, f)).mode & 0o777;
    assert.equal(mode & 0o077, 0, `${f} is readable beyond its owner (mode ${mode.toString(8)})`);
  }
});
