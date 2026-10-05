// The store's export / import / verify (PLAN-repo-setup.md §7.11): store.sh,
// store.js, lib/storeExport.js, cli.json.
//
// Every database here is a PRIVATE temp file passed with --db (or opened with
// openDb(path)); nothing in this file opens data/scrapers.db. Every export goes
// to a temp DATA_REPO.
//
// What it holds:
//   - the allowlist (TABLES) equals the real schema, both ways: a new column is
//     classified before it can be exported or silently left out;
//   - the round trip: export, import into an empty store, verify = all same;
//   - the counterfactual: alter one recipe and verify says `differs` for that
//     recipe only, naming the column; a removed or stray file says `missing`;
//   - verify's output fits tools/checks' schema/verify.schema.json (read from
//     there when the workspace has it);
//   - the refusals: a non-empty store, a malformed export, a folder that is not
//     an export, a credential literal (named, value never printed);
//   - cli.json's verbs equal what `store.sh help` lists, both ways.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const dbApi = require('../db');
const { openDb, upsertSite, insertField, upsertGenericAction, insertActionType, getSite } = dbApi;
const { authorizeForTests } = require('../lib/writeGuard');
const gate = require('../lib/gate');
const store = require('../lib/storeExport');

authorizeForTests('store-export fixtures, private temp DBs only');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-store-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = label => path.join(tmp, `${label}-${++n}`);

function cli(args, env = {}) {
  const r = spawnSync(path.join(REPO, 'store.sh'), args, {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* help text, or a fault the assertion will show */
  }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

// A source store with one of everything export carries.
function sourceStore() {
  const file = fresh('src') + '.db';
  const db = openDb(file);
  const id = upsertSite(db, {
    hostname: 'store-fixture.test',
    page_type: 'listing',
    recipe_name: 'default',
    status: 'working',
    nav_method: 'url_param',
    nav_template: 'https://store-fixture.test/jobs?q={{q}}',
    nav_params_schema: { q: 'search text' },
    param_probe_values: [{ q: 'sales' }, { q: 'engineer' }],
    card_anchor_text: 'Apply',
    notes: 'store-export fixture',
  });
  insertField(db, id, { field_name: 'title', extract_kind: 'positional_segment', segment_index: 0 }, 0);
  insertField(db, id, { field_name: 'href', extract_kind: 'anchor_attribute', attribute_name: 'href' }, 1);
  dbApi.snapshotVersionIfChanged(db, id);
  upsertSite(db, {
    hostname: 'store-fixture.test',
    page_type: 'action',
    recipe_name: 'login',
    action_type: 'login',
    status: 'needs-review',
    nav_method: 'ui_steps',
    nav_template: JSON.stringify([
      { action: 'goto', url: 'https://store-fixture.test/login' },
      { action: 'type', selector: '#password', text: '{{password}}' },
    ]),
  });
  insertActionType(db, 'store_fixture_kind', 'an action type only the fixture has');
  upsertGenericAction(db, {
    name: 'store_fixture_action',
    description: 'a user generic action',
    steps: JSON.stringify([{ action: 'wait', ms: 1 }]),
  });
  db.close();
  return file;
}

function dataRepo() {
  const d = fresh('data');
  fs.mkdirSync(d);
  return d;
}

test('the allowlist classifies every table and column of the real schema, both ways', () => {
  const db = openDb(fresh('schema') + '.db');
  gate.ensureChangeLog(db);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);
  assert.deepEqual([...tables].sort(), Object.keys(store.TABLES).sort(), 'every table in TABLES, and nothing else');
  for (const [t, c] of Object.entries(store.TABLES)) {
    if (c.table) continue;
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(r => r.name).sort();
    assert.deepEqual([...c.export, ...Object.keys(c.exclude)].sort(), cols, `${t}: exported + excluded == its columns`);
    assert.equal(new Set(c.export).size, c.export.length, `${t}: no column exported twice`);
  }
  db.close();
});

test('round trip: export, import into an empty store, verify says every item same', () => {
  const src = sourceStore();
  const data = dataRepo();
  const ex = cli(['export', '--db', src], { DATA_REPO: data });
  assert.equal(ex.code, 0, ex.stdout + ex.stderr);
  assert.ok(ex.json.written > 0 && ex.json.removed === 0, ex.stdout);

  const files = store.listFiles(store.exportDir(data));
  assert.ok(files.includes('manifest.json'));
  assert.ok(files.includes('recipes/store-fixture.test/listing.default.json'));
  assert.ok(files.includes('recipes/store-fixture.test/action.login.json'));
  assert.ok(files.includes('generic-actions/store_fixture_action.json'));
  assert.ok(files.includes('action-types/store_fixture_kind.json'));
  assert.deepEqual(
    [...new Set(files.map(f => f.split('/')[0]))].sort(),
    ['action-types', 'generic-actions', 'manifest.json', 'recipes'],
    'the export writes only the four places its layout names'
  );

  const target = fresh('dst') + '.db';
  assert.equal(fs.existsSync(target), false);
  const im = cli(['import', '--db', target], { DATA_REPO: data });
  assert.equal(im.code, 0, im.stdout + im.stderr);
  assert.equal(im.json.imported.recipes, 2);
  assert.equal(im.json.imported.genericActions, 1);
  assert.equal(im.json.imported.actionTypes, 1);
  assert.deepEqual(im.json.notSame, []);

  const v = cli(['verify', '--json', '--db', target], { DATA_REPO: data });
  assert.equal(v.code, 0, v.stdout);
  assert.ok(v.json.items.length >= 5);
  assert.deepEqual(v.json.items.filter(i => i.status !== 'same'), [], 'every item same');

  // Same as the source, column for column, timestamps and status included.
  const a = openDb(src);
  const b = openDb(target);
  const s1 = getSite(a, 'store-fixture.test', 'listing', 'default');
  const s2 = getSite(b, 'store-fixture.test', 'listing', 'default');
  for (const c of store.TABLES.sites.export) assert.deepEqual(s2[c], s1[c], `sites.${c}`);
  assert.equal(s2.status, 'working');
  assert.equal(dbApi.getCurrentVersion(b, s2.id).major, 1, 'an imported recipe starts at v1.0');
  a.close();
  b.close();

  // Re-exporting an unchanged store writes nothing.
  const again = cli(['export', '--db', src], { DATA_REPO: data });
  assert.equal(again.json.written, 0, again.stdout);
  assert.equal(again.json.removed, 0);
});

test('counterfactual: one altered recipe is `differs`, naming the column; the rest stay same', () => {
  const src = sourceStore();
  const data = dataRepo();
  assert.equal(cli(['export', '--db', src], { DATA_REPO: data }).code, 0);
  const target = fresh('dst') + '.db';
  assert.equal(cli(['import', '--db', target], { DATA_REPO: data }).code, 0);

  const db = openDb(target);
  const site = getSite(db, 'store-fixture.test', 'listing', 'default');
  upsertSite(db, { ...site, card_anchor_text: 'Apply now' });
  for (const f of [{ field_name: 'title', extract_kind: 'positional_segment', segment_index: 0 }, { field_name: 'href', extract_kind: 'anchor_attribute', attribute_name: 'href' }]) {
    insertField(db, site.id, f, f.field_name === 'title' ? 0 : 1);
  }
  db.close();

  const v = cli(['verify', '--db', target], { DATA_REPO: data });
  assert.equal(v.code, 1, 'a verify with a difference exits non-zero');
  const bad = v.json.items.filter(i => i.status !== 'same');
  assert.equal(bad.length, 1, JSON.stringify(bad));
  assert.equal(bad[0].item, 'recipe:store-fixture.test#listing:default');
  assert.equal(bad[0].status, 'differs');
  assert.match(bad[0].detail, /card_anchor_text/);
  assert.doesNotMatch(bad[0].detail, /Apply/, 'the detail names where, not the values');

  // The export lacking an item, and holding one the store lacks: both `missing`.
  fs.unlinkSync(path.join(store.exportDir(data), 'action-types/store_fixture_kind.json'));
  fs.writeFileSync(path.join(store.exportDir(data), 'recipes/store-fixture.test/listing.gone.json'), '{}\n');
  const w = cli(['verify', '--db', target], { DATA_REPO: data });
  const by = Object.fromEntries(w.json.items.map(i => [i.item, i]));
  assert.equal(by['action_type:store_fixture_kind'].status, 'missing');
  assert.match(by['action_type:store_fixture_kind'].detail, /store has it, the export does not/);
  assert.equal(by['file:recipes/store-fixture.test/listing.gone.json'].status, 'missing');

  // Export brings the folder back to the store: verify is all same again.
  const ex = cli(['export', '--db', target], { DATA_REPO: data });
  assert.equal(ex.json.removed, 1);
  assert.equal(cli(['verify', '--db', target], { DATA_REPO: data }).code, 0);
});

test("verify's report fits tools/checks' verify schema (read from there)", t => {
  const schemaFile = path.join(REPO, '..', 'tools', 'checks', 'schema', 'verify.schema.json');
  if (!fs.existsSync(schemaFile)) {
    t.skip(`UNCHECKED: ${schemaFile} absent (standalone clone)`);
    return;
  }
  const schema = JSON.parse(fs.readFileSync(schemaFile, 'utf8'));
  const itemSchema = schema.properties.items.items;
  const src = sourceStore();
  const data = dataRepo();
  cli(['export', '--db', src], { DATA_REPO: data });
  fs.unlinkSync(path.join(store.exportDir(data), 'generic-actions/store_fixture_action.json'));
  const reports = [cli(['verify', '--json', '--db', src], { DATA_REPO: data }).json,
    cli(['verify', '--json', '--db', fresh('none') + '.db'], { DATA_REPO: data }).json];
  for (const r of reports) {
    for (const k of Object.keys(r)) assert.ok(k in schema.properties, `top key ${k} not in the schema`);
    for (const k of schema.required) assert.ok(k in r, `required ${k}`);
    assert.ok(r.items.length >= schema.properties.items.minItems);
    const names = r.items.map(i => i.item);
    assert.equal(new Set(names).size, names.length, 'x-rules unique');
    for (const i of r.items) {
      for (const k of Object.keys(i)) assert.ok(k in itemSchema.properties, `item key ${k} not in the schema`);
      for (const k of itemSchema.required) assert.ok(k in i, `item lacks ${k}`);
      assert.ok(itemSchema.properties.status.enum.includes(i.status), i.status);
      assert.ok(typeof i.item === 'string' && i.item.length > 0);
    }
  }
});

test('verify with no store reports the export missing and does not create the store', () => {
  const src = sourceStore();
  const data = dataRepo();
  cli(['export', '--db', src], { DATA_REPO: data });
  const absent = fresh('absent') + '.db';
  const v = cli(['verify', '--db', absent], { DATA_REPO: data });
  assert.equal(v.code, 1);
  assert.ok(v.json.items.every(i => i.status === 'missing'));
  assert.equal(fs.existsSync(absent), false, 'verify must not create a store');
  const e = cli(['export', '--db', absent], { DATA_REPO: data });
  assert.equal(e.code, 2);
  assert.equal(fs.existsSync(absent), false, 'export must not create a store');
});

test('import refuses a non-empty store and a malformed export, writing nothing', () => {
  const src = sourceStore();
  const data = dataRepo();
  cli(['export', '--db', src], { DATA_REPO: data });

  const r = cli(['import', '--db', src], { DATA_REPO: data });
  assert.equal(r.code, 2);
  assert.match(r.json.error, /not empty/);

  const f = path.join(store.exportDir(data), 'recipes/store-fixture.test/listing.default.json');
  const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
  doc.surprise = 1;
  fs.writeFileSync(f, JSON.stringify(doc));
  const target = fresh('dst') + '.db';
  const m = cli(['import', '--db', target], { DATA_REPO: data });
  assert.equal(m.code, 2);
  assert.match(m.json.error, /unknown key\(s\) surprise/);
  if (fs.existsSync(target)) {
    const db = openDb(target);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sites').get().n, 0, 'a refused import leaves no recipe');
    db.close();
  }
});

test('DATA_REPO unset or not a folder is refused, never an empty pass', () => {
  const src = sourceStore();
  for (const env of [{ DATA_REPO: '' }, { DATA_REPO: path.join(tmp, 'nowhere') }]) {
    for (const verb of ['export', 'import', 'verify']) {
      const r = cli([verb, '--db', src], env);
      assert.equal(r.code, 2, `${verb} ${JSON.stringify(env)}`);
      assert.match(r.json.error, /DATA_REPO/);
    }
  }
});

test('export refuses a folder that is not its own export', () => {
  const src = sourceStore();
  const data = dataRepo();
  fs.mkdirSync(path.join(data, 'site-scrapers'));
  fs.writeFileSync(path.join(data, 'site-scrapers', 'notes.txt'), 'someone else\n');
  const r = cli(['export', '--db', src], { DATA_REPO: data });
  assert.equal(r.code, 2);
  assert.match(r.json.error, /not this tool's export/);
  assert.equal(fs.readFileSync(path.join(data, 'site-scrapers', 'notes.txt'), 'utf8'), 'someone else\n');
});

test('a credential literal stops the export, named by item and place, value never printed', () => {
  const src = sourceStore();
  const db = openDb(src);
  const SECRET = 'hunter2-not-real';
  upsertSite(db, {
    hostname: 'store-fixture.test',
    page_type: 'action',
    recipe_name: 'login',
    action_type: 'login',
    nav_method: 'ui_steps',
    nav_template: JSON.stringify([{ action: 'type', selector: 'input[type=password]', text: SECRET }]),
  });
  db.close();
  const data = dataRepo();
  const r = cli(['export', '--db', src], { DATA_REPO: data });
  assert.equal(r.code, 2);
  assert.ok(r.json.findings.some(f => f.startsWith('recipe:store-fixture.test#action:login nav_template[0]')), r.stdout);
  assert.ok(!r.stdout.includes(SECRET) && !r.stderr.includes(SECRET), 'the value is never shown');
  assert.deepEqual(store.listFiles(store.exportDir(data)), [], 'nothing written');

  // Counterfactual: the same step with a run-time placeholder exports.
  assert.deepEqual(store.credentialFindings([{ action: 'type', selector: '#password', text: '{{password}}' }], 'x'), []);
  assert.equal(store.credentialFindings([{ q: 'a', api_key: 'abc' }], 'x').length, 1);
  assert.equal(store.credentialFindings([{ q: 'a', api_key: '{{key}}' }], 'x').length, 0);
});

test("cli.json's verbs are exactly what `store.sh help` lists, and the CLI is executable", () => {
  const decl = JSON.parse(fs.readFileSync(path.join(REPO, 'cli.json'), 'utf8'));
  assert.deepEqual(Object.keys(decl).sort(), ['cli', 'store', 'verbs']);
  assert.equal(decl.store, 'data/scrapers.db');
  assert.equal(path.join(REPO, decl.store), dbApi.DB_PATH, 'cli.json names the store db.js opens');
  fs.accessSync(path.join(REPO, decl.cli), fs.constants.X_OK);
  const help = cli(['help']);
  assert.equal(help.code, 0);
  // The rule tools/checks' helptext.py applies: lines at the first indented
  // lowercase word's indent.
  const lines = help.stdout.split('\n');
  const first = lines.find(l => /^\s+[a-z]/.test(l));
  const indent = first.match(/^\s+/)[0];
  const listed = lines.filter(l => l.startsWith(indent) && /^[a-z]/.test(l.slice(indent.length))).map(l => l.trim().split(/\s+/)[0]);
  assert.deepEqual(listed.filter(v => v !== 'help').sort(), [...decl.verbs].sort(), 'declared == implemented, both ways');
  for (const v of decl.verbs) {
    const r = cli([v], { DATA_REPO: '' });
    assert.equal(r.code, 2, `${v} is a verb store.js handles (refused only for DATA_REPO)`);
    assert.match(r.json.error, /DATA_REPO/);
  }
});
