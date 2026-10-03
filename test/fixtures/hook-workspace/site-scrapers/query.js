// FIXTURE: stand-in `query.js sites` for test/hooks.test.js. Same table as the
// fixture dev.sh's `known`.
if (process.argv[2] === 'sites') {
  console.log(JSON.stringify([
    { hostname: 'example.test', status: 'working' },
    { hostname: 'broken.test', status: 'broken' },
    { hostname: 'attn.test', status: 'blocked-attn' },
  ]));
}
