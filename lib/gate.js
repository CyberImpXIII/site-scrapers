// The validation gate every sanctioned mutation passes through.
//
// Why this exists: there were several write paths (register.js, lab.js set,
// verify.js) and one unsanctioned one that got used constantly — inline
// `node -e` with raw `db.prepare('UPDATE ...')`. That path skipped every check.
// It is how a recipe got status "blocked" by hand before any gate existed, how
// a status was set that register.js would have refused, and how edits landed
// with no audit run against them. A rule enforced on three of four paths is not
// enforced.
//
// What a gated change does, in order:
//   1. PRE  — run the offline audits and record the findings that already exist
//   2. SNAPSHOT — capture the recipe definition so a regression can be undone
//   3. APPLY — run the caller's mutation
//   4. POST — re-run the same audits
//   5. COMPARE — a finding that did NOT exist before is a regression caused by
//      this change. Roll back and report it rather than leaving it in.
//   6. LOG — record the change, so an edit made OFF this path is detectable by
//      its absence (see `audit.js provenance`).
//
// Pre-existing findings are deliberately not blocking: the library always has
// some open warnings, and refusing every change until they are all cleared
// would make the gate something to work around. Only NEW findings block.

const { execFileSync } = require('node:child_process');
const { authorize } = require('./writeGuard');
const path = require('path');

const CHANGE_LOG_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS change_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target TEXT,                  -- "hostname#page_type:recipe_name", or a filename for code
  summary TEXT NOT NULL,        -- what the change was meant to do
  scope TEXT NOT NULL,          -- 'recipe' | 'status' | 'failures' | 'code'
  version_before TEXT,          -- recipe version label before the change
  version_after TEXT,
  audits_run TEXT,              -- which checks gated it
  versions_created TEXT,        -- EVERY version label this change produced, including one it
                                -- then rejected and rolled back. Without all of them, the
                                -- rejected intermediate looks like an off-path edit to
                                -- "audit.js provenance" -- which is the gate accusing itself.
  findings_before INTEGER,
  findings_after INTEGER,
  rolled_back INTEGER NOT NULL DEFAULT 0,
  changed_at TEXT NOT NULL
);
`;

function ensureChangeLog(db) {
  db.exec(CHANGE_LOG_TABLE_SQL);
}

// Runs the offline audits and returns their findings as a comparable set.
// Offline only: these are instant and have no network dependency, so gating
// every write on them costs nothing. The live audits (params, working,
// fixed-params) take minutes and are the caller's job to run deliberately.
function offlineFindings() {
  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'audit.js'), 'units'], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    const parsed = JSON.parse(out);
    return (parsed.unitInvariants || []).map(f => `${f.severity}|${f.unit}|${f.problem}`);
  } catch (e) {
    // A gate that cannot run its checks must fail loudly rather than wave the
    // change through — silently skipping validation is the failure this whole
    // mechanism exists to prevent.
    throw new Error(`gate could not run the offline audits: ${(e.stderr || e.message || '').slice(0, 300)}`);
  }
}

// Runs the unit test suite. Used for `scope: 'code'`, where a change can break
// behaviour that no audit inspects. Returns { passed, failed, failures }.
function unitTests() {
  try {
    const out = execFileSync(path.join(__dirname, '..', 'test.sh'), [], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return parseTap(out);
  } catch (e) {
    return parseTap(`${e.stdout || ''}${e.stderr || ''}`);
  }
}

function parseTap(out) {
  const pass = Number((out.match(/^# pass (\d+)/m) || [])[1] ?? 0);
  const fail = Number((out.match(/^# fail (\d+)/m) || [])[1] ?? 0);
  const failures = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map(m => m[1]);
  return { passed: pass, failed: fail, failures };
}

/**
 * Applies a mutation behind the gate.
 *
 * @param db            open scrapers.db handle
 * @param opts.target   "hostname#page_type:recipe_name", or a filename for code
 * @param opts.summary  what this change is for — recorded, so history is readable
 * @param opts.scope    'recipe' | 'status' | 'failures' | 'code'
 * @param opts.mutate   () => any — performs the change; its return value is passed through
 * @param opts.siteId   when known, enables snapshot/rollback of the recipe
 * @param opts.runTests force the unit suite on or off; defaults to on for 'code'
 */
function guardedChange(db, { target, summary, scope, mutate, siteId, runTests }) {
  if (!summary) throw new Error('a guarded change needs a summary — an unexplained edit is what this gate exists to stop');
  ensureChangeLog(db);
  const { getCurrentVersion, restoreVersion } = require('../db');

  const before = offlineFindings();
  const beforeVersion = siteId ? getCurrentVersion(db, siteId) : null;
  const beforeLabel = beforeVersion ? `v${beforeVersion.major}.${beforeVersion.minor}` : null;

  const shouldTest = runTests ?? scope === 'code';
  const testsBefore = shouldTest ? unitTests() : null;
  if (testsBefore && testsBefore.failed > 0) {
    // Refusing here is the point: applying a change on top of an already-broken
    // suite makes it impossible to attribute the next failure.
    throw new Error(
      `${testsBefore.failed} test(s) are ALREADY failing before this change — fix those first, ` +
        `or attribution is impossible: ${testsBefore.failures.slice(0, 3).join('; ')}`
    );
  }

  const result = authorize(`gated change: ${summary}`, mutate);

  // Captured before any rollback: if the change is rejected this version is
  // still a real row in recipe_versions and has to be accounted for.
  const appliedVersion = siteId ? getCurrentVersion(db, siteId) : null;
  const versionsCreated = new Set();
  if (appliedVersion) versionsCreated.add(`v${appliedVersion.major}.${appliedVersion.minor}`);

  const after = offlineFindings();
  const beforeSet = new Set(before);
  const introduced = after.filter(f => !beforeSet.has(f));

  const testsAfter = shouldTest ? unitTests() : null;
  const brokeTests = testsAfter ? testsAfter.failed > 0 : false;

  let rolledBack = false;
  let rollbackNote = null;
  if (introduced.length || brokeTests) {
    if (siteId && beforeVersion) {
      authorize(`gate rollback: ${summary}`, () => restoreVersion(db, siteId, beforeVersion.major, beforeVersion.minor));
      rolledBack = true;
      rollbackNote = `rolled back to ${beforeLabel}`;
    } else {
      rollbackNote = 'NOT rolled back automatically — this scope has no snapshot, so the change is still applied and must be reverted by hand';
    }
  }

  const afterVersion = siteId ? getCurrentVersion(db, siteId) : null;
  if (afterVersion) versionsCreated.add(`v${afterVersion.major}.${afterVersion.minor}`);
  db.prepare(
    `INSERT INTO change_log (target, summary, scope, version_before, version_after, audits_run,
       versions_created, findings_before, findings_after, rolled_back, changed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    target ?? null,
    summary,
    scope,
    beforeLabel,
    afterVersion ? `v${afterVersion.major}.${afterVersion.minor}` : null,
    shouldTest ? 'units,tests' : 'units',
    [...versionsCreated].join(','),
    before.length,
    after.length,
    rolledBack ? 1 : 0,
    new Date().toISOString()
  );

  return {
    ok: introduced.length === 0 && !brokeTests,
    result,
    target,
    summary,
    versionBefore: beforeLabel,
    versionAfter: afterVersion ? `v${afterVersion.major}.${afterVersion.minor}` : null,
    findingsBefore: before.length,
    findingsAfter: after.length,
    introducedFindings: introduced,
    tests: testsAfter ? { passed: testsAfter.passed, failed: testsAfter.failed, failures: testsAfter.failures } : null,
    rolledBack,
    rollbackNote,
  };
}

module.exports = { guardedChange, offlineFindings, unitTests, ensureChangeLog, CHANGE_LOG_TABLE_SQL };
