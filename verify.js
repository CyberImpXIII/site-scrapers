#!/usr/bin/env node
// Earns a recipe its `working` status by actually running it.
//
// `status` used to be whatever the author typed. That is an assertion, and
// assertions drift: a parallel run of three agents registered 16 recipes as
// "working", four of which returned nothing at all — one with notes that
// literally read "SCAFFOLD v0: exploratory first guess". Nothing checked.
//
// So `working` is no longer something you can declare. register.js refuses
// it unless the recipe's CURRENT definition already has a passing run on
// record, and this is the only thing that produces one:
//
//   node verify.js <hostname>[#page_type[:recipe_name]] '<json params>'
//
// It runs the recipe with `allowUnverified` (the engine otherwise refuses to
// run anything not already blessed — without that escape hatch the gate
// would be a deadlock), then sets status from what actually happened:
//
//   real records extracted        -> working
//   ran, but produced nothing     -> broken, with the debugDir to read
//
// Verification is per-DEFINITION, not per-recipe. Edit a working recipe and
// it needs re-verifying, because the thing that passed no longer exists.
// Promoting does not invalidate it: promoteVersion copies the definition
// unchanged, so a blessed vN.0 inherits its predecessor's passing run.
//
// A `--dry` flag reports what verification WOULD conclude without writing
// the status, for checking a recipe you do not want to re-bless yet.

// node:sqlite emits an ExperimentalWarning on every run, which lands on
// stderr and makes this tool's output awkward to pipe into jq. Real warnings
// are not expected here and would be noise in a machine-read stream.
process.removeAllListeners('warning');


const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const path = require('path');
const {
  openDb,
  getSite,
  parseSiteArg,
  getCurrentVersion,
  snapshotVersionIfChanged,
  definitionHasPassingRun,
} = require('./db');

const REPO_ROOT = __dirname;

function out(o) {
  console.log(JSON.stringify(o, null, 2));
}

async function main() {
  const [, , target, paramsArg, ...flags] = process.argv;
  const dry = flags.includes('--dry') || paramsArg === '--dry';
  if (!target) {
    out({
      success: false,
      error: "Usage: node verify.js <hostname>[#page_type[:recipe_name]] '<json params>' [--dry]",
    });
    process.exit(1);
  }

  const db = openDb();
  const { hostname, pageType, recipeName } = parseSiteArg(target);
  const site = getSite(db, hostname, pageType, recipeName);
  if (!site) {
    out({ success: false, documented: false, error: `No recipe for "${hostname}#${pageType}:${recipeName}"` });
    process.exit(1);
  }

  let params = {};
  if (paramsArg && paramsArg !== '--dry') {
    try {
      params = JSON.parse(paramsArg);
    } catch (e) {
      out({ success: false, error: `params is not valid JSON: ${e.message}` });
      process.exit(1);
    }
  }

  const before = getCurrentVersion(db, site.id);
  const beforeLabel = before ? `v${before.major}.${before.minor}` : null;

  // allowUnverified is the whole point: a candidate has to be runnable in
  // order to earn its status.
  const runParams = JSON.stringify({ ...params, allowUnverified: true });
  let result;
  try {
    const { stdout } = await execFileAsync(process.execPath, [path.join(REPO_ROOT, 'engine.js'), target, runParams], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    result = JSON.parse(stdout);
  } catch (e) {
    // engine.js exits 1 on success:false; its stdout is still the real JSON.
    try {
      result = JSON.parse(e.stdout);
    } catch {
      out({ success: false, error: `engine.js produced no parseable output: ${(e.stderr || e.message || '').slice(0, 400)}` });
      process.exit(1);
    }
  }

  // "Did it work" means records came back, not merely that nothing threw. A
  // timed-out run that still extracted everything counts — that is what
  // partialResults exists to say.
  const count = result.count ?? (result.article ? 1 : 0);
  const extracted = count > 0;

  // Zero records is ambiguous, and treating it as failure demoted a
  // genuinely working recipe: nodesk.co with {"search":"qa"} returned
  // nothing because the site had no matches for that keyword, so the cards
  // never rendered and the wait expired. A query with no results says
  // nothing about the recipe.
  //
  // So a previously-verified definition is never demoted by an empty run —
  // that verdict is "inconclusive", and the caller is told to retry with a
  // query known to have matches. Only a definition that has NEVER produced
  // records gets called broken, because then there is no evidence either way
  // and the cautious reading is the correct one.
  const alreadyProven = definitionHasPassingRun(db, site.id);
  const verdict = extracted ? 'working' : alreadyProven ? 'inconclusive' : 'broken';

  const report = {
    target,
    verdict,
    dryRun: dry,
    version: beforeLabel,
    recordsExtracted: count,
    engineSuccess: result.success,
    timedOut: result.timedOut ?? null,
    partialResults: result.partialResults ?? false,
    consistencyWarning: result.consistencyWarning ?? null,
    error: result.error ?? null,
    failedStep: result.failedStep ?? null,
    failureContext: result.failureContext ?? null,
    debugDir: result.debugDir ?? null,
    previousStatus: site.status,
  };

  if (dry) {
    out({ ...report, note: 'Dry run — status not changed.' });
    process.exit(extracted ? 0 : 1);
  }

  if (verdict === 'inconclusive') {
    out({
      ...report,
      newStatus: site.status,
      definitionHasPassingRun: true,
      note:
        'Inconclusive, status unchanged. This definition has already produced records, and an empty run most often means the ' +
        'query simply had no matches — re-run with params known to return results. If you believe the recipe really is broken, ' +
        'check debugDir: diagnostics.json says whether the page was a wall or just empty.',
    });
    process.exit(0);
  }

  if (site.status !== verdict) {
    db.prepare('UPDATE sites SET status = ?, last_verified = ? WHERE id = ?').run(verdict, new Date().toISOString(), site.id);
    // status is a versioned column, so a change to it is a change to the
    // recipe and gets its own snapshot.
    snapshotVersionIfChanged(db, site.id, { note: `status set to "${verdict}" by verify.js` });
  }

  const after = getCurrentVersion(db, site.id);
  out({
    ...report,
    newStatus: verdict,
    version: after ? `v${after.major}.${after.minor}` : beforeLabel,
    definitionHasPassingRun: definitionHasPassingRun(db, site.id),
    note: extracted
      ? `Verified: ${count} records extracted. register.js will now accept "status":"working" for this definition.`
      : 'Not verified. Read debugDir (diagnostics.json has the blocker and card-structure probes) before editing the recipe.',
  });
  process.exit(extracted ? 0 : 1);
}

main();
