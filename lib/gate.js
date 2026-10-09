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
//
// `--verbose` on purpose. test.sh's DEFAULT output is filtered down to failures
// plus the counts, because that output is read by a model and 279 lines of
// "ok 143 - ..." is 279 lines of nothing happening. The gate is a machine and
// wants the whole stream: it parses this to decide whether a change broke the
// suite, and a reader-facing filter must never be able to influence that.
// Asking for the unfiltered stream means the two cannot interact at all --
// there is no shared format to keep in step and nothing to get wrong later.
function unitTests() {
  try {
    const out = execFileSync(path.join(__dirname, '..', 'test.sh'), ['--verbose'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return parseTap(out);
  } catch (e) {
    return parseTap(`${e.stdout || ''}${e.stderr || ''}`);
  }
}

// `failed` is the larger of node's `# fail` and the top-level `not ok` lines:
// test.sh appends a `not ok 0` of its own when the live store changed during
// the run, after node has already printed `# fail 0`.
//
// `failureDetails` keeps WHY each test failed -- its error text and file:line --
// because a gate that said only "test X failed" left a flake under load
// undiagnosable: the same test passed on a standalone rerun and the evidence
// was gone (TODO, "Gate flakes under load"). Any depth (subtests indent);
// node's "N subtests failed" wrappers are skipped, their children carry it.
const DETAIL_MAX = 500;
function failureDetailsOf(out) {
  const lines = String(out).split('\n');
  const details = [];
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].match(/^(\s*)not ok \d+ - (.+)$/);
    if (!head) continue;
    let error = null;
    let location = null;
    let wrapper = false;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (/^\s*\.\.\.\s*$/.test(l) || /^\s*(not )?ok \d+ - /.test(l)) break;
      const loc = l.match(/^\s*location:\s*'?(.*?)'?\s*$/);
      if (loc) location = loc[1];
      if (/^\s*failureType:\s*'subtestsFailed'/.test(l)) wrapper = true;
      const err = l.match(/^(\s*)error:\s*(.*)$/);
      if (err) {
        if (/^[|>][-+]?$/.test(err[2])) {
          const indent = err[1].length;
          const body = [];
          for (let k = j + 1; k < lines.length; k++) {
            const m = lines[k].match(/^(\s*)(.*)$/);
            if (lines[k].trim() && m[1].length <= indent) break;
            body.push(lines[k].trim());
          }
          error = body.join('\n').trim();
        } else {
          error = err[2].replace(/^'(.*)'$/, '$1');
        }
      }
    }
    if (wrapper) continue;
    details.push({
      name: head[2],
      error: error && error.length > DETAIL_MAX ? error.slice(0, DETAIL_MAX) + '...' : error,
      location,
    });
  }
  return details;
}

function parseTap(out) {
  const pass = Number((out.match(/^# pass (\d+)/m) || [])[1] ?? 0);
  const fail = Number((out.match(/^# fail (\d+)/m) || [])[1] ?? 0);
  const failures = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map(m => m[1]);
  return { passed: pass, failed: Math.max(fail, failures.length), failures, failureDetails: failureDetailsOf(out) };
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

// What DEPENDS on a generic action — the other actions and the recipes that
// reference it, directly or through another action.
//
// This is the direction that matters most when editing a shared action:
// dismiss_overlay is referenced by six recipes and by open_apply_form, so a
// change to it is really a change to all of them. Validating only what the
// action itself references would check the safe direction and miss the one
// where the damage spreads.
function dependentsOf(db, actionName) {
  const { listGenericActions, getGenericAction, listSites, getSite } = require('../db');

  const mentions = (stepsJson, name) => {
    try {
      const found = referencedActions(JSON.parse(stepsJson || '[]'));
      return found.generic.includes(name);
    } catch {
      return false;
    }
  };

  // Transitive: an action referencing an action that references the changed
  // one is affected just as much.
  const actions = new Set();
  let frontier = [actionName];
  while (frontier.length) {
    const next = [];
    for (const g of listGenericActions(db)) {
      if (actions.has(g.name) || g.name === actionName) continue;
      const row = getGenericAction(db, g.name);
      if (frontier.some(n => mentions(row.steps, n))) {
        actions.add(g.name);
        next.push(g.name);
      }
    }
    frontier = next;
  }

  const all = [actionName, ...actions];
  const recipes = [];
  for (const s of listSites(db)) {
    const site = getSite(db, s.hostname, s.page_type, s.recipe_name);
    if (site.nav_method !== 'ui_steps') continue;
    if (all.some(n => mentions(site.nav_template, n))) {
      recipes.push(`${s.hostname}#${s.page_type}:${s.recipe_name}`);
    }
  }
  return { actions: [...actions], recipes };
}

// Validates a generic action as a unit: its own steps, and the subactions it
// pulls in. `steps` may be passed directly so a CANDIDATE version can be
// checked before it is written.
function validateGenericAction(db, name, steps) {
  const findings = [];
  const { PROBE_KINDS } = require('./probes');
  const engineSrc = require('fs').readFileSync(path.join(__dirname, '..', 'engine.js'), 'utf8');
  const implemented = new Set([...engineSrc.matchAll(/case '([A-Za-z_]+)':/g)].map(m => m[1]));

  let parsed;
  try {
    parsed = typeof steps === 'string' ? JSON.parse(steps) : steps;
  } catch (e) {
    return [`error|generic:${name}|steps are not valid JSON: ${e.message}`];
  }
  if (!Array.isArray(parsed)) return [`error|generic:${name}|steps must be an array`];

  const walkOwn = list => {
    for (const s of list) {
      if (!s.action) {
        findings.push(`error|generic:${name}|a step has no action, so the engine falls through and does nothing`);
        continue;
      }
      if (!implemented.has(s.action) && !['run_action', 'run_generic_action'].includes(s.action)) {
        findings.push(`error|generic:${name}|step type "${s.action}" is not implemented by engine.js`);
      }
      if (s.action === 'probe' && s.kind && !PROBE_KINDS[s.kind]) {
        findings.push(`error|generic:${name}|probe kind "${s.kind}" is not registered`);
      }
      if (Array.isArray(s.steps)) walkOwn(s.steps);
    }
  };
  walkOwn(parsed);

  // Subactions: everything this action pulls in, validated the same way a
  // recipe's references are. A self-reference shows up here as a cycle.
  const subs = referencedActions(parsed);
  if (subs.generic.includes(name)) {
    findings.push(`error|generic:${name}|references itself, which would expand forever`);
  } else {
    findings.push(...validateReferencedActions(db, subs, 'gate.local'));
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

// Through test.sh, like unitTests(), not `node --test` directly: test.sh is
// what points the run at a snapshot of the stores (SS_DB), so the scoped tests
// a recipe change triggers cannot write the live store either (TODO 0k).
function runTestFiles(files) {
  if (!files.length) return { passed: 0, failed: 0, failures: [], failureDetails: [], files: [] };
  try {
    const out = execFileSync(path.join(__dirname, '..', 'test.sh'), ['--verbose', ...files], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return { ...parseTap(out), files: files.map(f => path.basename(f)) };
  } catch (e) {
    return { ...parseTap(`${e.stdout || ''}${e.stderr || ''}`), files: files.map(f => path.basename(f)) };
  }
}

/**
 * Applies a mutation behind the gate.
 *
 * @param db            open recipe DB handle (db.js openDb)
 * @param opts.target   "hostname#page_type:recipe_name", or a filename for code
 * @param opts.summary  what this change is for — recorded, so history is readable
 * @param opts.scope    'recipe' | 'status' | 'failures' | 'code'
 * @param opts.mutate   () => any — performs the change; its return value is passed through
 * @param opts.siteId   when known, enables snapshot/rollback of the recipe
 * @param opts.runTests force the unit suite on or off; defaults to on for 'code'
 * @param opts.snapshot () => any — captures state for scopes with no version
 *                      history (a generic action is a single row, not a
 *                      versioned definition), so a regression can still be undone
 * @param opts.restore  (snap) => void — puts that state back
 * @param opts.extraFindings () => string[] — scope-specific checks folded into
 *                      the before/after comparison
 * @param opts.extraTestFiles () => string[] — suites this change should run
 */
// Which findings in `after` did this change introduce? Findings are
// `severity|unit|problem` strings. Compared on `unit|problem`, a finding counts
// only if it is new or its severity got WORSE: comparing whole strings meant an
// `error` downgraded to `warn` read as a new finding and the change was rolled
// back for making things better (TODO section 0). A string whose first field
// is not a known severity is compared whole -- an unknown shape is flagged
// rather than guessed at. test/guard.test.js.
const SEVERITY_RANK = { ok: 0, info: 1, warn: 2, error: 3 };
function splitFinding(f) {
  const i = typeof f === 'string' ? f.indexOf('|') : -1;
  const sev = i > 0 ? f.slice(0, i) : null;
  return sev in SEVERITY_RANK ? { rank: SEVERITY_RANK[sev], key: f.slice(i + 1) } : null;
}
function introducedFindings(before, after) {
  const worstBefore = new Map();
  const exactBefore = new Set(before);
  for (const f of before) {
    const p = splitFinding(f);
    if (p && !(worstBefore.get(p.key) >= p.rank)) worstBefore.set(p.key, p.rank);
  }
  return after.filter(f => {
    const p = splitFinding(f);
    if (!p) return !exactBefore.has(f);
    return !worstBefore.has(p.key) || p.rank > worstBefore.get(p.key);
  });
}

function guardedChange(db, { target, summary, scope, mutate, siteId, runTests, snapshot, restore, extraFindings, extraTestFiles }) {
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
    ...(extraFindings ? extraFindings() : []),
  ].filter((f, i, all) => all.indexOf(f) === i);
  const snap = snapshot ? snapshot() : null;
  const beforeVersion = siteId ? getCurrentVersion(db, siteId) : null;
  const beforeLabel = beforeVersion ? `v${beforeVersion.major}.${beforeVersion.minor}` : null;

  const shouldTest = runTests ?? scope === 'code';
  const testsBefore = shouldTest ? unitTests() : null;
  if (testsBefore && testsBefore.failed > 0) {
    // Refusing here is the point: applying a change on top of an already-broken
    // suite makes it impossible to attribute the next failure.
    throw new Error(
      `${testsBefore.failed} test(s) are ALREADY failing before this change — fix those first, ` +
        `or attribution is impossible: ` +
        testsBefore.failureDetails
          .slice(0, 3)
          .map(d => `${d.name}${d.location ? ` (${d.location})` : ''}${d.error ? `: ${d.error.slice(0, 200)}` : ''}`)
          .join('; ')
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
    ...(extraFindings ? extraFindings() : []),
  ].filter((f, i, all) => all.indexOf(f) === i);

  // Tests that exercise the actions this recipe now pulls in. A recipe that
  // references dismiss_overlay depends on that action's behaviour, so the
  // suites covering it are part of validating the change.
  const scopedFiles = new Set([
    ...(refsAfter.generic.length || refsAfter.site.length ? testFilesFor(refsAfter) : []),
    ...(extraTestFiles ? extraTestFiles() : []),
  ]);
  const actionTests = scopedFiles.size ? runTestFiles([...scopedFiles]) : null;

  const introduced = introducedFindings(before, after);

  const testsAfter = shouldTest ? unitTests() : null;
  const brokeTests = (testsAfter ? testsAfter.failed > 0 : false) || (actionTests ? actionTests.failed > 0 : false);

  let rolledBack = false;
  let rollbackNote = null;
  if (introduced.length || brokeTests) {
    if (siteId && beforeVersion) {
      authorize(`gate rollback: ${summary}`, () => restoreVersion(db, siteId, beforeVersion.major, beforeVersion.minor));
      rolledBack = true;
      rollbackNote = `rolled back to ${beforeLabel}`;
    } else if (restore && snap !== null) {
      authorize(`gate rollback: ${summary}`, () => restore(snap));
      rolledBack = true;
      rollbackNote = 'restored the previous state';
    } else {
      rollbackNote = 'NOT rolled back automatically — this scope has no snapshot, so the change is still applied and must be reverted by hand';
    }
  }

  const afterVersion = siteId ? getCurrentVersion(db, siteId) : null;
  if (afterVersion) versionsCreated.add(`v${afterVersion.major}.${afterVersion.minor}`);
  // Written under authorization like any other guarded write: `audit.js
  // provenance` trusts this ledger to tell sanctioned edits from off-path ones,
  // so a row anyone could forge would defeat the audit rather than trip it.
  authorize(`gate ledger: ${summary}`, () =>
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
  ));

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
    tests: testsAfter
      ? { passed: testsAfter.passed, failed: testsAfter.failed, failures: testsAfter.failures, failureDetails: testsAfter.failureDetails }
      : null,
    referencedActions: refsAfter,
    actionTests,
    rolledBack,
    rollbackNote,
  };
}

module.exports = {
  guardedChange,
  introducedFindings,
  offlineFindings,
  unitTests,
  ensureChangeLog,
  CHANGE_LOG_TABLE_SQL,
  referencedActions,
  validateReferencedActions,
  testFilesFor,
  runTestFiles,
  dependentsOf,
  validateGenericAction,
  // Exported so a test can prove the gate still detects a real failure. The
  // gate reads test.sh --verbose while a human or model reads the filtered
  // default, so the two are independent by construction -- the test asserts
  // failures are caught in BOTH, since a gate that silently reports zero
  // failures would wave a broken change through.
  parseTap,
};
