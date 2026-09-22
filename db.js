const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'data', 'scrapers.db');

const SITES_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hostname TEXT NOT NULL,
  page_type TEXT NOT NULL DEFAULT 'listing',         -- 'listing' (repeated cards) | 'article' (single content block)
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'needs-review',       -- 'working' | 'broken' | 'needs-review'
  nav_method TEXT NOT NULL,                          -- 'url_param' | 'ui_steps' | 'direct_url' (article: goto params.url as-is)
  nav_template TEXT NOT NULL,                        -- URL template (url_param/direct_url) OR JSON step array (ui_steps)
  nav_params_schema TEXT,                            -- JSON: documents accepted params, for callers
  pagination_method TEXT NOT NULL DEFAULT 'none',    -- 'none' | 'url_param' | 'click_next' (click_next not yet implemented)
  pagination_config TEXT,
  card_anchor_text TEXT,                             -- listing only: exact text of a reliably-present per-card element
  card_min_text_len INTEGER NOT NULL DEFAULT 80,      -- min text length before considering the target ready (card container for listing, content_selector element for article)
  content_selector TEXT,                              -- article only: CSS selector for the main content container (defaults to body)
  content_stop_text TEXT,                              -- article only: truncate extracted text at the first occurrence of this literal string (cuts off "related content" widgets etc.)
  ready_timeout_ms INTEGER NOT NULL DEFAULT 20000,
  result_count_regex TEXT,                            -- listing only: regex (1 capture group) against page body text, for a self-consistency check
  notes TEXT,
  first_seen TEXT NOT NULL,
  last_verified TEXT NOT NULL,
  UNIQUE(hostname, page_type)
);
`;

const SCHEMA = `
${SITES_TABLE_SQL}
CREATE TABLE IF NOT EXISTS site_fields (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL REFERENCES sites(id),
  field_name TEXT NOT NULL,
  extract_kind TEXT NOT NULL,        -- 'positional_segment' | 'regex_anywhere' | 'anchor_attribute' | 'title_regex' | 'full_blob'
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

function openDb() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(SCHEMA);
  migrateSitesTable(db);
  return db;
}

// hostname arg syntax: "<hostname>" (page_type defaults to 'listing', for
// back-compat) or "<hostname>#<page_type>" e.g. "example.com#article".
function parseSiteArg(arg) {
  const [rawHost, pageType] = arg.split('#');
  return { hostname: rawHost.replace(/^www\./, ''), pageType: pageType || 'listing' };
}

function getSite(db, hostname, pageType = 'listing') {
  return db.prepare('SELECT * FROM sites WHERE hostname = ? AND page_type = ?').get(hostname, pageType);
}

function getFields(db, siteId) {
  return db
    .prepare('SELECT * FROM site_fields WHERE site_id = ? ORDER BY field_order, id')
    .all(siteId);
}

function listSites(db) {
  return db
    .prepare('SELECT hostname, page_type, display_name, status, nav_method, last_verified, notes FROM sites ORDER BY hostname, page_type')
    .all();
}

function upsertSite(db, s) {
  const now = new Date().toISOString();
  const pageType = s.page_type || 'listing';
  const existing = getSite(db, s.hostname, pageType);
  if (existing) {
    db.prepare(
      `UPDATE sites SET display_name=?, status=?, nav_method=?, nav_template=?, nav_params_schema=?,
         pagination_method=?, pagination_config=?, card_anchor_text=?, card_min_text_len=?,
         content_selector=?, content_stop_text=?, ready_timeout_ms=?, result_count_regex=?, notes=?, last_verified=?
       WHERE hostname=? AND page_type=?`
    ).run(
      s.display_name ?? existing.display_name,
      s.status ?? existing.status,
      s.nav_method,
      s.nav_template,
      s.nav_params_schema ?? null,
      s.pagination_method ?? 'none',
      s.pagination_config ?? null,
      s.card_anchor_text ?? null,
      s.card_min_text_len ?? 80,
      s.content_selector ?? null,
      s.content_stop_text ?? null,
      s.ready_timeout_ms ?? 20000,
      s.result_count_regex ?? null,
      s.notes ?? null,
      now,
      s.hostname,
      pageType
    );
    db.prepare('DELETE FROM site_fields WHERE site_id = ?').run(existing.id);
    return getSite(db, s.hostname, pageType).id;
  } else {
    db.prepare(
      `INSERT INTO sites (hostname, page_type, display_name, status, nav_method, nav_template, nav_params_schema,
         pagination_method, pagination_config, card_anchor_text, card_min_text_len, content_selector,
         content_stop_text, ready_timeout_ms, result_count_regex, notes, first_seen, last_verified)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      s.hostname,
      pageType,
      s.display_name ?? null,
      s.status ?? 'needs-review',
      s.nav_method,
      s.nav_template,
      s.nav_params_schema ?? null,
      s.pagination_method ?? 'none',
      s.pagination_config ?? null,
      s.card_anchor_text ?? null,
      s.card_min_text_len ?? 80,
      s.content_selector ?? null,
      s.content_stop_text ?? null,
      s.ready_timeout_ms ?? 20000,
      s.result_count_regex ?? null,
      s.notes ?? null,
      now,
      now
    );
    return getSite(db, s.hostname, pageType).id;
  }
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
    `INSERT INTO scrape_runs (site_id, params_json, success, result_count, claimed_count, timed_out, duration_ms, error, ran_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(
    run.siteId ?? null,
    JSON.stringify(run.params ?? {}),
    run.success ? 1 : 0,
    run.resultCount ?? null,
    run.claimedCount ?? null,
    run.timedOut ? 1 : 0,
    run.durationMs ?? null,
    run.error ?? null,
    new Date().toISOString()
  );
}

function getRuns(db, siteId, limit = 10) {
  return db
    .prepare('SELECT * FROM scrape_runs WHERE site_id = ? ORDER BY id DESC LIMIT ?')
    .all(siteId, limit);
}

module.exports = { openDb, getSite, getFields, listSites, upsertSite, insertField, logRun, getRuns, parseSiteArg, DB_PATH };
