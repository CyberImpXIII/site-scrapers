// The planted-value probe for scrape_runs: does a credential passed as a run
// param end up stored? (TODO.md at the workspace top, "a credential passed as
// a scrape param may be stored in scrape_runs", 2026-10-09.)
//
//   node devtools/probe-run-params.js <dir>
//
// Offline and off the live store:
//   1. snapshots the stores into <dir> (devtools/snapshot-stores.js) and points
//      SS_DB / SS_FAILURES_DB at the copies, for itself and its child;
//   2. registers a fixture recipe there (`probe-run-params.test`, a reserved
//      name lib/fixtureHosts.js knows) whose nav_template is a closed loopback
//      port, so the run fails at navigation without touching any site;
//   3. runs the REAL engine (engine.js) once with fake credential-shaped values
//      under several param names, params read from a file (not argv);
//   4. reads back the row logRun wrote and prints, per param NAME, whether the
//      planted value was stored verbatim, and whether the `error` column quotes
//      any planted value. Values are never printed.
//
// The fakes are assembled from parts at run time, so this file never holds a
// credential shape (the no-secrets hook would rightly refuse it).

'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const HOST = 'probe-run-params.test';

function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.log(JSON.stringify({ error: 'Usage: node devtools/probe-run-params.js <dir>' }));
    process.exit(1);
  }
  const absDir = path.resolve(dir);
  const snap = spawnSync(process.execPath, [path.join(REPO, 'devtools', 'snapshot-stores.js'), absDir], { encoding: 'utf8' });
  if (snap.status !== 0) throw new Error(`snapshot failed: ${snap.stderr}`);
  const env = JSON.parse(snap.stdout.trim().split('\n').pop());
  if (!env.SS_DB) throw new Error('snapshot printed no SS_DB');
  Object.assign(process.env, env);

  // Required only now, so db.js reads the SS_DB just set.
  const { openDb, upsertSite, getSite, LIVE_DB_PATH, DB_PATH } = require('../db');
  if (path.resolve(DB_PATH) === path.resolve(LIVE_DB_PATH)) throw new Error('refusing: DB_PATH is the live store');
  const { authorizeForTests } = require('../lib/writeGuard');
  authorizeForTests('probe-run-params fixture recipe, on a snapshot copy');

  const db = openDb();
  upsertSite(db, {
    hostname: HOST,
    page_type: 'listing',
    recipe_name: 'default',
    status: 'needs-review',
    nav_method: 'url_param',
    nav_template: 'http://127.0.0.1:9/{{q}}/{{x}}',
    card_selector: 'div.card',
    notes: 'Fixture for devtools/probe-run-params.js, on a snapshot copy only.',
  });
  const site = getSite(db, HOST, 'listing', 'default');

  const alnum = n => Array.from({ length: n }, (_, i) => 'aB3dE5gH7k'[i % 10]).join('');
  const planted = {
    password: ['Fx', 'pw-7731!'].join(''), // a plain password: no shape to detect
    token: ['gh', 'p_', alnum(36)].join(''), // GitHub token shape
    api_key: ['sk', '-ant-', alnum(24)].join(''), // Anthropic key shape
    x: ['xo', 'xb-', alnum(16)].join(''), // Slack token shape, NEUTRAL name, and in the URL
    note: ['see ', 'AK', 'IA', 'ABCDEFGHIJKLMNOP', ' here'].join(''), // AWS key id inside prose
    user_password: ['Fx', 'pw-8842!'].join(''), // suffix key name, plain value
    authToken: ['Fx', 'tok-9953'].join(''), // camelCase key name, plain value
  };
  const ordinary = { q: 'archivist' }; // the counterfactual: must be stored as given
  const paramsFile = path.join(absDir, 'probe-params.json');
  fs.writeFileSync(paramsFile, JSON.stringify({ ...ordinary, ...planted, allowUnverified: true, noDiagnostics: true }), { mode: 0o600 });

  const run = spawnSync(process.execPath, [path.join(REPO, 'engine.js'), HOST, `@${paramsFile}`], {
    encoding: 'utf8',
    env: process.env,
    timeout: 120000,
  });
  fs.rmSync(paramsFile, { force: true });
  let engine = null;
  try {
    engine = JSON.parse(run.stdout);
  } catch {
    /* reported below as unparsed */
  }

  const row = db.prepare('SELECT params_json, error FROM scrape_runs WHERE site_id = ? ORDER BY id DESC LIMIT 1').get(site.id);
  if (!row) {
    console.log(JSON.stringify({ error: 'no scrape_runs row was written', engineExit: run.status }));
    process.exit(1);
  }
  const stored = JSON.parse(row.params_json);
  const verdict = {};
  for (const [k, v] of Object.entries(planted)) {
    const s = stored[k];
    verdict[k] = s === v ? 'STORED VERBATIM' : row.params_json.includes(v) ? 'STORED (inside another value)' : s && typeof s === 'object' && s.redacted ? 'redacted' : 'absent';
  }
  const errorQuotes = Object.keys(planted).filter(k => typeof row.error === 'string' && row.error.includes(planted[k]));
  console.log(JSON.stringify({
    store: env.SS_DB,
    engine: { exit: run.status, success: engine ? engine.success : 'unparsed', erroredAtNavigation: !!(engine && engine.error) },
    ordinaryParamKeptAsGiven: stored.q === ordinary.q,
    planted: verdict,
    errorColumnQuotesPlantedValueOf: errorQuotes,
  }, null, 2));
  db.close();
}

main();
