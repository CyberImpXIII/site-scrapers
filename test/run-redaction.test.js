// What scrape_runs may keep of a run's params and error text.
//
// Probed 2026-10-09 (the dispatcher's task B): of 1560 stored runs the only
// credential-named param key was `answers`, all 61 redacted; no credential
// value was found. The gap was structural: redaction covered `answers` alone,
// so a recipe declaring {{password}} or {{token}} would have had the value
// kept in params_json for ever, and an engine error quoting a param kept it
// in `error`. Redaction now happens inside db.js logRun, the table's only
// writer, using lib/credentialShapes.js -- the same list the store export
// refuses literals by.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { redactRunParams, redactRunError } = require('../lib/fillContract');
const { CRED_KEY } = require('../lib/credentialShapes');
const { openDb, upsertSite, logRun, deleteSite } = require('../db');
const { authorizeForTests } = require('../lib/writeGuard');

const REPO = path.join(__dirname, '..');

// Fake values, long enough to be searched for; nothing real.
const PW = 'fixture-pw-7731';
const TOKEN = 'fixture-token-ab12cd34';
const ANSWER = 'Fixture Answer Text';

test('credential-named params are replaced at any depth; ordinary ones stay', () => {
  const out = redactRunParams({
    q: 'archivist',
    password: PW,
    auth: { access_token: TOKEN, user: 'someone' },
    list: [{ api_key: 'k-123456' }],
  });
  assert.equal(out.q, 'archivist');
  assert.deepEqual(out.password, { redacted: true });
  assert.deepEqual(out.auth, { access_token: { redacted: true }, user: 'someone' });
  assert.deepEqual(out.list, [{ api_key: { redacted: true } }]);
  assert.ok(!JSON.stringify(out).includes(PW) && !JSON.stringify(out).includes(TOKEN));
});

test('answers keep their key names only (unchanged behaviour)', () => {
  assert.deepEqual(redactRunParams({ answers: { '#a': ANSWER } }).answers, { redacted: true, keys: ['#a'] });
  assert.deepEqual(redactRunParams({ answers: JSON.stringify({ '#a': ANSWER }) }).answers, { redacted: true, keys: ['#a'] });
});

test('an error quoting a credential or an answer has the value cut out', () => {
  const params = { q: 'archivist', password: PW, answers: JSON.stringify({ '#a': ANSWER }) };
  const err = `selector not found typing "${PW}"; JSON: {"x":"${ANSWER}"}; query archivist`;
  const out = redactRunError(err, params);
  assert.ok(!out.includes(PW), out);
  assert.ok(!out.includes(ANSWER), out);
  assert.match(out, /query archivist/, 'an ordinary param value is not a secret');
  assert.equal(redactRunError(null, params), null);
  assert.equal(redactRunError('plain', {}), 'plain');
  // The JSON-escaped form a stringified error carries.
  const quoted = 'a"b\\c-pw';
  assert.ok(!redactRunError(`got ${JSON.stringify(quoted)}`, { token: quoted }).includes('b\\\\c'));
});

test('logRun (the only writer) stores neither the value nor an error quoting it', () => {
  authorizeForTests();
  const db = openDb();
  const host = `run-redaction-${process.pid}.test`;
  const id = upsertSite(db, {
    hostname: host,
    page_type: 'listing',
    recipe_name: 'default',
    status: 'needs-review',
    nav_method: 'url_param',
    nav_template: 'http://127.0.0.1:9/{{q}}',
    card_selector: 'div.card',
    notes: 'Test-only recipe for test/run-redaction.test.js.',
  });
  try {
    logRun(db, {
      siteId: id,
      params: { q: 'x', password: PW, answers: { '#a': ANSWER } },
      success: false,
      error: `could not type ${PW} into #password (answer ${ANSWER})`,
    });
    const row = db.prepare('SELECT params_json, error FROM scrape_runs WHERE site_id = ? ORDER BY id DESC LIMIT 1').get(id);
    for (const v of [PW, ANSWER]) {
      assert.ok(!row.params_json.includes(v), `params_json holds ${v}`);
      assert.ok(!row.error.includes(v), `error holds ${v}`);
    }
    assert.deepEqual(JSON.parse(row.params_json).password, { redacted: true });
    assert.match(row.error, /could not type \[redacted\] into #password/);
  } finally {
    deleteSite(db, id);
    db.close();
  }
});

test('one credential list: the store export takes it from lib/credentialShapes.js, not a copy', () => {
  const src = fs.readFileSync(path.join(REPO, 'lib', 'storeExport.js'), 'utf8');
  assert.match(src, /require\('\.\/credentialShapes'\)/);
  assert.doesNotMatch(src, /const CRED_KEY\s*=\s*\//, 'a second regex would drift');
  for (const k of ['password', 'token', 'api_key', 'client_secret', 'otp']) assert.ok(CRED_KEY.test(k), k);
  for (const k of ['q', 'keywords', 'role', 'answers', 'url']) assert.ok(!CRED_KEY.test(k), k);
});

// verify.js writes a blocked-attn recipe's NEXT STEP note into sites.notes,
// which is kept for good. It used to quote the raw params argument there, so
// a credential passed inline would have been stored in the recipe.
test('the NEXT STEP note quotes params without a credential or an answer value', () => {
  const { noteParamsArg } = require('../lib/fillContract');
  const plain = '{"q":"archivist"}';
  assert.deepEqual(noteParamsArg(plain, JSON.parse(plain)), { arg: plain, redacted: false });
  assert.deepEqual(noteParamsArg('@p.json', { password: PW }), { arg: '@p.json', redacted: false }, 'a path names no value');
  assert.deepEqual(noteParamsArg(undefined, {}), { arg: '{}', redacted: false });
  assert.deepEqual(noteParamsArg('--attended', {}), { arg: '{}', redacted: false });
  const raw = JSON.stringify({ q: 'x', password: PW, answers: { why: ANSWER } });
  const got = noteParamsArg(raw, JSON.parse(raw));
  assert.equal(got.redacted, true);
  assert.ok(!got.arg.includes(PW) && !got.arg.includes(ANSWER), got.arg);
  assert.deepEqual(JSON.parse(got.arg), { q: 'x', password: { redacted: true }, answers: { redacted: true } });

  const src = fs.readFileSync(path.join(REPO, 'verify.js'), 'utf8');
  const line = src.split('\n').find(l => l.includes('NEXT STEP FOR THE USER'));
  assert.ok(line, 'verify.js still writes a NEXT STEP note');
  assert.match(line, /noteParamsArg\(paramsArg, params\)/, 'the note quotes params through noteParamsArg');
  assert.doesNotMatch(line.replace(/noteParamsArg\(paramsArg, params\)/g, ''), /paramsArg/, 'and never paramsArg raw');
});
