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

// Which reusable actions a step list pulls in, at any depth. A recipe that
// references dismiss_overlay is not self-contained: most of what it actually
// runs lives in that action, so a change to the recipe has to be validated
// against it too.
function referencedActions(steps) {
  const generic = new Set();
  const site = new Set();
  const walk = list => {
    for (const s of Array.isArray(list) ? list : []) {
      if (s.action === 'run_generic_action' && s.ref) generic.add(s.ref);
      if (s.action === 'run_action' && s.ref) site.add(s.ref);
      if (Array.isArray(s.steps)) walk(s.steps);
    }
  };
  walk(steps);
  return { generic: [...generic], site: [...site] };
}

// Reads a recipe's own step list, tolerating a recipe that has none.
function stepsOf(site) {
  if (!site || site.nav_method !== 'ui_steps' || !site.nav_template) return [];
  try {
    return JSON.parse(site.nav_template);
  } catch {
    return [];
  }
}

// Checks the referenced actions themselves: that each resolves, that expansion
// succeeds (which is what catches a dangling ref or a cycle), and that what it
// expands to is runnable — no step type the engine does not implement, no probe
// kind that is not registered. A recipe can be perfectly well-formed and still
// be broken entirely inside an action it references.
function validateReferencedActions(db, refs, callerHostname) {
  const findings = [];
  if (!refs.generic.length && !refs.site.length) return findings;

  const { expandSteps, refKey } = require('./composeActions');
  const { getGenericAction } = require('../db');
  const { PROBE_KINDS } = require('./probes');

  const engineSrc = require('fs').readFileSync(path.join(__dirname, '..', 'engine.js'), 'utf8');
  const implemented = new Set([...engineSrc.matchAll(/case '([A-Za-z_]+)':/g)].map(m => m[1]));

  for (const name of refs.generic) {
    const row = getGenericAction(db, name);
    if (!row) {
      findings.push(`error|generic:${name}|referenced but does not exist — the run would fail before opening a browser`);
      continue;
    }
    let expanded;
    try {
      expanded = expandSteps(db, [{ action: 'run_generic_action', ref: name }], callerHostname || 'gate.local', new Set());
    } catch (e) {
      findings.push(`error|generic:${name}|does not expand: ${e.message}`);
      continue;
    }
    const walk = list => {
      for (const s of list) {
        if (s.action && !implemented.has(s.action) && !['run_action', 'run_generic_action'].includes(s.action)) {
          findings.push(`error|generic:${name}|expands to step type "${s.action}", which engine.js does not implement`);
        }
        if (s.action === 'probe' && s.kind && !PROBE_KINDS[s.kind]) {
          findings.push(`error|generic:${name}|expands to probe kind "${s.kind}", which is not registered`);
        }
        if (Array.isArray(s.steps)) walk(s.steps);
      }
    };
    walk(expanded);
  }

  for (const ref of refs.site) {
    try {
      expandSteps(db, [{ action: 'run_action', ref }], callerHostname || 'gate.local', new Set());
    } catch (e) {
      findings.push(`error|action:${ref}|does not expand: ${e.message}`);
    }
  }
  return findings;
}

// The test files that actually exercise the referenced actions, found by
// looking for their names rather than from a hand-maintained map — a map would
// drift the moment a test was renamed, and then this would quietly run nothing.
// The composition and seeding suites always apply, because they cover the
// machinery every reference depends on.
const ALWAYS_RELEVANT = ['compose.test.js', 'builtins.test.js'];
function testFilesFor(refs) {
  const dir = path.join(__dirname, '..', 'test');
  const fs = require('fs');
  const names = [...refs.generic, ...refs.site];
  const files = new Set(ALWAYS_RELEVANT.map(f => path.join(dir, f)).filter(f => fs.existsSync(f)));
  if (!names.length) return [...files];
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.test.js'))) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    if (names.some(n => src.includes(n))) files.add(path.join(dir, file));
  }
  return [...files];
}

function runTestFiles(files) {
  if (!files.length) return { passed: 0, failed: 0, failures: [], files: [] };
  const NODE_BIN = `${process.env.HOME}/.nvm/versions/node/v22.20.0/bin/node`;
  const bin = require('fs').existsSync(NODE_BIN) ? NODE_BIN : process.execPath;
  try {
    const out = execFileSync(bin, ['--test', ...files], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return { ...parseTap(out), files: files.map(f => path.basename(f)) };
  } catch (e) {
    return { ...parseTap(`${e.stdout || ''}${e.stderr || ''}`), files: files.map(f => path.basename(f)) };
  }
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

  const { getSite } = require('../db');
  const siteRow = siteId ? db.prepare('SELECT * FROM sites WHERE id = ?').get(siteId) : null;
  const refsBefore = referencedActions(stepsOf(siteRow));

  // Referenced actions are part of the change's scope on BOTH sides: a change
  // can break a recipe by pointing it at a broken action, and it can also stop
  // referencing one that was already broken, which should not be reported as
  // this change's fault.
  const before = [
    ...offlineFindings(),
    ...validateReferencedActions(db, refsBefore, siteRow?.hostname),
  ];
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

  const siteAfter = siteId ? db.prepare('SELECT * FROM sites WHERE id = ?').get(siteId) : null;
  const refsAfter = referencedActions(stepsOf(siteAfter));
  const after = [
    ...offlineFindings(),
    ...validateReferencedActions(db, refsAfter, siteAfter?.hostname),
  ];

  // Tests that exercise the actions this recipe now pulls in. A recipe that
  // references dismiss_overlay depends on that action's behaviour, so the
  // suites covering it are part of validating the change.
  const actionTests = refsAfter.generic.length || refsAfter.site.length ? runTestFiles(testFilesFor(refsAfter)) : null;

  const beforeSet = new Set(before);
  const introduced = after.filter(f => !beforeSet.has(f));

  const testsAfter = shouldTest ? unitTests() : null;
  const brokeTests = (testsAfter ? testsAfter.failed > 0 : false) || (actionTests ? actionTests.failed > 0 : false);

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
    referencedActions: refsAfter,
    actionTests,
    rolledBack,
    rollbackNote,
  };
}

module.exports = {
  guardedChange,
  offlineFindings,
  unitTests,
  ensureChangeLog,
  CHANGE_LOG_TABLE_SQL,
  referencedActions,
  validateReferencedActions,
  testFilesFor,
  runTestFiles,
};
