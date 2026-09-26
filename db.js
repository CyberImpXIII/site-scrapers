const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const { BUILTIN_ACTIONS } = require('./lib/builtinActions');

const DB_PATH = path.join(__dirname, 'data', 'scrapers.db');

const SITES_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hostname TEXT NOT NULL,
  page_type TEXT NOT NULL DEFAULT 'listing',         -- 'listing' (repeated cards) | 'article' (single content block) | 'action' (a repeatable automation -- login, add-to-cart, etc; shares 'article's execution path -- ui_steps then optional field capture -- but isn't primarily about reading content)
  recipe_name TEXT NOT NULL DEFAULT 'default',       -- disambiguates multiple recipes for the same (hostname, page_type), e.g. two 'action' recipes: 'login' and 'add_to_cart'. Leave 'default' for the single/primary recipe of a given page_type.
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'needs-review',       -- 'working' | 'broken' | 'needs-review'
  nav_method TEXT NOT NULL,                          -- 'url_param' | 'ui_steps' | 'direct_url' (article: goto params.url as-is)
  nav_template TEXT NOT NULL,                        -- URL template (url_param/direct_url) OR JSON step array (ui_steps)
  nav_params_schema TEXT,                            -- JSON: documents accepted params, for callers
  session_mode TEXT,                                 -- NULL/'default': use the caller's named session (persistence is on by default). 'none': this recipe MUST run logged out -- the engine skips loading AND saving a session for it. For pages whose logged-in DOM differs from the logged-out one (e.g. linkedin.com's guest job search finds 0 cards with a logged-in session), where relying on the caller to remember params.noSession means silent 0-result runs.
  pagination_method TEXT NOT NULL DEFAULT 'none',    -- 'none' | 'steps' (run pagination_config ui_steps after page 1, e.g. the generic 'paginate' action) | 'url_param' / 'click_next' (not implemented)
  pagination_config TEXT,                            -- pagination_method 'steps': JSON ui_steps array
  action_type TEXT,                                  -- action recipes only: which entry of action_types this is (e.g. 'login', 'add_to_cart') -- register.js validates this against action_types, preferring reuse over inventing near-duplicate names. NULL for listing/article.
  card_anchor_text TEXT,                             -- listing only: exact text of a reliably-present per-card element
  card_selector TEXT,                                -- listing only, alternative to card_anchor_text: CSS selector matching each card container directly, for sites with no shared per-card literal text
  card_min_text_len INTEGER NOT NULL DEFAULT 80,      -- min text length before considering the target ready (card container for listing, content_selector element for article)
  content_selector TEXT,                              -- article only: CSS selector for the main content container (defaults to body)
  content_stop_text TEXT,                              -- article only: truncate extracted text at the first occurrence of this literal string (cuts off "related content" widgets etc.)
  ready_timeout_ms INTEGER NOT NULL DEFAULT 20000,
  result_count_regex TEXT,                            -- listing only: regex (1 capture group) against page body text, for a self-consistency check
  notes TEXT,
  first_seen TEXT NOT NULL,
  last_verified TEXT NOT NULL,
  UNIQUE(hostname, page_type, recipe_name)
);
`;

// Point-in-time snapshots of a recipe's definition, so "it used to work"
// is answerable instead of lost. upsertSite overwrites in place, so without
// this the definition that was working before a site changed is simply gone,
// and a scrape_runs failure row is unanchored — you know run 47 failed, not
// what the recipe looked like when it did.
//
// Numbering follows how troubleshooting actually goes: each re-register is
// a MINOR bump (v2.0 -> v2.1 -> v2.2), the disposable scaffolding of working
// a problem. Promoting marks the current version `stable` and starts the
// next MAJOR, so majors are the generations that were once known-good.
// Pruning keeps every stable version forever and only the most recent few
// non-stable ones, which is what stops iteration from becoming bloat.
const RECIPE_VERSIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS recipe_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- CASCADE matters: node:sqlite enforces foreign keys by default, so without
  -- it these rows make a recipe permanently undeletable. A recipe's version
  -- history has no meaning once the recipe is gone.
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  major INTEGER NOT NULL,
  minor INTEGER NOT NULL,
  definition TEXT NOT NULL,      -- JSON snapshot of the recipe: the sites row (minus ids/timestamps) plus its site_fields
  stable INTEGER NOT NULL DEFAULT 0,  -- 1 = promoted known-good; never auto-pruned
  note TEXT,                     -- why this version exists / what changed
  created_at TEXT NOT NULL,
  UNIQUE(site_id, major, minor)
);
`;

const ACTION_TYPES_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS action_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TEXT NOT NULL
);
`;

// Small, deliberately short starter taxonomy for action recipes' action_type
// column. Grown only when register.js is told (via new_action_type_description)
// that an existing entry genuinely doesn't fit — the point is to make
// inventing a near-duplicate ('add-to-basket' next to 'add_to_cart') a
// conscious choice, not an accident of free-typing a recipe_name.
const ACTION_TYPES_SEED = [
  ['login', 'Authenticate into an account, ending in an authenticated session.'],
  ['logout', 'End an authenticated session.'],
  ['add_to_cart', 'Add one item to a cart/basket, without completing a purchase.'],
  ['checkout_to_review', 'Progress a cart through checkout up to a final review/confirm step, stopping short of submitting payment.'],
  ['submit_form', 'Fill and submit a generic form -- contact, signup, application, etc.'],
  ['search', 'Perform a search/filter action that requires UI interaction (not just a URL param -- that belongs in a listing recipe instead).'],
];

function seedActionTypes(db) {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM action_types').get();
  if (count > 0) return;
  const now = new Date().toISOString();
  const insert = db.prepare('INSERT INTO action_types (name, description, created_at) VALUES (?,?,?)');
  for (const [name, description] of ACTION_TYPES_SEED) insert.run(name, description, now);
}

// A puppeteer-level "library" of reusable, hostname-independent ui_steps
// sequences — recurring macros (a generic login heuristic, dismissing a
// cookie banner, an infinite-scroll "load more" loop) that any site's
// action recipe can pull in with a `run_generic_action` step, instead of
// each recipe re-deriving the same steps. Unlike `sites`, these aren't
// keyed to a hostname — `name` is the whole identity.
const GENERIC_ACTIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS generic_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  action_type TEXT,             -- optional categorization against action_types, for discovery -- not required, since some macros (e.g. "dismiss_cookie_banner") aren't really an action_type in the login/add_to_cart sense
  nav_params_schema TEXT,       -- JSON: documents accepted {{params}}, same convention as sites.nav_params_schema
  source TEXT NOT NULL DEFAULT 'user',  -- 'builtin': owned by lib/builtinActions.js and re-upserted from there on every open, so edits to the row do not survive. 'user': registered by hand, never touched by seeding.
  steps TEXT NOT NULL,          -- JSON array of ui_steps (same vocabulary as a site recipe's nav_template: goto/click/type/waitForSelector/wait/handoff/run_action/run_generic_action)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const SCHEMA = `
${SITES_TABLE_SQL}
${ACTION_TYPES_TABLE_SQL}
${GENERIC_ACTIONS_TABLE_SQL}
${RECIPE_VERSIONS_TABLE_SQL}
CREATE TABLE IF NOT EXISTS site_fields (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL REFERENCES sites(id),
  field_name TEXT NOT NULL,
  extract_kind TEXT NOT NULL,        -- 'positional_segment' | 'regex_anywhere' | 'anchor_attribute' | 'ancestor_first_line' (listing) | 'title_regex' | 'full_blob'
  segment_index INTEGER,             -- for positional_segment: index into blob.split(' | ')
  regex_pattern TEXT,                -- for regex_anywhere: JS regex source; capture group 1 used if present, else whole match
  attribute_name TEXT,               -- for anchor_attribute: e.g. 'href'
  example_value TEXT,                -- last known-good value, human sanity-check reference
  field_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE(site_id, field_name)
);

CREATE TABLE IF NOT EXISTS scrape_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER REFERENCES sites(id),
  params_json TEXT,
  success INTEGER NOT NULL,
  result_count INTEGER,
  claimed_count INTEGER,
  timed_out INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  error TEXT,
  version_id INTEGER REFERENCES recipe_versions(id),  -- which recipe definition actually produced this run, so a failure can be tied to a definition and diffed against the last stable one
  version_label TEXT,            -- denormalized "v1.3" for the same run. version_id points at a row that pruning may delete (scaffolding minors are meant to be disposable); this text survives, so run history always says WHICH version ran even once the definition itself is gone
  output_chars INTEGER,          -- length of the final JSON printed to stdout -- the real, ongoing "what does calling this recipe actually cost to read" metric, vs a one-time-measured claim
  ran_at TEXT NOT NULL
);
`;

// Old DBs predate the page_type/article columns. Migrate in place, preserving
// ids (site_fields/scrape_runs reference them) since SQLite AUTOINCREMENT
// tables accept explicit PK values on insert.
function migrateSitesTable(db) {
  const cols = db.prepare("PRAGMA table_info(sites)").all();
  if (cols.length === 0 || cols.some(c => c.name === 'page_type')) return;

  // Build the new table under a temp name, copy data in, drop the old one,
  // then rename the temp table into place. Renaming the OLD table instead
  // (rename-then-recreate) would make SQLite rewrite site_fields'/scrape_runs'
  // REFERENCES clause to follow it, leaving them pointing at a dropped table.
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(SITES_TABLE_SQL.replace('CREATE TABLE IF NOT EXISTS sites', 'CREATE TABLE IF NOT EXISTS sites_new'));
  db.exec(`
    INSERT INTO sites_new (id, hostname, page_type, display_name, status, nav_method, nav_template,
      nav_params_schema, pagination_method, pagination_config, card_anchor_text, card_min_text_len,
      content_selector, content_stop_text, ready_timeout_ms, result_count_regex, notes, first_seen, last_verified)
    SELECT id, hostname, 'listing', display_name, status, nav_method, nav_template,
      nav_params_schema, pagination_method, pagination_config, card_anchor_text, card_min_text_len,
      NULL, NULL, ready_timeout_ms, result_count_regex, notes, first_seen, last_verified
    FROM sites
  `);
  db.exec('DROP TABLE sites');
  db.exec('ALTER TABLE sites_new RENAME TO sites');
  try {
    db.exec("UPDATE sqlite_sequence SET seq = (SELECT MAX(id) FROM sites) WHERE name = 'sites'");
  } catch {
    /* sqlite_sequence row may not exist yet; harmless */
  }
  db.exec('PRAGMA foreign_keys = ON');
}

// Old DBs predate recipe_name (multiple recipes per hostname+page_type).
// Same rebuild-and-rename approach as migrateSitesTable, for the same reason
// (SQLite can't add a multi-column UNIQUE constraint via ALTER TABLE).
function migrateRecipeNameColumn(db) {
  const cols = db.prepare('PRAGMA table_info(sites)').all();
  if (cols.length === 0 || cols.some(c => c.name === 'recipe_name')) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(SITES_TABLE_SQL.replace('CREATE TABLE IF NOT EXISTS sites', 'CREATE TABLE IF NOT EXISTS sites_new'));
  db.exec(`
    INSERT INTO sites_new (id, hostname, page_type, recipe_name, display_name, status, nav_method, nav_template,
      nav_params_schema, pagination_method, pagination_config, card_anchor_text, card_min_text_len,
      content_selector, content_stop_text, ready_timeout_ms, result_count_regex, notes, first_seen, last_verified)
    SELECT id, hostname, page_type, 'default', display_name, status, nav_method, nav_template,
      nav_params_schema, pagination_method, pagination_config, card_anchor_text, card_min_text_len,
      content_selector, content_stop_text, ready_timeout_ms, result_count_regex, notes, first_seen, last_verified
    FROM sites
  `);
  db.exec('DROP TABLE sites');
  db.exec('ALTER TABLE sites_new RENAME TO sites');
  try {
    db.exec("UPDATE sqlite_sequence SET seq = (SELECT MAX(id) FROM sites) WHERE name = 'sites'");
  } catch {
    /* sqlite_sequence row may not exist yet; harmless */
  }
  db.exec('PRAGMA foreign_keys = ON');
}

// Old DBs predate action_type. Unlike page_type/recipe_name this needs no
// UNIQUE-constraint change, so a plain ADD COLUMN suffices (no rebuild).
function migrateActionTypeColumn(db) {
  const cols = db.prepare('PRAGMA table_info(sites)').all();
  if (cols.length === 0 || cols.some(c => c.name === 'action_type')) return;
  db.exec('ALTER TABLE sites ADD COLUMN action_type TEXT');
}

// Old DBs predate card_selector. Plain ADD COLUMN, same as action_type.
function migrateCardSelectorColumn(db) {
  const cols = db.prepare('PRAGMA table_info(sites)').all();
  if (cols.length === 0 || cols.some(c => c.name === 'card_selector')) return;
  db.exec('ALTER TABLE sites ADD COLUMN card_selector TEXT');
}

// Old DBs predate generic_actions.source. Plain ADD COLUMN. Existing rows
// default to 'user' so a pre-existing hand-registered action is never
// silently adopted (and then overwritten) by the builtin seeder; the seeder
// re-marks the ones it owns by name on the next open.
function migrateGenericActionSourceColumn(db) {
  const cols = db.prepare('PRAGMA table_info(generic_actions)').all();
  if (cols.length === 0 || cols.some(c => c.name === 'source')) return;
  db.exec("ALTER TABLE generic_actions ADD COLUMN source TEXT NOT NULL DEFAULT 'user'");
}

// Upserts the code-owned library from lib/builtinActions.js. Only rows it
// owns are touched, so a user-registered action of another name is safe.
// Runs on every open, so a change in code propagates without anyone having
// to re-register anything by hand.
function seedBuiltinActions(db) {
  // Compare first, write only what actually differs. openDb() runs in EVERY
  // process — including every engine.js child — so unconditionally upserting
  // all of these would put a write transaction on every single open, even
  // for read-only commands. That is real lock pressure when several scrapes
  // run at once (and it made the parallel test suite flaky). In the steady
  // state this is one read and zero writes.
  const existing = new Map(
    db
      .prepare('SELECT name, description, action_type, nav_params_schema, source, steps FROM generic_actions')
      .all()
      .map(r => [r.name, r])
  );

  const stale = BUILTIN_ACTIONS.filter(a => {
    const cur = existing.get(a.name);
    if (!cur) return true;
    return (
      cur.source !== 'builtin' ||
      cur.description !== (a.description ?? null) ||
      cur.action_type !== (a.action_type ?? null) ||
      cur.nav_params_schema !== (a.nav_params_schema ?? null) ||
      cur.steps !== JSON.stringify(a.steps)
    );
  });
  if (stale.length === 0) return;

  const now = new Date().toISOString();
  const upsert = db.prepare(
    `INSERT INTO generic_actions (name, description, action_type, nav_params_schema, source, steps, created_at, updated_at)
     VALUES (?,?,?,?,'builtin',?,?,?)
     ON CONFLICT(name) DO UPDATE SET
       description=excluded.description,
       action_type=excluded.action_type,
       nav_params_schema=excluded.nav_params_schema,
       source='builtin',
       steps=excluded.steps,
       updated_at=excluded.updated_at`
  );
  for (const a of stale) {
    upsert.run(a.name, a.description ?? null, a.action_type ?? null, a.nav_params_schema ?? null, JSON.stringify(a.steps), now, now);
  }
}

// Old DBs predate session_mode. Plain ADD COLUMN.
function migrateSessionModeColumn(db) {
  const cols = db.prepare('PRAGMA table_info(sites)').all();
  if (cols.length === 0 || cols.some(c => c.name === 'session_mode')) return;
  db.exec('ALTER TABLE sites ADD COLUMN session_mode TEXT');
}

// Old DBs predate scrape_runs.version_id / version_label. Plain ADD COLUMNs.
function migrateRunVersionColumn(db) {
  const cols = db.prepare('PRAGMA table_info(scrape_runs)').all();
  if (cols.length === 0) return;
  if (!cols.some(c => c.name === 'version_id')) {
    db.exec('ALTER TABLE scrape_runs ADD COLUMN version_id INTEGER REFERENCES recipe_versions(id)');
  }
  if (!cols.some(c => c.name === 'version_label')) {
    db.exec('ALTER TABLE scrape_runs ADD COLUMN version_label TEXT');
  }
}

// Every recipe that predates versioning has no history, so `diff` and
// "what did it look like when it worked" would be dead on arrival for the
// entire existing library. Snapshot each one's current shape as its
// baseline. Marked stable because it IS the version that has been in use —
// promoting later then reads as v2.0, which is honest: generation two.
//
// Guarded by PRAGMA user_version so it runs exactly ONCE per database, not
// "whenever some site lacks a version". That distinction is load-bearing:
// openDb() runs in every engine.js subprocess, and a condition that stays
// true turns every open into a writer. That is precisely how the earlier
// "parallel scrapes return empty JSON" bug worked — concurrent writers on
// one SQLite file — and an un-guarded version of this check reproduced it
// (3 test failures, all `Unexpected end of JSON input`). After the
// backfill, a site created without a version simply has none, which is
// correct: creating versions is register.js's job, not a reader's.
const SCHEMA_VERSION_BASELINE_BACKFILL = 1;
function backfillBaselineVersions(db) {
  const { user_version: current } = db.prepare('PRAGMA user_version').get();
  if (current >= SCHEMA_VERSION_BASELINE_BACKFILL) return 0;

  const missing = db
    .prepare('SELECT id FROM sites WHERE id NOT IN (SELECT DISTINCT site_id FROM recipe_versions)')
    .all();
  // OR IGNORE so that two processes racing on a fresh DB can't collide on
  // UNIQUE(site_id, major, minor); the loser's insert is simply a no-op.
  const insert = db.prepare(
    'INSERT OR IGNORE INTO recipe_versions (site_id, major, minor, definition, stable, note, created_at) VALUES (?,1,0,?,1,?,?)'
  );
  const now = new Date().toISOString();
  for (const { id } of missing) {
    const def = recipeDefinition(db, id);
    if (def) insert.run(id, JSON.stringify(def), 'baseline captured when versioning was introduced', now);
  }
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION_BASELINE_BACKFILL}`);
  return missing.length;
}

// Old DBs predate output_chars on scrape_runs. Plain ADD COLUMN.
function migrateOutputCharsColumn(db) {
  const cols = db.prepare('PRAGMA table_info(scrape_runs)').all();
  if (cols.length === 0 || cols.some(c => c.name === 'output_chars')) return;
  db.exec('ALTER TABLE scrape_runs ADD COLUMN output_chars INTEGER');
}

// Every engine.js run is its own process opening this same file, so two
// scrapes started at once are two SQLite writers. Without these pragmas
// that fails HARD and immediately: SQLite's default rollback journal takes
// an exclusive write lock, and with no busy timeout the loser gets
// SQLITE_BUSY ("database is locked") instead of waiting. It bit openDb()
// itself — which writes on every open (CREATE TABLE IF NOT EXISTS, the
// ALTER TABLE migrations, the seed check) even for read-only commands like
// `query.js sites` — so a losing process died before printing any JSON at
// all. That is the real cause of the previously-noted "N parallel scrapes
// all failed with empty or truncated JSON", which had been guessed at as
// browser/memory resource contention.
//
// WAL lets readers run concurrently with a writer; busy_timeout makes a
// blocked writer wait its turn instead of failing instantly.
function applyConcurrencyPragmas(db) {
  try {
    db.exec('PRAGMA journal_mode = WAL');
  } catch {
    /* WAL needs a real file on a filesystem that supports it; plain journal still works */
  }
  db.exec('PRAGMA busy_timeout = 10000');
}

function openDb() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  applyConcurrencyPragmas(db);
  db.exec(SCHEMA);
  migrateSitesTable(db);
  migrateRecipeNameColumn(db);
  migrateActionTypeColumn(db);
  migrateCardSelectorColumn(db);
  migrateSessionModeColumn(db);
  migrateOutputCharsColumn(db);
  migrateGenericActionSourceColumn(db);
  migrateRunVersionColumn(db);
  backfillBaselineVersions(db);
  seedActionTypes(db);
  seedBuiltinActions(db);
  return db;
}

// hostname arg syntax: "<hostname>" (page_type defaults to 'listing',
// recipe_name defaults to 'default', for back-compat) or
// "<hostname>#<page_type>" e.g. "example.com#article", or
// "<hostname>#<page_type>:<recipe_name>" e.g. "example.com#action:login"
// when a site has more than one recipe of the same page_type.
function parseSiteArg(arg) {
  const [rawHost, rest] = arg.split('#');
  let pageType = 'listing';
  let recipeName = 'default';
  if (rest) {
    const [pt, rn] = rest.split(':');
    pageType = pt || 'listing';
    recipeName = rn || 'default';
  }
  return { hostname: rawHost.replace(/^www\./, ''), pageType, recipeName };
}

function getSite(db, hostname, pageType = 'listing', recipeName = 'default') {
  return db
    .prepare('SELECT * FROM sites WHERE hostname = ? AND page_type = ? AND recipe_name = ?')
    .get(hostname, pageType, recipeName);
}

function getFields(db, siteId) {
  return db
    .prepare('SELECT * FROM site_fields WHERE site_id = ? ORDER BY field_order, id')
    .all(siteId);
}

function listSites(db) {
  return db
    .prepare('SELECT hostname, page_type, recipe_name, action_type, display_name, status, nav_method, last_verified, notes FROM sites ORDER BY hostname, page_type, recipe_name')
    .all();
}

function upsertSite(db, s) {
  const now = new Date().toISOString();
  const pageType = s.page_type || 'listing';
  const recipeName = s.recipe_name || 'default';
  const existing = getSite(db, s.hostname, pageType, recipeName);
  if (existing) {
    db.prepare(
      `UPDATE sites SET display_name=?, status=?, nav_method=?, nav_template=?, nav_params_schema=?, session_mode=?,
         pagination_method=?, pagination_config=?, action_type=?, card_anchor_text=?, card_selector=?, card_min_text_len=?,
         content_selector=?, content_stop_text=?, ready_timeout_ms=?, result_count_regex=?, notes=?, last_verified=?
       WHERE hostname=? AND page_type=? AND recipe_name=?`
    ).run(
      s.display_name ?? existing.display_name,
      s.status ?? existing.status,
      s.nav_method,
      s.nav_template,
      s.nav_params_schema ?? null,
      s.session_mode ?? null,
      s.pagination_method ?? 'none',
      s.pagination_config ?? null,
      s.action_type ?? null,
      s.card_anchor_text ?? null,
      s.card_selector ?? null,
      s.card_min_text_len ?? 80,
      s.content_selector ?? null,
      s.content_stop_text ?? null,
      s.ready_timeout_ms ?? 20000,
      s.result_count_regex ?? null,
      s.notes ?? null,
      now,
      s.hostname,
      pageType,
      recipeName
    );
    db.prepare('DELETE FROM site_fields WHERE site_id = ?').run(existing.id);
    return getSite(db, s.hostname, pageType, recipeName).id;
  } else {
    db.prepare(
      `INSERT INTO sites (hostname, page_type, recipe_name, display_name, status, nav_method, nav_template, nav_params_schema,
         session_mode, pagination_method, pagination_config, action_type, card_anchor_text, card_selector, card_min_text_len, content_selector,
         content_stop_text, ready_timeout_ms, result_count_regex, notes, first_seen, last_verified)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      s.hostname,
      pageType,
      recipeName,
      s.display_name ?? null,
      s.status ?? 'needs-review',
      s.nav_method,
      s.nav_template,
      s.nav_params_schema ?? null,
      s.session_mode ?? null,
      s.pagination_method ?? 'none',
      s.pagination_config ?? null,
      s.action_type ?? null,
      s.card_anchor_text ?? null,
      s.card_selector ?? null,
      s.card_min_text_len ?? 80,
      s.content_selector ?? null,
      s.content_stop_text ?? null,
      s.ready_timeout_ms ?? 20000,
      s.result_count_regex ?? null,
      s.notes ?? null,
      now,
      now
    );
    return getSite(db, s.hostname, pageType, recipeName).id;
  }
}

// The canonical, comparable form of a recipe: everything that defines
// BEHAVIOR, and nothing that merely records bookkeeping. ids and
// first_seen/last_verified are excluded on purpose — otherwise every
// re-register would look like a change and spam the history.
const VERSIONED_SITE_COLUMNS = [
  'hostname', 'page_type', 'recipe_name', 'display_name', 'status', 'nav_method', 'nav_template',
  'nav_params_schema', 'session_mode', 'pagination_method', 'pagination_config', 'action_type',
  'card_anchor_text', 'card_selector', 'card_min_text_len', 'content_selector', 'content_stop_text',
  'ready_timeout_ms', 'result_count_regex', 'notes',
];
const VERSIONED_FIELD_COLUMNS = [
  'field_name', 'extract_kind', 'segment_index', 'regex_pattern', 'attribute_name', 'example_value', 'field_order',
];

function recipeDefinition(db, siteId) {
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(siteId);
  if (!site) return null;
  const def = {};
  for (const c of VERSIONED_SITE_COLUMNS) def[c] = site[c] ?? null;
  def.fields = getFields(db, siteId).map(f => {
    const o = {};
    for (const c of VERSIONED_FIELD_COLUMNS) o[c] = f[c] ?? null;
    return o;
  });
  return def;
}

function getCurrentVersion(db, siteId) {
  return db
    .prepare('SELECT * FROM recipe_versions WHERE site_id = ? ORDER BY major DESC, minor DESC LIMIT 1')
    .get(siteId);
}

function listVersions(db, siteId) {
  return db
    .prepare('SELECT id, major, minor, stable, note, created_at FROM recipe_versions WHERE site_id = ? ORDER BY major, minor')
    .all(siteId);
}

function getVersion(db, siteId, major, minor) {
  return db
    .prepare('SELECT * FROM recipe_versions WHERE site_id = ? AND major = ? AND minor = ?')
    .get(siteId, major, minor);
}

// Keeps every stable version plus the most recent `keep` non-stable ones.
// Iterating on a broken site is supposed to be cheap and disposable; only
// the versions someone deliberately blessed are permanent.
//
// `stable = 0` in the WHERE clause is the guarantee, not an optimization: a
// promoted version must be unreachable by pruning no matter how much churn
// follows, or iterating freely stops being safe. Nothing anywhere sets
// stable back to 0, so once blessed a version stays blessed.
function pruneVersions(db, siteId, keep = 5) {
  const doomed = db
    .prepare(
      `SELECT id FROM recipe_versions
        WHERE site_id = ? AND stable = 0
          AND id NOT IN (SELECT id FROM recipe_versions WHERE site_id = ? AND stable = 0 ORDER BY major DESC, minor DESC LIMIT ?)`
    )
    .all(siteId, siteId, keep);
  if (!doomed.length) return 0;
  // Only the FK is cleared; scrape_runs.version_label keeps saying which
  // version ran, so pruning scaffolding costs you the ability to diff that
  // definition, never the ability to read the run history.
  const clearRuns = db.prepare('UPDATE scrape_runs SET version_id = NULL WHERE version_id = ?');
  const del = db.prepare('DELETE FROM recipe_versions WHERE id = ?');
  for (const d of doomed) {
    clearRuns.run(d.id);
    del.run(d.id);
  }
  return doomed.length;
}

// Snapshots the recipe as a new MINOR, but only when it actually differs
// from the current version — a no-op re-register shouldn't create history.
// Returns the version row that is now current either way.
function snapshotVersionIfChanged(db, siteId, { note } = {}) {
  const def = recipeDefinition(db, siteId);
  if (!def) return null;
  const serialized = JSON.stringify(def);
  const current = getCurrentVersion(db, siteId);
  if (current && current.definition === serialized) return current;

  const major = current ? current.major : 1;
  const minor = current ? current.minor + 1 : 0;
  db.prepare(
    'INSERT INTO recipe_versions (site_id, major, minor, definition, stable, note, created_at) VALUES (?,?,?,?,0,?,?)'
  ).run(siteId, major, minor, serialized, note ?? null, new Date().toISOString());
  pruneVersions(db, siteId);
  return getCurrentVersion(db, siteId);
}

// Marks the current version known-good and opens the next major for
// further iteration, so stable generations read v1.0, v2.0, v3.0 and the
// scaffolding between them is whatever minors were needed to get there.
function promoteVersion(db, siteId, { note } = {}) {
  const current = getCurrentVersion(db, siteId);
  if (!current) return null;
  db.prepare('UPDATE recipe_versions SET stable = 1, note = COALESCE(?, note) WHERE id = ?').run(note ?? null, current.id);
  const promoted = db.prepare('SELECT * FROM recipe_versions WHERE id = ?').get(current.id);
  // Re-open at the next major so later edits don't accumulate under a
  // version number someone has already blessed.
  db.prepare(
    'INSERT INTO recipe_versions (site_id, major, minor, definition, stable, note, created_at) VALUES (?,?,?,?,0,?,?)'
  ).run(siteId, current.major + 1, 0, current.definition, `carried forward from v${current.major}.${current.minor}`, new Date().toISOString());
  pruneVersions(db, siteId);
  return promoted;
}

// Writes a stored definition back over the live recipe. This is the other
// half of "look back at how it was stable before" — without it you can see
// the old version but not get it back, and the usual way you find out a
// change was wrong is that the recipe is now broken. Recorded as a new
// minor rather than by rewinding history, so the failed attempt stays
// visible instead of being quietly erased.
function restoreVersion(db, siteId, major, minor) {
  const version = getVersion(db, siteId, major, minor);
  if (!version) return null;
  const def = JSON.parse(version.definition);

  const assignable = VERSIONED_SITE_COLUMNS.filter(c => c !== 'hostname' && c !== 'page_type' && c !== 'recipe_name');
  db.prepare(
    `UPDATE sites SET ${assignable.map(c => `${c} = ?`).join(', ')}, last_verified = ? WHERE id = ?`
  ).run(...assignable.map(c => def[c] ?? null), new Date().toISOString(), siteId);

  db.prepare('DELETE FROM site_fields WHERE site_id = ?').run(siteId);
  for (const f of def.fields || []) {
    insertField(db, siteId, f, f.field_order ?? 0);
  }
  return snapshotVersionIfChanged(db, siteId, { note: `restored from v${major}.${minor}` });
}

// Removes a recipe and everything hanging off it, in FK-safe order. The
// order is not optional: runs reference versions, versions reference the
// site, and foreign keys are enforced, so deleting the site first simply
// fails. Fresh DBs also get ON DELETE CASCADE on recipe_versions, but this
// works with or without it — DBs created before that was added keep the
// plain reference, and SQLite cannot ALTER a constraint onto them.
function deleteSite(db, siteId) {
  db.prepare('DELETE FROM scrape_runs WHERE site_id = ?').run(siteId);
  db.prepare('DELETE FROM recipe_versions WHERE site_id = ?').run(siteId);
  db.prepare('DELETE FROM site_fields WHERE site_id = ?').run(siteId);
  db.prepare('DELETE FROM sites WHERE id = ?').run(siteId);
}

function getLastStableVersion(db, siteId) {
  return db
    .prepare('SELECT * FROM recipe_versions WHERE site_id = ? AND stable = 1 ORDER BY major DESC, minor DESC LIMIT 1')
    .get(siteId);
}

function listActionTypes(db) {
  return db.prepare('SELECT * FROM action_types ORDER BY name').all();
}

function getActionType(db, name) {
  return db.prepare('SELECT * FROM action_types WHERE name = ?').get(name);
}

function insertActionType(db, name, description) {
  db.prepare('INSERT INTO action_types (name, description, created_at) VALUES (?,?,?)').run(
    name,
    description ?? null,
    new Date().toISOString()
  );
  return getActionType(db, name);
}

function listGenericActions(db) {
  return db
    .prepare('SELECT id, name, description, action_type, nav_params_schema, source, created_at, updated_at FROM generic_actions ORDER BY name')
    .all();
}

function getGenericAction(db, name) {
  return db.prepare('SELECT * FROM generic_actions WHERE name = ?').get(name);
}

function upsertGenericAction(db, g) {
  const now = new Date().toISOString();
  const existing = getGenericAction(db, g.name);
  if (existing) {
    db.prepare(
      `UPDATE generic_actions SET description=?, action_type=?, nav_params_schema=?, steps=?, updated_at=? WHERE name=?`
    ).run(g.description ?? existing.description, g.action_type ?? null, g.nav_params_schema ?? null, g.steps, now, g.name);
    return getGenericAction(db, g.name).id;
  }
  db.prepare(
    `INSERT INTO generic_actions (name, description, action_type, nav_params_schema, steps, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)`
  ).run(g.name, g.description ?? null, g.action_type ?? null, g.nav_params_schema ?? null, g.steps, now, now);
  return getGenericAction(db, g.name).id;
}

function insertField(db, siteId, f, order) {
  db.prepare(
    `INSERT INTO site_fields (site_id, field_name, extract_kind, segment_index, regex_pattern, attribute_name, example_value, field_order)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(
    siteId,
    f.field_name,
    f.extract_kind,
    f.segment_index ?? null,
    f.regex_pattern ?? null,
    f.attribute_name ?? null,
    f.example_value ?? null,
    order
  );
}

function logRun(db, run) {
  db.prepare(
    `INSERT INTO scrape_runs (site_id, params_json, success, result_count, claimed_count, timed_out, duration_ms, error, version_id, version_label, output_chars, ran_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    run.siteId ?? null,
    JSON.stringify(run.params ?? {}),
    run.success ? 1 : 0,
    run.resultCount ?? null,
    run.claimedCount ?? null,
    run.timedOut ? 1 : 0,
    run.durationMs ?? null,
    run.error ?? null,
    run.versionId ?? null,
    run.versionLabel ?? null,
    run.outputChars ?? null,
    new Date().toISOString()
  );
}

function getRuns(db, siteId, limit = 10) {
  return db
    .prepare('SELECT * FROM scrape_runs WHERE site_id = ? ORDER BY id DESC LIMIT ?')
    .all(siteId, limit);
}

// Reliability of each recipe over its most recent `recentN` runs, next to
// the status someone typed once. scrape_runs was always meant to give
// "3/3 recent runs succeeded" instead of a stale flag, but nothing
// actually computed it — so a recipe could sit at status:"working" while
// failing most runs and no one querying `sites` would see it. Recent-window
// (not lifetime) so an old rough patch doesn't permanently condemn a recipe
// that works now. `statusDisagrees` is the thing worth acting on: declared
// working, but recent runs say otherwise.
function getRecipeHealth(db, recentN = 10) {
  const rows = db
    .prepare(
      `WITH ranked AS (
         SELECT r.site_id, r.success, r.ran_at, r.error, r.timed_out,
                ROW_NUMBER() OVER (PARTITION BY r.site_id ORDER BY r.id DESC) AS rn
         FROM scrape_runs r
         WHERE r.site_id IS NOT NULL
       )
       SELECT s.hostname, s.page_type, s.recipe_name, s.status,
              COUNT(k.site_id) AS recentRuns,
              SUM(CASE WHEN k.success = 1 THEN 1 ELSE 0 END) AS recentOk,
              MAX(k.ran_at) AS lastRunAt,
              (SELECT r2.error FROM scrape_runs r2
                WHERE r2.site_id = s.id AND r2.success = 0 AND r2.error IS NOT NULL
                ORDER BY r2.id DESC LIMIT 1) AS lastError
       FROM sites s
       LEFT JOIN ranked k ON k.site_id = s.id AND k.rn <= ?
       GROUP BY s.id
       ORDER BY s.hostname, s.page_type, s.recipe_name`
    )
    .all(recentN);

  return rows.map(r => {
    const recentRuns = r.recentRuns ?? 0;
    const recentOk = r.recentOk ?? 0;
    const successRate = recentRuns > 0 ? Math.round((recentOk / recentRuns) * 100) : null;
    return {
      hostname: r.hostname,
      page_type: r.page_type,
      recipe_name: r.recipe_name,
      status: r.status,
      recentRuns,
      recentOk,
      successRate,
      lastRunAt: r.lastRunAt,
      lastError: r.lastError,
      // Enough runs to mean something, declared healthy, mostly isn't.
      statusDisagrees: r.status === 'working' && recentRuns >= 3 && successRate < 50,
      // Never actually exercised — "working" here is an untested assertion.
      neverRun: recentRuns === 0,
    };
  });
}

// Per-recipe output-size summary from real run history — chars/4 is a
// standard rough token-estimate heuristic (not exact; genuinely varies by
// content), good enough to turn "how much does calling this recipe cost"
// into an ongoing, queryable number instead of a one-time claim.
function getEfficiencyStats(db) {
  return db
    .prepare(
      `SELECT s.hostname, s.page_type, s.recipe_name,
         COUNT(*) AS runCount,
         AVG(r.output_chars) AS avgOutputChars,
         MIN(r.output_chars) AS minOutputChars,
         MAX(r.output_chars) AS maxOutputChars
       FROM scrape_runs r
       JOIN sites s ON s.id = r.site_id
       WHERE r.output_chars IS NOT NULL
       GROUP BY s.id
       ORDER BY s.hostname, s.page_type, s.recipe_name`
    )
    .all()
    .map(row => ({
      ...row,
      avgOutputChars: Math.round(row.avgOutputChars),
      avgEstTokens: Math.round(row.avgOutputChars / 4),
    }));
}

module.exports = {
  openDb,
  getSite,
  getFields,
  listSites,
  upsertSite,
  insertField,
  logRun,
  getRuns,
  getRecipeHealth,
  recipeDefinition,
  snapshotVersionIfChanged,
  promoteVersion,
  restoreVersion,
  deleteSite,
  listVersions,
  getVersion,
  getCurrentVersion,
  getLastStableVersion,
  pruneVersions,
  getEfficiencyStats,
  parseSiteArg,
  listActionTypes,
  getActionType,
  insertActionType,
  listGenericActions,
  getGenericAction,
  upsertGenericAction,
  DB_PATH,
};
