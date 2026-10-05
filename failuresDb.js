// A SECOND database, separate from the recipe DB (db.js), holding what has
// gone wrong before and what fixed it.
//
// Why a separate file rather than more tables in the recipe DB:
//   - Different lifecycle. The recipe DB is this environment's recipe state;
//     this is accumulated troubleshooting knowledge, worth exporting and
//     sharing between machines on its own.
//   - Different write pattern. Failures are recorded exactly when a scrape
//     is failing, which is often when the recipe DB is busiest. Separate
//     files mean separate locks and no added contention on the hot path.
//   - Different blast radius. Deleting or rebuilding one should never risk
//     the other.
//
// As with the recipe DB, the FILE is gitignored (it accumulates hostnames,
// selectors and error text) while the TAXONOMY lives in code, so a fresh
// clone still knows the vocabulary even though it starts with no history.

const { DatabaseSync } = require('node:sqlite');
const { assertAuthorized, authorize } = require('./lib/writeGuard');
const fs = require('fs');
const path = require('path');
const { FAILURE_TYPES } = require('./lib/failureTypes');
const { BLOCKER_SIGNATURES, WALL_SERVICES } = require('./lib/blockerSignatures');
const { PROBE_KNOWLEDGE } = require('./lib/probeKnowledge');

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

-- How a walled page is RECOGNISED. A table rather than a literal in probe
-- code, because this is precisely the knowledge that grows: vendors change
-- their markup, new services appear, and a site occasionally needs a
-- signature nobody has seen. Frozen in code, every discovery would need a
-- code change and anything learned in a session would be lost.
-- Seeded from lib/blockerSignatures.js so a fresh clone still recognises the
-- common services; rows added at runtime are source='user' and survive
-- re-seeding, same contract as generic_actions.
CREATE TABLE IF NOT EXISTS blocker_signatures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service TEXT NOT NULL,              -- cloudflare | datadome | login_wall | ...
  where_seen TEXT NOT NULL,           -- 'title' | 'body' | 'resource' | 'dom'
  pattern TEXT NOT NULL,              -- regex source, or a CSS selector when where_seen='dom'
  flags TEXT,                         -- regex flags; NULL for dom selectors
  blocking_weight INTEGER NOT NULL DEFAULT 1,  -- 2 = this alone means walled; 1 = corroborating only
  source TEXT NOT NULL DEFAULT 'builtin',
  notes TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(service, where_seen, pattern)
);

CREATE INDEX IF NOT EXISTS idx_sig_service ON blocker_signatures(service);

-- What the probes KNOW: attribute names, phrases and markers that grow as new
-- sites and frameworks are met. The probe kinds themselves stay in code —
-- executing JavaScript from a writable row would be arbitrary code execution
-- from a data store. Numeric thresholds also stay in code, because they are
-- tuning rather than knowledge.
-- Seeded from lib/probeKnowledge.js so a fresh clone has the baseline; rows
-- added at runtime are source='user' and survive re-seeding.
CREATE TABLE IF NOT EXISTS probe_knowledge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  probe_kind TEXT NOT NULL,           -- forms | empty_state | repeated_structure | ...
  category TEXT NOT NULL,             -- stable_attr | required_marker | submit_text | empty_phrase | generated_class
  value_kind TEXT NOT NULL,           -- 'attr' | 'pattern' | 'text'
  value TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'builtin',
  notes TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(probe_kind, category, value)
);

CREATE INDEX IF NOT EXISTS idx_pk_kind ON probe_knowledge(probe_kind, category);
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

// Compare-before-write, like seedFailureTypes: an unconditional upsert on
// every open turns every reader into a writer.
function seedBlockerSignatures(db) {
  const existing = new Map(
    db
      .prepare("SELECT service, where_seen, pattern, flags, blocking_weight FROM blocker_signatures WHERE source = 'builtin'")
      .all()
      .map(r => [`${r.service}\u0000${r.where_seen}\u0000${r.pattern}`, r])
  );
  const stale = BLOCKER_SIGNATURES.filter(([service, where, pattern, flags, weight]) => {
    const cur = existing.get(`${service}\u0000${where}\u0000${pattern}`);
    return !cur || cur.flags !== (flags ?? null) || cur.blocking_weight !== weight;
  });
  if (stale.length === 0) return;
  const now = new Date().toISOString();
  const upsert = db.prepare(
    `INSERT INTO blocker_signatures (service, where_seen, pattern, flags, blocking_weight, source, created_at)
     VALUES (?,?,?,?,?, 'builtin', ?)
     ON CONFLICT(service, where_seen, pattern) DO UPDATE SET
       flags = excluded.flags, blocking_weight = excluded.blocking_weight`
  );
  for (const [service, where, pattern, flags, weight] of stale) {
    upsert.run(service, where, pattern, flags ?? null, weight, now);
  }
}

function listBlockerSignatures(db, { service } = {}) {
  return service
    ? db.prepare('SELECT * FROM blocker_signatures WHERE service = ? ORDER BY service, where_seen').all(service)
    : db.prepare('SELECT * FROM blocker_signatures ORDER BY service, where_seen').all();
}

function insertBlockerSignature(db, s) {
  assertAuthorized('insertBlockerSignature');
  db.prepare(
    `INSERT INTO blocker_signatures (service, where_seen, pattern, flags, blocking_weight, source, notes, created_at)
     VALUES (?,?,?,?,?, 'user', ?, ?)
     ON CONFLICT(service, where_seen, pattern) DO UPDATE SET
       flags = excluded.flags, blocking_weight = excluded.blocking_weight, notes = excluded.notes`
  ).run(
    s.service,
    s.where_seen,
    s.pattern,
    s.flags ?? null,
    s.blocking_weight ?? 1,
    s.notes ?? null,
    new Date().toISOString()
  );
}

function deleteBlockerSignature(db, id) {
  assertAuthorized('deleteBlockerSignature');
  // Only user rows: deleting a builtin would silently come back on the next
  // open, and a change that reverts later is worse than one refused now.
  const row = db.prepare('SELECT source FROM blocker_signatures WHERE id = ?').get(id);
  if (!row) return { deleted: false, reason: 'no such signature' };
  if (row.source === 'builtin') {
    return { deleted: false, reason: 'that signature is a builtin, owned by lib/blockerSignatures.js and re-seeded on every open — edit that file instead' };
  }
  db.prepare('DELETE FROM blocker_signatures WHERE id = ?').run(id);
  return { deleted: true };
}

// Compare-before-write, like the other seeds: openFailuresDb() runs in every
// process, so an unconditional upsert would make every reader a writer.
function seedProbeKnowledge(db) {
  const existing = new Set(
    db.prepare("SELECT probe_kind || '|' || category || '|' || value AS k FROM probe_knowledge WHERE source = 'builtin'").all().map(r => r.k)
  );
  const stale = PROBE_KNOWLEDGE.filter(([kind, cat, , value]) => !existing.has(`${kind}|${cat}|${value}`));
  if (!stale.length) return;
  const now = new Date().toISOString();
  const insert = db.prepare(
    `INSERT INTO probe_knowledge (probe_kind, category, value_kind, value, source, created_at)
     VALUES (?,?,?,?, 'builtin', ?)
     ON CONFLICT(probe_kind, category, value) DO NOTHING`
  );
  for (const [kind, cat, valueKind, value] of stale) insert.run(kind, cat, valueKind, value, now);
}

function listProbeKnowledge(db, { probeKind, category } = {}) {
  const where = [];
  const args = [];
  if (probeKind) {
    where.push('probe_kind = ?');
    args.push(probeKind);
  }
  if (category) {
    where.push('category = ?');
    args.push(category);
  }
  return db
    .prepare(`SELECT * FROM probe_knowledge ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY probe_kind, category, id`)
    .all(...args);
}

function insertProbeKnowledge(db, k) {
  assertAuthorized('insertProbeKnowledge');
  db.prepare(
    `INSERT INTO probe_knowledge (probe_kind, category, value_kind, value, source, notes, created_at)
     VALUES (?,?,?,?, 'user', ?, ?)
     ON CONFLICT(probe_kind, category, value) DO UPDATE SET notes = excluded.notes`
  ).run(k.probe_kind, k.category, k.value_kind ?? 'pattern', k.value, k.notes ?? null, new Date().toISOString());
}

function openFailuresDb() {
  fs.mkdirSync(path.dirname(FAILURES_DB_PATH), { recursive: true });
  const db = new DatabaseSync(FAILURES_DB_PATH);
  applyConcurrencyPragmas(db);
  db.exec(SCHEMA);
  authorize('failuresDb.js seeding from code', () => {
    seedFailureTypes(db);
    seedBlockerSignatures(db);
    seedProbeKnowledge(db);
  });
  return db;
}

function listFailureTypes(db) {
  return db.prepare('SELECT name, description FROM failure_types ORDER BY name').all();
}

function getFailureType(db, name) {
  return db.prepare('SELECT * FROM failure_types WHERE name = ?').get(name);
}

function insertFailureType(db, name, description) {
  assertAuthorized('insertFailureType');
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
  assertAuthorized('recordFailure');
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
  assertAuthorized('deleteFailure');
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
  listBlockerSignatures,
  insertBlockerSignature,
  deleteBlockerSignature,
  WALL_SERVICES,
  listProbeKnowledge,
  insertProbeKnowledge,
};
