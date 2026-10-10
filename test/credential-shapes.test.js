// lib/credentialShapes.js: what a credential looks like by name and by value
// shape, and the seams it creates.
//   1. VALUE_SHAPES must mean what the installed no-secrets hook means (its
//      SHAPES are tools/checks' list, rendered as ERE): same kinds, same order,
//      and each side matches the same samples. A kind added upstream fails here.
//   2. Key names: the suffix rule catches user_password / authToken, and does
//      not catch ordinary params.
//   3. query.js run-secrets (lib/runSecrets.js) counts by name and shape and
//      never prints a value.
//   4. lab.js history / adopt-history never replay a redaction marker.
//
// Every fake is assembled from parts at run time, so this file never holds a
// credential shape (the no-secrets hook would refuse it, and should).

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { VALUE_SHAPES, credentialShapeOf, cutCredentialShapes, isCredentialKey } = require('../lib/credentialShapes');
const { redactRunParams, holdsRedacted } = require('../lib/fillContract');
const { scanRunRows } = require('../lib/runSecrets');

const REPO = path.join(__dirname, '..');
const HOOK = path.join(REPO, '.claude', 'hooks', 'no-secrets.sh');

const rep = (s, n) => s.repeat(Math.ceil(n / s.length)).slice(0, n);
// One sample per kind, and one just too short to be it.
const SAMPLES = {
  'Anthropic API key': [['sk', '-ant-', rep('aB3_', 24)].join(''), ['sk', '-ant-', 'aB3'].join('')],
  'OpenAI API key': [['sk', '-', rep('aB3', 40)].join(''), ['sk', '-', rep('aB3', 20)].join('')],
  'GitHub token': [['gh', 'p_', rep('aB3', 36)].join(''), ['gh', 'p_', rep('aB3', 20)].join('')],
  'GitHub fine-grained token': [['github', '_pat_', rep('aB3_', 55)].join(''), ['github', '_pat_', rep('aB3', 20)].join('')],
  'AWS access key id': [['AK', 'IA', 'ABCDEFGH23456789'].join(''), ['AK', 'IA', 'ABCDEFGH2345'].join('')],
  'Slack token': [['xo', 'xb-', rep('aB3-', 14)].join(''), ['xo', 'xb-', 'aB3'].join('')],
  'Google API key': [['AI', 'za', rep('aB3_-', 35)].join(''), ['AI', 'za', rep('aB3', 20)].join('')],
  'Telegram bot token': [['123456789', ':', 'AA', rep('aB3_-', 33)].join(''), ['123456789', ':', 'AA', 'aB3'].join('')],
  'private key block': [['-----BEGIN ', 'RSA PRIVATE', ' KEY-----'].join(''), ['-----BEGIN ', 'RSA PUBLIC', ' KEY-----'].join('')],
};

// The hook's KINDS and SHAPES arrays, with ${L} / ${R} expanded as bash would.
function hookShapes() {
  const src = fs.readFileSync(HOOK, 'utf8');
  const edge = name => {
    const m = new RegExp(`(?:^|[;\\s])${name}='([^']*)'`, 'm').exec(src);
    assert.ok(m, `no-secrets.sh defines ${name}`);
    return m[1];
  };
  const L = edge('L');
  const R = edge('R');
  const array = name => {
    const m = new RegExp(`^${name}=\\(\\n([\\s\\S]*?)\\n\\)`, 'm').exec(src);
    assert.ok(m, `no-secrets.sh defines ${name}=( ... )`);
    return m[1].split('\n').map(l => l.trim()).filter(Boolean).map(l => {
      const q = l[0];
      const body = l.slice(1, -1);
      return q === '"' ? body.replace(/\$\{L\}/g, L).replace(/\$\{R\}/g, R) : body;
    });
  };
  return { kinds: array('KINDS'), shapes: array('SHAPES') };
}

const ereMatches = (pattern, text) =>
  spawnSync('grep', ['-qE', '-e', pattern], { input: `${text}\n`, env: { ...process.env, LC_ALL: 'C' } }).status === 0;

test('VALUE_SHAPES means what the installed no-secrets hook means: same kinds, same verdicts', () => {
  const { kinds, shapes } = hookShapes();
  assert.equal(shapes.length, kinds.length, 'the hook pairs each kind with one shape');
  assert.deepEqual(VALUE_SHAPES.map(s => s.kind), kinds, 'a kind added to the hook (tools/checks SHAPES) must be added to lib/credentialShapes.js');
  assert.deepEqual(Object.keys(SAMPLES), kinds, 'every kind has a sample here');
  kinds.forEach((kind, i) => {
    const [yes, no] = SAMPLES[kind];
    for (const [text, label] of [[yes, 'bare'], [`see ${yes} here`, 'in prose'], [`https://h.test/p?t=${yes}`, 'in a URL']]) {
      assert.ok(ereMatches(shapes[i], text), `hook: ${kind} (${label})`);
      assert.equal(credentialShapeOf(text), kind, `JS: ${kind} (${label})`);
    }
    assert.ok(!ereMatches(shapes[i], no), `hook rejects the short ${kind}`);
    assert.equal(credentialShapeOf(no), null, `JS rejects the short ${kind}`);
    // Glued to a word character on the left: neither side calls it a token
    // (the Anthropic and private-key shapes have no left edge, in both).
    if (shapes[i].startsWith('(^|')) {
      assert.ok(!ereMatches(shapes[i], `Z${yes}`), `hook: ${kind} needs a left edge`);
      assert.equal(credentialShapeOf(`Z${yes}`), null, `JS: ${kind} needs a left edge`);
    }
  });
});

test('ordinary param values are not credential-shaped', () => {
  for (const v of [
    'archivist',
    'senior data engineer remote',
    'https://boards.greenhouse.io/acme/jobs/4012345?gh_src=abc',
    rep('0123456789abcdef', 64), // a submissionHash
    'data team lead role', // four groups of four letters: an app password only under a secret key
    'sk-learn',
    '',
  ]) assert.equal(credentialShapeOf(v), null, v);
});

test('cutCredentialShapes removes every span and keeps the rest', () => {
  const a = SAMPLES['GitHub token'][0];
  const b = SAMPLES['Slack token'][0];
  const out = cutCredentialShapes(`GET https://h.test/${a}/x?k=${b} failed`);
  assert.equal(out, 'GET https://h.test/[redacted]/x?k=[redacted] failed');
});

test('a credential-shaped value under a NEUTRAL name is redacted, with its kind', () => {
  const tok = SAMPLES['GitHub token'][0];
  const out = redactRunParams({ q: 'archivist', x: tok, nested: { note: `use ${SAMPLES['AWS access key id'][0]} ok` }, list: [tok] });
  assert.equal(out.q, 'archivist');
  assert.deepEqual(out.x, { redacted: true, shape: 'GitHub token' });
  assert.deepEqual(out.nested.note, { redacted: true, shape: 'AWS access key id' });
  assert.deepEqual(out.list, [{ redacted: true, shape: 'GitHub token' }]);
  assert.ok(!JSON.stringify(out).includes(tok));
  // answers keep their key names even when the string also holds a shape
  assert.deepEqual(redactRunParams({ answers: JSON.stringify({ '#a': tok }) }).answers, { redacted: true, keys: ['#a'] });
});

test('credential key names: the suffix rule, camelCase, and the ordinary names it leaves alone', () => {
  for (const k of ['password', 'user_password', 'authToken', 'userPass', 'x-api-key', 'apiKey', 'client_secret', 'refresh_token',
    'private_key', 'credentials', 'pwd', 'otp', 'card_number', 'ssn', 'passcode']) assert.ok(isCredentialKey(k), k);
  for (const k of ['q', 'keywords', 'role', 'answers', 'url', 'bypass', 'compass', 'laptop', 'session', 'description', 'tokens', 'sort_key', 'lesson'])
    assert.ok(!isCredentialKey(k), k);
});

test('run-secrets counts by name and shape, and never prints a value', () => {
  const tok = SAMPLES['Slack token'][0];
  const pw = ['Fx', 'pw-1'].join('');
  const rows = [
    { params_json: JSON.stringify({ q: 'a', x: tok, user_password: pw }), error: `nav to /${tok} failed` },
    { params_json: JSON.stringify({ q: 'b', password: { redacted: true } }), error: null },
    { params_json: JSON.stringify({ q: 'c' }), error: 'timeout' },
    { params_json: 'not json', error: null },
  ];
  const r = scanRunRows(rows);
  assert.equal(r.rows, 4);
  assert.equal(r.rowsWithCredential, 1);
  assert.deepEqual(r.byKeyName, { user_password: { rows: 1, unredacted: 1 }, password: { rows: 1, unredacted: 0 } });
  assert.deepEqual(r.byShape, { 'Slack token': { rows: 1, keys: ['x'] } });
  assert.deepEqual(r.errorShapes, { 'Slack token': 1 });
  assert.equal(r.unparsedParams, 1);
  const printed = JSON.stringify(r);
  assert.ok(!printed.includes(tok) && !printed.includes(pw), 'no value in the report');
  assert.equal(scanRunRows([]).rowsWithCredential, 0);
});

test('holdsRedacted finds a marker at any depth, and only a marker', () => {
  assert.ok(holdsRedacted({ x: { redacted: true, shape: 'GitHub token' } }));
  assert.ok(holdsRedacted({ a: [{ b: { redacted: true } }] }));
  assert.ok(!holdsRedacted({ q: 'redacted', a: { redacted: 'yes' } }));
  assert.ok(!holdsRedacted(null));
});

test('lab.js history / adopt-history never replay a redacted param set', () => {
  const { authorizeForTests } = require('../lib/writeGuard');
  const { openDb, upsertSite, logRun, deleteSite, getSite } = require('../db');
  authorizeForTests();
  const db = openDb();
  const host = `cred-shapes-${process.pid}.test`;
  const id = upsertSite(db, {
    hostname: host,
    page_type: 'listing',
    recipe_name: 'default',
    status: 'needs-review',
    nav_method: 'url_param',
    nav_template: 'http://127.0.0.1:9/{{q}}/{{x}}',
    card_selector: 'div.card',
    notes: 'Test-only recipe for test/credential-shapes.test.js.',
  });
  try {
    logRun(db, { siteId: id, params: { q: 'plain', x: 'ordinary' }, success: true, resultCount: 3 });
    logRun(db, { siteId: id, params: { q: 'secret', x: SAMPLES['GitHub token'][0] }, success: true, resultCount: 3 });
    const lab = args => JSON.parse(execFileSync(process.execPath, [path.join(REPO, 'lab.js'), ...args], { cwd: REPO, encoding: 'utf8', env: process.env }));
    const hist = lab(['history', host]);
    assert.deepEqual(hist.paramsThatReturnedRecords.map(d => d.params), [{ q: 'plain', x: 'ordinary' }]);
    assert.equal(hist.skippedRedacted, 1);
    const adopt = lab(['adopt-history', host, '--force']);
    assert.deepEqual(adopt.probeValues, [{ q: 'plain', x: 'ordinary' }], 'the redacted set is not adopted');
    assert.deepEqual(JSON.parse(getSite(db, host, 'listing', 'default').param_probe_values), [{ q: 'plain', x: 'ordinary' }]);
  } finally {
    deleteSite(db, id);
    db.close();
  }
});
