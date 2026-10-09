// The host check-hooks.sh probes prefer-recipes.sh with: a REAL host that has a
// working recipe, chosen the same way every time.
//
//   node query.js sites | node devtools/probe-host.js    -> one hostname, or nothing
//
// It used to be `jq '.[0].hostname'` over the working recipes, which picked
// whichever came first: during a suite run that could be a 127.0.0.1 fixture
// another test had just inserted (and would delete), so the probe depended on
// timing (TODO 0i/0m). A real host (not lib/fixtureHosts.js) always wins, and
// the hosts are sorted, so the answer is stable. Only when NO real host is
// working does a fixture host answer: check-hooks.sh's own fixture workspace
// (test/hooks.test.js) has exactly one, example.com, and the live store always
// has real ones (and the suite no longer writes the live store at all: SS_DB).
// test/fixture-hosts.test.js.

const { isFixtureHost } = require('../lib/fixtureHosts');

function probeHost(sites) {
  if (!Array.isArray(sites)) return null;
  const hosts = sites
    .filter(s => s && s.status === 'working' && typeof s.hostname === 'string' && s.hostname)
    .map(s => s.hostname)
    .sort();
  return hosts.find(h => !isFixtureHost(h)) ?? hosts[0] ?? null;
}

if (require.main === module) {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => (buf += c));
  process.stdin.on('end', () => {
    let sites = null;
    try {
      sites = JSON.parse(buf);
    } catch {
      /* not JSON: no host, and check-hooks.sh says UNCHECKED */
    }
    const h = probeHost(sites);
    if (h) process.stdout.write(h + '\n');
  });
}

module.exports = { probeHost };
