const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'data', 'scrapers.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hostname TEXT UNIQUE NOT NULL,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'needs-review',       -- 'working' | 'broken' | 'needs-review'
  nav_method TEXT NOT NULL,                          -- 'url_param' | 'ui_steps'
  nav_template TEXT NOT NULL,                        -- URL template (url_param) OR JSON step array (ui_steps)
  nav_params_schema TEXT,                            -- JSON: documents accepted params, for callers
  pagination_method TEXT NOT NULL DEFAULT 'none',    -- 'none' | 'url_param' | 'click_next' (click_next not yet implemented)
  pagination_config TEXT,
  card_anchor_text TEXT NOT NULL,                    -- exact text of a reliably-present per-card element (e.g. link text "Job Posting")
  card_min_text_len INTEGER NOT NULL DEFAULT 80,      -- how far up the DOM to walk from the anchor to find the card container
  ready_timeout_ms INTEGER NOT NULL DEFAULT 20000,
  result_count_regex TEXT,                            -- regex (1 capture group) against page body text, for a self-consistency check
  notes TEXT,
  first_seen TEXT NOT NULL,
  last_verified TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS site_fields (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL REFERENCES sites(id),
  field_name TEXT NOT NULL,
  extract_kind TEXT NOT NULL,        -- 'positional_segment' | 'regex_anywhere' | 'anchor_attribute'
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

function openDb() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(SCHEMA);
  return db;
}

function getSite(db, hostname) {
  return db.prepare('SELECT * FROM sites WHERE hostname = ?').get(hostname);
}

function getFields(db, siteId) {
  return db
    .prepare('SELECT * FROM site_fields WHERE site_id = ? ORDER BY field_order, id')
    .all(siteId);
}

function listSites(db) {
  return db
    .prepare('SELECT hostname, display_name, status, nav_method, last_verified, notes FROM sites ORDER BY hostname')
    .all();
}

function upsertSite(db, s) {
  const now = new Date().toISOString();
  const existing = getSite(db, s.hostname);
  if (existing) {
    db.prepare(
      `UPDATE sites SET display_name=?, status=?, nav_method=?, nav_template=?, nav_params_schema=?,
         pagination_method=?, pagination_config=?, card_anchor_text=?, card_min_text_len=?,
         ready_timeout_ms=?, result_count_regex=?, notes=?, last_verified=?
       WHERE hostname=?`
    ).run(
      s.display_name ?? existing.display_name,
      s.status ?? existing.status,
      s.nav_method,
      s.nav_template,
      s.nav_params_schema ?? null,
      s.pagination_method ?? 'none',
      s.pagination_config ?? null,
      s.card_anchor_text,
      s.card_min_text_len ?? 80,
      s.ready_timeout_ms ?? 20000,
      s.result_count_regex ?? null,
      s.notes ?? null,
      now,
      s.hostname
    );
    db.prepare('DELETE FROM site_fields WHERE site_id = ?').run(existing.id);
    return getSite(db, s.hostname).id;
  } else {
    db.prepare(
      `INSERT INTO sites (hostname, display_name, status, nav_method, nav_template, nav_params_schema,
         pagination_method, pagination_config, card_anchor_text, card_min_text_len, ready_timeout_ms,
         result_count_regex, notes, first_seen, last_verified)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      s.hostname,
      s.display_name ?? null,
      s.status ?? 'needs-review',
      s.nav_method,
      s.nav_template,
      s.nav_params_schema ?? null,
      s.pagination_method ?? 'none',
      s.pagination_config ?? null,
      s.card_anchor_text,
      s.card_min_text_len ?? 80,
      s.ready_timeout_ms ?? 20000,
      s.result_count_regex ?? null,
      s.notes ?? null,
      now,
      now
    );
    return getSite(db, s.hostname).id;
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

module.exports = { openDb, getSite, getFields, listSites, upsertSite, insertField, logRun, getRuns, DB_PATH };
