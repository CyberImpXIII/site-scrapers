// lib/fixtureHosts.js and the two things that ask it: check-hooks.sh's probe
// host (devtools/probe-host.js) and the live-store fingerprint test.sh takes
// around the suite (devtools/db-fingerprint.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { isFixtureHost } = require('../lib/fixtureHosts');
const { probeHost } = require('../devtools/probe-host');
const { diff } = require('../devtools/db-fingerprint');

const REPO = path.join(__dirname, '..');

test('fixture hosts are the loopback and reserved names, and nothing real', () => {
  for (const h of ['127.0.0.1', '127.0.0.2', 'localhost', 'cycle.test', 'a.example', 'x.invalid', 'foo.localhost', 'multi-select.internal', 'example.com', 'www.example.org']) {
    assert.equal(isFixtureHost(h), true, h);
  }
  for (const h of ['linkedin.com', 'job-boards.greenhouse.io', 'wellfound.com', 'example.co', 'test.com', 'internal.io', 'testing.example.co.uk', null, '']) {
    assert.equal(isFixtureHost(h), false, String(h));
  }
});

test('the probe host skips fixtures and is the same whatever the order', () => {
  const sites = [
    { hostname: '127.0.0.1', status: 'working' },
    { hostname: 'zeta.com', status: 'working' },
    { hostname: 'cycle.test', status: 'working' },
    { hostname: 'alpha.com', status: 'broken' },
    { hostname: 'beta.com', status: 'working' },
  ];
  assert.equal(probeHost(sites), 'beta.com');
  assert.equal(probeHost([...sites].reverse()), 'beta.com', 'order must not matter (it was .[0])');
  // No real host at all (check-hooks.sh's fixture workspace): a fixture
  // answers, the same one whatever the order; a real one always wins.
  const onlyFixtures = sites.filter(s => s.hostname === '127.0.0.1' || s.hostname === 'cycle.test');
  assert.equal(probeHost(onlyFixtures), '127.0.0.1');
  assert.equal(probeHost([...onlyFixtures].reverse()), '127.0.0.1');
  assert.equal(probeHost([{ hostname: 'example.com', status: 'working' }, { hostname: 'zz.org', status: 'working' }]), 'zz.org');
  assert.equal(probeHost([{ hostname: 'example.com', status: 'broken' }]), null, 'nothing working -> no host');
  assert.equal(probeHost('not a list'), null);
});

test('check-hooks.sh picks its probe host through devtools/probe-host.js, not .[0]', () => {
  const src = fs.readFileSync(path.join(REPO, 'check-hooks.sh'), 'utf8');
  assert.match(src, /devtools\/probe-host\.js/);
  assert.doesNotMatch(src, /\.\[0\]\.hostname/);
});

test('the fingerprint diff names every changed leaf and nothing else', () => {
  const a = { scrapers: { seq: { sites: 10, change_log: 4 }, fixtureSites: 2, fixtureRuns: 1 }, failures: { seq: { failures: 3 } } };
  assert.deepEqual(diff(a, JSON.parse(JSON.stringify(a))), []);
  const b = { scrapers: { seq: { sites: 11, change_log: 4 }, fixtureSites: 2, fixtureRuns: 1 }, failures: { seq: { failures: 3 } } };
  assert.deepEqual(diff(a, b), ['scrapers.seq.sites: 10 -> 11']);
  const c = { scrapers: a.scrapers, failures: null };
  assert.deepEqual(diff(a, c), ['failures: {"seq":{"failures":3}} -> null']);
});
