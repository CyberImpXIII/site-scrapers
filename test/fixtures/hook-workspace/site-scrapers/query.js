// FIXTURE: stand-in `query.js sites` for test/hooks.test.js. Same table as the
// fixture dev.sh's `known`.
// Hostnames are the IANA example domains, not *.test: since tools/hooks/source
// 79703b6 the hook tests pick fixtures only from STABLE hosts and skip reserved
// TLDs (.test .invalid .example ...) as suite scaffolding, so *.test here made
// every recipe case SKIP (2026-10-05). example.com/.net/.org look like real
// domains to that filter and are never fetched: the hooks only ask `known`.
if (process.argv[2] === 'sites') {
  console.log(JSON.stringify([
    { hostname: 'example.com', status: 'working' },
    { hostname: 'example.net', status: 'broken' },
    { hostname: 'example.org', status: 'blocked-attn' },
  ]));
}
