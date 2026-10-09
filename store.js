// The store's export, import and verify verbs (PLAN-repo-setup.md §7.11),
// declared in cli.json. Run it through ./store.sh, which supplies Node 22.
// The contract (what is exported, what never is) is lib/storeExport.js's
// header and, as data, the export's own manifest.json.
//
// Output is JSON on stdout (this repo's jq contract). `verify` prints exactly
// the document tools/checks' stores-exported reads: {"items": [...]}.
// Exit: 0 done / every item same; 1 verify or import found an item not same;
// 2 refused or could not run (the JSON says why).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const dbApi = require('./db');
const failuresDb = require('./failuresDb');
const { authorize } = require('./lib/writeGuard');
const store = require('./lib/storeExport');

// The verbs that WRITE the two stores (cli.json names both) are the CLIs that
// already do it, forwarded unchanged: arguments, stdout, stderr and the exit
// code pass straight through, so `store.sh set <target> <json>` is exactly
// `node lab.js set <target> <json>`. One CLI per repo (tools/checks' accessor)
// without a second copy of any writer. test/store-export.test.js.
const FORWARD = {
  register: ['register.js'],
  set: ['lab.js', 'set'],
  'verify-recipe': ['verify.js'],
  scrape: ['engine.js'],
  failures: ['failures.js'],
};

const HELP = `store.sh <verb> [--db PATH] [--json]

  export          write the recipe store's exported form into $DATA_REPO/site-scrapers/ (changed files only; removes what the store no longer has)
  import          recreate an absent or empty recipe store from $DATA_REPO/site-scrapers/, then verify it; creates an empty failures store beside it if absent
  verify          compare the recipe store with its export: each item same, differs or missing (exit 1 unless all same)
  register        create a recipe: node register.js '<json>' (the recipe store's writer)
  set             edit a recipe: node lab.js set <target> '<json>'
  verify-recipe   earn a status by a run: node verify.js <target> '<params>'
  scrape          run a recipe; the run is recorded in scrape_runs: node engine.js <target> '<params>'
  failures        the failures store's CLI: node failures.js record | forget | add-signature | ... (failures.js help)
  help            this text

  --db PATH   the recipe store file for export/import/verify (default data/scrapers.db); tests and copies use this
  --json      accepted for the checks contract; output is always JSON
  DATA_REPO   the private data repo, from the caller's environment (setup reads .claude/local.env)
  The writer verbs take exactly their CLI's own arguments; output and exit code are that CLI's.
`;

function forward(verb, rest) {
  const [script, ...pre] = FORWARD[verb];
  const r = spawnSync(process.execPath, [path.join(__dirname, script), ...pre, ...rest], { stdio: 'inherit', cwd: __dirname });
  if (r.error) {
    process.stderr.write(`store.sh ${verb}: could not run ${script}: ${r.error.message}\n`);
    return 2;
  }
  return r.status ?? 1;
}

function out(doc, code) {
  process.stdout.write(JSON.stringify(doc, null, 2) + '\n');
  process.exitCode = code;
}

function parseArgs(argv) {
  const a = { verb: argv[0], db: dbApi.DB_PATH, bad: [] };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--db') a.db = path.resolve(argv[++i] || '');
    else if (argv[i] === '--json') continue;
    else a.bad.push(argv[i]);
  }
  return a;
}

function dataDir() {
  const repo = process.env.DATA_REPO;
  if (!repo) return { error: 'DATA_REPO is not set: no data repo to export to or import from (the caller supplies it)' };
  if (!fs.existsSync(repo) || !fs.statSync(repo).isDirectory()) return { error: `DATA_REPO is set but is not a folder: ${repo}` };
  return { dir: store.exportDir(repo) };
}

function summary(items) {
  const n = s => items.filter(i => i.status === s).length;
  return { same: n('same'), differs: n('differs'), missing: n('missing'), unavailable: n('unavailable') };
}

function main() {
  const argv = process.argv.slice(2);
  if (Object.hasOwn(FORWARD, argv[0])) {
    process.exitCode = forward(argv[0], argv.slice(1));
    return;
  }
  const a = parseArgs(argv);
  if (!a.verb || a.verb === 'help' || a.verb === '--help' || a.verb === '-h') {
    process.stdout.write(HELP);
    return;
  }
  if (!['export', 'import', 'verify'].includes(a.verb)) {
    process.stdout.write(HELP);
    process.exitCode = 2;
    return;
  }
  if (a.bad.length) return out({ error: `unknown argument(s): ${a.bad.join(' ')}` }, 2);
  const d = dataDir();
  if (d.error) return out({ error: d.error }, 2);
  const exists = fs.existsSync(a.db);

  if (a.verb === 'verify') {
    const report = store.verify(exists ? dbApi.openDb(a.db) : null, d.dir);
    out(report, report.items.every(i => i.status === 'same') ? 0 : 1);
    return;
  }

  if (a.verb === 'export') {
    if (!exists) return out({ error: `the store does not exist (${a.db}): nothing to export` }, 2);
    try {
      return out(store.writeExport(dbApi.openDb(a.db), d.dir), 0);
    } catch (e) {
      return out({ error: e.message, ...(e.findings ? { findings: e.findings } : {}) }, 2);
    }
  }

  // import
  let data;
  try {
    data = store.readExport(d.dir);
  } catch (e) {
    return out({ error: e.message }, 2);
  }
  const db = dbApi.openDb(a.db);
  const content = store.contentOf(db, dbApi.ACTION_TYPES_SEED.map(([n]) => n));
  if (content.recipes || content.userGenericActions || content.addedActionTypes) {
    return out({ error: `the store is not empty (${a.db}): import never writes into an existing store`, content }, 2);
  }
  let imported;
  try {
    imported = authorize(`store.js import from ${d.dir}`, () => store.importInto(db, data, dbApi));
  } catch (e) {
    return out({ error: `import failed, nothing written: ${e.message}` }, 2);
  }
  const report = store.verify(db, d.dir);
  const notSame = report.items.filter(i => i.status !== 'same');
  // The second store cli.json names. It holds history (never exported), so an
  // import cannot fill it, but setup requires every named store on disk after
  // an import: an absent one is created empty (seeded vocabulary only), an
  // existing one is never opened. Beside --db when given, else the default.
  const failuresFile = a.db === dbApi.DB_PATH ? failuresDb.FAILURES_DB_PATH : path.join(path.dirname(a.db), 'failures.db');
  let failuresStore = 'present';
  if (!fs.existsSync(failuresFile)) {
    failuresDb.openFailuresDb(failuresFile).close();
    failuresStore = 'created';
  }
  out({ imported, failuresStore, verify: summary(report.items), notSame }, notSame.length ? 1 : 0);
}

main();
