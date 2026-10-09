// Hosts that only tests use: a loopback address, or a name RFC 2606 / RFC 6762
// reserves (`.test`, `.example`, `.invalid`, `.localhost`, example.com/net/org)
// plus `.internal`, which this repo's own fixture recipes use. No real recipe
// can live on one, so anything that must pick a REAL host (check-hooks.sh's
// enforcement probe) or must tell a test's rows from live ones
// (devtools/db-fingerprint.js) asks here. test/fixture-hosts.test.js.

const FIXTURE_HOST = /^(127\.\d+\.\d+\.\d+|localhost|\[?::1\]?)$|\.(test|example|invalid|localhost|internal)$|^example\.(com|net|org)$/i;

function isFixtureHost(hostname) {
  return FIXTURE_HOST.test(String(hostname || '').replace(/^www\./i, ''));
}

module.exports = { FIXTURE_HOST, isFixtureHost };
