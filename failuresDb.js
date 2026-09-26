// A SECOND database, separate from scrapers.db, holding what has gone wrong
// before and what fixed it.
//
// Why a separate file rather than more tables in scrapers.db:
//   - Different lifecycle. scrapers.db is this environment's recipe state;
//     this is accumulated troubleshooting knowledge, worth exporting and
//     sharing between machines on its own.
//   - Different write pattern. Failures are recorded exactly when a scrape
//     is failing, which is often when scrapers.db is busiest. Separate
//     files mean separate locks and no added contention on the hot path.
//   - Different blast radius. Deleting or rebuilding one should never risk
//     the other.
//
// As with scrapers.db, the FILE is gitignored (it accumulates hostnames,
// selectors and error text) while the TAXONOMY lives in code, so a fresh
// clone still knows the vocabulary even though it starts with no history.

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { FAILURE_TYPES } = require('./lib/failureTypes');

const FAILURES_DB_PATH = path.join(__dirname, 'data', 'failures.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS failure_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  failure_type TEXT NOT NULL REFERENCES failure_types(name),
  -- Which recipe. All nullable: a pattern can be about a whole site, or
  -- about no site at all ("Cloudflare interstitials look like this").
  hostname TEXT,
  page_type TEXT,
  recipe_name TEXT,
  -- Ties a failure to the exact definition that produced it. Text, not a
  -- FK -- this is a different database, and the version may later be
  -- pruned; the label outliving the row is the point.
  version_label TEXT,
  -- Where it broke, from the engine's failedStep.
  step_action TEXT,
  step_selector TEXT,
  step_from TEXT,               -- e.g. "generic:dismiss_overlay"
  symptom TEXT NOT NULL,        -- the observable: error text, "0 results", "wrong company field"
  diagnosis TEXT,               -- what it actually turned out to be
  resolution TEXT,              -- what fixed it, concretely
  debug_dir TEXT,               -- the capture that evidenced it, if kept
  occurrences INTEGER NOT NULL DEFAULT 1,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_failures_hostname ON failures(hostname);
CREATE INDEX IF NOT EXISTS idx_failures_type ON failures(failure_type);
`;

function applyConcurrencyPragmas(db) {
  try {
    db.exec('PRAGMA journal_mode = WAL');
  } catch {
    /* WAL needs a filesystem that supports it; plain journal still works */
  }
  db.exec('PRAGMA busy_timeout = 10000');
}

// Compare-before-write, like seedBuiltinActions. An unconditional upsert on
// every open turns every reader into a writer, which is how the earlier
// "parallel scrapes return empty JSON" bug worked.
function seedFailureTypes(db) {
  const existing = new Map(db.prepare('SELECT name, description FROM failure_types').all().map(r => [r.name, r.description]));
  const stale = FAILURE_TYPES.filter(([name, description]) => existing.get(name) !== description);
  if (stale.length === 0) return;
  const now = new Date().toISOString();
  const upsert = db.prepare(
    `INSERT INTO failure_types (name, description, created_at) VALUES (?,?,?)
     ON CONFLICT(name) DO UPDATE SET description = excluded.description`
  );
  for (const [name, description] of stale) upsert.run(name, description, now);
}

function openFailuresDb() {
  fs.mkdirSync(path.dirname(FAILURES_DB_PATH), { recursive: true });
  const db = new DatabaseSync(FAILURES_DB_PATH);
  applyConcurrencyPragmas(db);
  db.exec(SCHEMA);
  seedFailureTypes(db);
  return db;
}

function listFailureTypes(db) {
  return db.prepare('SELECT name, description FROM failure_types ORDER BY name').all();
}

function getFailureType(db, name) {
  return db.prepare('SELECT * FROM failure_types WHERE name = ?').get(name);
}

function insertFailureType(db, name, description) {
  db.prepare('INSERT INTO failure_types (name, description, created_at) VALUES (?,?,?)')
    .run(name, description, new Date().toISOString());
}

// Two records describe the same problem when the same kind of thing broke
// at the same place on the same site. Symptom text is deliberately NOT part
// of the identity -- error messages vary ("timeout 8000ms" vs "timeout
// 30000ms") for what is obviously one recurring failure, and counting those
// separately is exactly the fragmentation this table exists to avoid.
function signatureOf(f) {
  return [f.failure_type, f.hostname ?? '', f.page_type ?? '', f.recipe_name ?? '', f.step_selector ?? '', f.step_action ?? '']
    .join('\u0000');
}

// Records a failure, or bumps the one it matches. Returns {id, recorded}
// where recorded is 'new' or 'repeat' -- a repeat is itself a finding
// ("this is the fourth time") and the caller should say so.
function recordFailure(db, f) {
  const now = new Date().toISOString();
  const candidates = db
    .prepare('SELECT * FROM failures WHERE failure_type = ? AND IFNULL(hostname, \'\') = IFNULL(?, \'\')')
    .all(f.failure_type, f.hostname ?? null);
  const match = candidates.find(c => signatureOf(c) === signatureOf(f));

  if (match) {
    db.prepare(
      `UPDATE failures SET occurrences = occurrences + 1, last_seen = ?,
         version_label = COALESCE(?, version_label),
         debug_dir = COALESCE(?, debug_dir),
         diagnosis = COALESCE(?, diagnosis),
         resolution = COALESCE(?, resolution)
       WHERE id = ?`
    ).run(now, f.version_label ?? null, f.debug_dir ?? null, f.diagnosis ?? null, f.resolution ?? null, match.id);
    return { id: match.id, recorded: 'repeat', occurrences: match.occurrences + 1 };
  }

  const info = db.prepare(
    `INSERT INTO failures
       (failure_type, hostname, page_type, recipe_name, version_label,
        step_action, step_selector, step_from, symptom, diagnosis, resolution, debug_dir,
        occurrences, first_seen, last_seen)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`
  ).run(
    f.failure_type,
    f.hostname ?? null,
    f.page_type ?? null,
    f.recipe_name ?? null,
    f.version_label ?? null,
    f.step_action ?? null,
    f.step_selector ?? null,
    f.step_from ?? null,
    f.symptom,
    f.diagnosis ?? null,
    f.resolution ?? null,
    f.debug_dir ?? null,
    now,
    now
  );
  return { id: Number(info.lastInsertRowid), recorded: 'new', occurrences: 1 };
}

function listFailures(db, { hostname, failureType, limit = 50 } = {}) {
  const where = [];
  const args = [];
  if (hostname) {
    where.push('hostname = ?');
    args.push(hostname);
  }
  if (failureType) {
    where.push('failure_type = ?');
    args.push(failureType);
  }
  const sql = `SELECT * FROM failures ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY occurrences DESC, last_seen DESC LIMIT ?`;
  return db.prepare(sql).all(...args, limit);
}

// "What breaks most often, across everything?" -- the question that makes
// this worth keeping. Answered from real counts, not impressions.
function commonFailures(db, limit = 10) {
  return db
    .prepare(
      `SELECT failure_type,
              SUM(occurrences) AS total,
              COUNT(*) AS distinct_cases,
              COUNT(DISTINCT hostname) AS sites
         FROM failures GROUP BY failure_type
         ORDER BY total DESC LIMIT ?`
    )
    .all(limit);
}

const STOP_WORDS = new Set(['the', 'for', 'and', 'with', 'failed', 'error', 'exceeded', 'waiting', 'timeout', 'ms']);
function tokens(s) {
  return new Set(
    String(s || '')
      .toLowerCase()
      .split(/[^a-z0-9_-]+/)
      .filter(t => t.length > 2 && !STOP_WORDS.has(t))
  );
}

// Ranks known failures against a new one. This is the "check the common
// points of failure first" path: before re-deriving a recipe from scratch,
// ask whether this shape of break is already understood.
//
// Scored rather than filtered, because the most useful hit is often a
// DIFFERENT site with the same failure type and a resolution that
// transfers ("this is the consent-overlay pattern again").
function matchFailures(db, probe, limit = 5) {
  const all = db.prepare('SELECT * FROM failures').all();
  const probeTokens = tokens(`${probe.symptom ?? ''} ${probe.step_selector ?? ''}`);

  const scored = all.map(f => {
    let score = 0;
    const why = [];
    if (probe.hostname && f.hostname === probe.hostname) {
      score += 5;
      why.push('same site');
    }
    if (probe.failure_type && f.failure_type === probe.failure_type) {
      score += 4;
      why.push('same failure type');
    }
    if (probe.step_selector && f.step_selector && f.step_selector === probe.step_selector) {
      score += 4;
      why.push('same selector');
    }
    if (probe.step_action && f.step_action === probe.step_action) {
      score += 1;
      why.push('same step action');
    }
    if (probe.step_from && f.step_from === probe.step_from) {
      score += 2;
      why.push(`both inside ${f.step_from}`);
    }
    const overlap = [...tokens(`${f.symptom} ${f.step_selector ?? ''}`)].filter(t => probeTokens.has(t));
    if (overlap.length) {
      score += Math.min(overlap.length, 3);
      why.push(`shared terms: ${overlap.slice(0, 3).join(', ')}`);
    }
    // A pattern seen many times is more likely to be the explanation than
    // a one-off, but only as a tiebreak -- never enough to surface on its own.
    if (f.occurrences > 1) score += Math.min(f.occurrences / 10, 1);
    return { ...f, score: Math.round(score * 10) / 10, why };
  });

  return scored
    .filter(f => f.score >= 4)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function deleteFailure(db, id) {
  db.prepare('DELETE FROM failures WHERE id = ?').run(id);
}

module.exports = {
  FAILURES_DB_PATH,
  openFailuresDb,
  listFailureTypes,
  getFailureType,
  insertFailureType,
  recordFailure,
  listFailures,
  commonFailures,
  matchFailures,
  deleteFailure,
  signatureOf,
};
