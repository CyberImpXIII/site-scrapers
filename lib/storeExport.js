// The store's serialised form (PLAN-repo-setup.md §7.11): what `./store.sh
// export` writes into $DATA_REPO/site-scrapers/, what `import` recreates an
// absent store from, and what `verify` compares the store against.
//
// THE CONTRACT. data/scrapers.db stays the one source; the export is its
// plain-file form, written by this repo and read by setup once, when the store
// is absent. What is exported is an ALLOWLIST (TABLES below), never "everything
// but": a column added to the schema and not classified here fails
// test/store-export.test.js, so nothing reaches the data repo by default.
//
//   exported   recipes (`sites`: definition, params, probe values, status,
//              notes, first_seen/last_verified) with their fields; the action
//              taxonomy; every generic action, builtin and user.
//   excluded   recipe_versions and change_log (this instance's edit history:
//              an imported recipe starts at v1.0, "imported"); scrape_runs (run
//              state, and params_json can hold caller-supplied values);
//              page_observations (measurements of this instance, re-earned by
//              `primitives.js try`, stale after 90 days); ids and the taxonomy's
//              and actions' created/updated stamps (bookkeeping, reset by seeding).
//   never      data/failures.db, sessions, fills, data/.captures/ -- this module
//              reads the recipe DB's allowlisted columns and nothing else, so a
//              file under data/ cannot reach the export by construction.
//
// Consequence worth knowing: statuses are exported, run history is not. An
// imported `working` recipe has no passing run on this machine, so
// definitionHasPassingRun is false until verify.js runs it here, and
// register.js will refuse to re-assert `working` before that. Deliberate: the
// status says what was earned at the source, the evidence stays where it ran.
//
// CREDENTIALS. Rule: credential-shaped values are supplied at run time, never
// stored. The export refuses (writes nothing) when a step types a literal into
// a credential-looking selector, or a JSON key named like a credential holds a
// literal; it names the item and the place, never the value. Value SHAPES (API
// keys, tokens) are the data repo's own no-secrets gate, not a third copy here.
//
// Layout, one file per item so a data-repo diff names what changed:
//   manifest.json                                   format, and this contract as data
//   recipes/<host>/<page_type>.<recipe_name>.json   one recipe and its fields
//   generic-actions/<name>.json
//   action-types/<name>.json
// Each file is JSON.stringify(obj, null, 2) with keys in TABLES order, so the
// same store always renders the same bytes: verify is a byte comparison, and
// re-exporting an unchanged store writes nothing.

const fs = require('fs');
const path = require('path');

const FORMAT = 1;
const TOOL = 'site-scrapers';

// Every table the store holds, classified. `export` lists the columns written,
// in file order; `exclude` gives each other column with why. A table excluded
// whole has `table` instead. test/store-export.test.js holds this equal to the
// real schema, both ways.
const TABLES = {
  sites: {
    export: [
      'hostname', 'page_type', 'recipe_name', 'display_name', 'status', 'nav_method', 'nav_template',
      'nav_params_schema', 'param_probe_values', 'session_mode', 'pagination_method', 'pagination_config',
      'action_type', 'card_anchor_text', 'card_selector', 'card_min_text_len', 'content_selector',
      'content_stop_text', 'ready_timeout_ms', 'result_count_regex', 'notes', 'first_seen', 'last_verified',
    ],
    exclude: { id: 'row id, local to this store' },
  },
  site_fields: {
    export: [
      'field_name', 'extract_kind', 'segment_index', 'regex_pattern', 'attribute_name', 'value_pattern',
      'example_value', 'field_order',
    ],
    exclude: { id: 'row id, local to this store', site_id: 'the recipe the file holds them under' },
  },
  action_types: {
    export: ['name', 'description'],
    exclude: { id: 'row id, local to this store', created_at: 'bookkeeping; seeding stamps it' },
  },
  generic_actions: {
    export: ['name', 'description', 'action_type', 'nav_params_schema', 'source', 'steps'],
    exclude: {
      id: 'row id, local to this store',
      created_at: 'bookkeeping; seeding restamps builtins',
      updated_at: 'bookkeeping; seeding restamps builtins',
    },
  },
  recipe_versions: { table: 'edit history of this instance; an imported recipe starts at v1.0' },
  change_log: { table: 'edit history of this instance (lib/gate.js)' },
  scrape_runs: { table: 'run state; params_json can hold caller-supplied values' },
  page_observations: { table: 'measurements of this instance; re-earned by primitives.js try, stale after 90 days' },
};

function manifest() {
  const exported = {};
  const excluded = {};
  for (const [t, c] of Object.entries(TABLES)) {
    if (c.table) excluded[t] = c.table;
    else {
      exported[t] = c.export;
      for (const [col, why] of Object.entries(c.exclude)) excluded[`${t}.${col}`] = why;
    }
  }
  return {
    tool: TOOL,
    format: FORMAT,
    store: 'data/scrapers.db',
    layout: {
      recipes: 'recipes/<host>/<page_type>.<recipe_name>.json',
      generic_actions: 'generic-actions/<name>.json',
      action_types: 'action-types/<name>.json',
    },
    exported,
    excluded,
    never: ['data/failures.db', 'data/.sessions/', 'data/.fills/', 'data/.captures/'],
  };
}

// A path segment that is safe on any filesystem and reversible enough to read.
function seg(s) {
  return String(s).replace(/[^A-Za-z0-9._-]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}

function pick(row, cols) {
  const o = {};
  for (const c of cols) o[c] = row[c] === undefined ? null : row[c];
  return o;
}

function render(obj) {
  return JSON.stringify(obj, null, 2) + '\n';
}

// ---- credentials ----------------------------------------------------------

const CRED_KEY = /^(pass(word|wd|code)?|pwd|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|otp|cvv|cvc|card[_-]?number|ssn)$/i;
const CRED_SELECTOR = /pass(word|wd|code)|secret|token|api[_-]?key|\botp\b|one-time|cvv|cvc|card-?number|\bssn\b/i;

function literal(v) {
  return typeof v === 'string' && v.length > 0 && !v.includes('{{');
}

// Where a stored JSON value holds a credential literal, as "<where>" strings.
function credentialFindings(value, where) {
  const out = [];
  const walk = (v, at) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${at}[${i}]`));
    if (!v || typeof v !== 'object') return;
    if (v.action === 'type' && literal(v.text) && CRED_SELECTOR.test(String(v.selector || ''))) {
      out.push(`${at}: a literal typed into a credential field (${v.selector})`);
    }
    for (const [k, x] of Object.entries(v)) {
      if (CRED_KEY.test(k) && literal(x)) out.push(`${at}.${k}: a literal under a credential-named key`);
      walk(x, `${at}.${k}`);
    }
  };
  walk(value, where);
  return out;
}

function parsed(s) {
  if (typeof s !== 'string') return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// ---- the store, rendered ----------------------------------------------------

// { files: Map(relpath -> text), items: Map(item -> relpath), credentials: [] }
// Read-only: SELECTs over the allowlisted columns.
function renderStore(db) {
  const files = new Map();
  const items = new Map();
  const credentials = [];
  const put = (item, rel, obj) => {
    if (files.has(rel)) throw new Error(`two items render to one export path ${rel}: ${item} and another`);
    files.set(rel, render(obj));
    items.set(item, rel);
  };
  put('manifest', 'manifest.json', manifest());

  const sites = db.prepare('SELECT * FROM sites ORDER BY hostname, page_type, recipe_name').all();
  const fieldsOf = db.prepare('SELECT * FROM site_fields WHERE site_id = ? ORDER BY field_order, id');
  for (const s of sites) {
    const item = `recipe:${s.hostname}#${s.page_type}:${s.recipe_name}`;
    const rec = pick(s, TABLES.sites.export);
    rec.fields = fieldsOf.all(s.id).map(f => pick(f, TABLES.site_fields.export));
    for (const col of ['nav_template', 'pagination_config', 'param_probe_values']) {
      credentials.push(...credentialFindings(parsed(s[col]), `${item} ${col}`));
    }
    put(item, `recipes/${seg(s.hostname)}/${seg(s.page_type)}.${seg(s.recipe_name)}.json`, rec);
  }
  for (const g of db.prepare('SELECT * FROM generic_actions ORDER BY name').all()) {
    const item = `generic_action:${g.name}`;
    credentials.push(...credentialFindings(parsed(g.steps), `${item} steps`));
    put(item, `generic-actions/${seg(g.name)}.json`, pick(g, TABLES.generic_actions.export));
  }
  for (const a of db.prepare('SELECT * FROM action_types ORDER BY name').all()) {
    put(`action_type:${a.name}`, `action-types/${seg(a.name)}.json`, pick(a, TABLES.action_types.export));
  }
  return { files, items, credentials };
}

// ---- the export folder --------------------------------------------------------

function exportDir(dataRepo) {
  return path.join(dataRepo, TOOL);
}

// Every regular file under dir, relative, dotfiles skipped (a .DS_Store is not
// part of the export, and export never writes one).
function listFiles(dir) {
  const out = [];
  const walk = rel => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) out.push(r);
    }
  };
  walk('');
  return out.sort();
}

function readManifest(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
}

// Writes the rendered store into dir: changed files rewritten, unchanged left
// alone, files the store no longer has removed. Refuses a non-empty folder that
// is not an export of this tool (no manifest naming it), since it removes files.
function writeExport(db, dir) {
  const { files, credentials } = renderStore(db);
  if (credentials.length) {
    const e = new Error('refusing to export: credential-shaped literals are stored (values not shown)');
    e.findings = credentials;
    throw e;
  }
  const present = listFiles(dir);
  const m = readManifest(dir);
  if (present.length && !(m && m.tool === TOOL)) {
    throw new Error(`refusing to write into ${dir}: it holds files and no manifest.json naming ${TOOL}, so it is not this tool's export`);
  }
  let written = 0;
  let unchanged = 0;
  let removed = 0;
  for (const [rel, text] of files) {
    const p = path.join(dir, rel);
    let cur = null;
    try {
      cur = fs.readFileSync(p, 'utf8');
    } catch {
      /* absent */
    }
    if (cur === text) {
      unchanged++;
      continue;
    }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
    written++;
  }
  for (const rel of present) {
    if (files.has(rel)) continue;
    fs.unlinkSync(path.join(dir, rel));
    removed++;
  }
  pruneEmptyDirs(dir);
  return { dir, items: files.size, written, unchanged, removed };
}

function pruneEmptyDirs(dir) {
  const walk = p => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const q = path.join(p, e.name);
      walk(q);
      if (fs.readdirSync(q).length === 0) fs.rmdirSync(q);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
}

// ---- verify -------------------------------------------------------------------

// The first place two JSON values differ, as a path; never the values.
function firstDifference(a, b, at = '') {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    if (Array.isArray(a) && a.length !== b.length) return `${at || '$'} (length ${a.length} in the store, ${b.length} in the export)`;
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    for (const k of keys) {
      const sub = Array.isArray(a) ? `${at}[${k}]` : at ? `${at}.${k}` : k;
      if (!(k in a)) return `${sub} (only in the export)`;
      if (!(k in b)) return `${sub} (only in the store)`;
      const d = firstDifference(a[k], b[k], sub);
      if (d) return d;
    }
    return `${at || '$'} (key order or formatting)`;
  }
  return at || '$';
}

// { items: [{item, status, detail?}] } -- the shape tools/checks'
// stores-exported reads (schema/verify.schema.json). db null = no store.
function verify(db, dir) {
  const present = new Set(listFiles(dir));
  const items = [];
  if (!db) {
    for (const rel of present) items.push({ item: `file:${rel}`, status: 'missing', detail: 'in the export; the store does not exist (run `./store.sh import`)' });
    if (!items.length) items.push({ item: 'store', status: 'missing', detail: 'neither the store nor its export exists' });
    return { items };
  }
  const { files, items: byItem } = renderStore(db);
  for (const [item, rel] of byItem) {
    if (!present.has(rel)) {
      items.push({ item, status: 'missing', detail: `the store has it, the export does not (${rel})` });
      continue;
    }
    const have = fs.readFileSync(path.join(dir, rel), 'utf8');
    if (have === files.get(rel)) {
      items.push({ item, status: 'same' });
      continue;
    }
    let where;
    try {
      where = firstDifference(JSON.parse(files.get(rel)), JSON.parse(have));
    } catch {
      where = 'the export file does not parse';
    }
    items.push({ item, status: 'differs', detail: `${rel}: first difference at ${where}` });
  }
  for (const rel of present) {
    if (!files.has(rel)) items.push({ item: `file:${rel}`, status: 'missing', detail: 'the export has it, the store does not' });
  }
  return { items };
}

// ---- import -------------------------------------------------------------------

function readJson(dir, rel) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
  } catch (e) {
    throw new Error(`${rel}: does not parse (${e.message})`);
  }
}

function exactKeys(obj, want, rel) {
  const have = Object.keys(obj || {});
  const extra = have.filter(k => !want.includes(k));
  const lacking = want.filter(k => !have.includes(k));
  if (extra.length || lacking.length) {
    throw new Error(`${rel}: not an export of format ${FORMAT}` +
      (extra.length ? `; unknown key(s) ${extra.join(', ')}` : '') +
      (lacking.length ? `; lacks ${lacking.join(', ')}` : ''));
  }
}

// What the export holds, read and shape-checked in full before anything is
// written: a malformed file stops the import with the store untouched.
function readExport(dir) {
  const m = readManifest(dir);
  if (!m || m.tool !== TOOL) throw new Error(`${dir}: no manifest.json naming ${TOOL}: not an export of this tool`);
  if (m.format !== FORMAT) throw new Error(`${dir}: export format ${m.format}, this tool reads format ${FORMAT}`);
  const out = { recipes: [], genericActions: [], actionTypes: [] };
  for (const rel of listFiles(dir)) {
    if (rel === 'manifest.json') continue;
    const top = rel.split('/')[0];
    const doc = readJson(dir, rel);
    if (top === 'recipes') {
      exactKeys(doc, [...TABLES.sites.export, 'fields'], rel);
      if (!Array.isArray(doc.fields)) throw new Error(`${rel}: fields is not a list`);
      doc.fields.forEach((f, i) => exactKeys(f, TABLES.site_fields.export, `${rel} fields[${i}]`));
      out.recipes.push(doc);
    } else if (top === 'generic-actions') {
      exactKeys(doc, TABLES.generic_actions.export, rel);
      out.genericActions.push(doc);
    } else if (top === 'action-types') {
      exactKeys(doc, TABLES.action_types.export, rel);
      out.actionTypes.push(doc);
    } else {
      throw new Error(`${rel}: not a file this tool's export writes`);
    }
  }
  return out;
}

// What makes a store not empty for import's purposes: anything export would
// carry that opening a fresh store does not create by itself.
function contentOf(db, seedNames) {
  const n = sql => db.prepare(sql).get().n;
  const types = db.prepare('SELECT name FROM action_types').all().map(r => r.name).filter(x => !seedNames.includes(x));
  return {
    recipes: n('SELECT COUNT(*) AS n FROM sites'),
    userGenericActions: n("SELECT COUNT(*) AS n FROM generic_actions WHERE source != 'builtin'"),
    addedActionTypes: types.length,
  };
}

// Recreates the store's exported content in db, which must be empty. Builtin
// generic actions are not written: opening the store seeds them from
// lib/builtinActions.js, and verify says whether that matches the export.
// Caller supplies the authorization (store.js wraps this in authorize()).
function importInto(db, data, dbApi) {
  const { insertSiteRow, insertField, snapshotVersionIfChanged, insertActionType, getActionType, upsertGenericAction, getGenericAction } = dbApi;
  const counts = { recipes: 0, fields: 0, genericActions: 0, actionTypes: 0, builtinsLeftToSeeding: 0 };
  db.exec('BEGIN');
  try {
    for (const a of data.actionTypes) {
      if (getActionType(db, a.name)) continue;
      insertActionType(db, a.name, a.description);
      counts.actionTypes++;
    }
    for (const g of data.genericActions) {
      if (g.source === 'builtin') {
        counts.builtinsLeftToSeeding++;
        continue;
      }
      if (getGenericAction(db, g.name)) throw new Error(`generic action ${g.name} already exists in the target store`);
      upsertGenericAction(db, g);
      counts.genericActions++;
    }
    for (const r of data.recipes) {
      const { fields, ...row } = r;
      const siteId = insertSiteRow(db, row);
      for (const f of fields) {
        insertField(db, siteId, f, f.field_order);
        counts.fields++;
      }
      snapshotVersionIfChanged(db, siteId, { note: 'imported by store.sh import (history is not exported)' });
      counts.recipes++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return counts;
}

module.exports = {
  FORMAT,
  TOOL,
  TABLES,
  manifest,
  renderStore,
  credentialFindings,
  exportDir,
  listFiles,
  writeExport,
  verify,
  readExport,
  contentOf,
  importInto,
  firstDifference,
};
