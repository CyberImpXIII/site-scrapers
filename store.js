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
const dbApi = require('./db');
const { authorize } = require('./lib/writeGuard');
const store = require('./lib/storeExport');

const HELP = `store.sh <verb> [--db PATH] [--json]

  export   write the store's exported form into $DATA_REPO/site-scrapers/ (changed files only; removes what the store no longer has)
  import   recreate an absent or empty store from $DATA_REPO/site-scrapers/, then verify it
  verify   compare the store with its export: each item same, differs or missing (exit 1 unless all same)
  help     this text

  --db PATH   the store file (default data/scrapers.db); tests and copies use this
  --json      accepted for the checks contract; output is always JSON
  DATA_REPO   the private data repo, from the caller's environment (setup reads .claude/local.env)
`;

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
  const a = parseArgs(process.argv.slice(2));
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
  out({ imported, verify: summary(report.items), notSame }, notSame.length ? 1 : 0);
}

main();
