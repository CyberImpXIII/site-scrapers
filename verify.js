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
// What counts as a record depends on the recipe: a fill_form run counts the
// answers that landed (lib/fillContract.js), a describe_form recipe the fields
// it described (lib/describeVerdict.js), anything else its records/article.
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
const { decideVerdict } = require('./lib/verdict');
const { verdictInputsFromFill } = require('./lib/fillContract');
const { verdictInputsFromDescribe } = require('./lib/describeVerdict');
const { authorizeAsync } = require('./lib/writeGuard');
const { isBlockedRefusal } = require('./lib/blockedGuard');

const REPO_ROOT = __dirname;

function out(o) {
  console.log(JSON.stringify(o, null, 2));
}

async function main() {
  const [, , target, paramsArg, ...flags] = process.argv;
  const dry = flags.includes('--dry') || paramsArg === '--dry';
  const attended = flags.includes('--attended') || paramsArg === '--attended';
  if (!target) {
    out({
      success: false,
      error: "Usage: node verify.js <hostname>[#page_type[:recipe_name]] '<json params>' [--dry] [--attended]",
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
  if (paramsArg && !paramsArg.startsWith('--')) {
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
  const runParams = JSON.stringify({
    ...params,
    allowUnverified: true,
    ...(attended ? { attended: true } : {}),
  });
  if (attended) {
    // Printed to stderr so stdout stays a clean JSON document for jq.
    process.stderr.write(
      `Attended verification of ${target}: a browser window will open. Clear whatever is in the way ` +
        '(a challenge, a sign-in), then leave it — the run continues by itself the moment the records appear.\n'
    );
  }
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

  // A blocked-guard refusal (lib/blockedGuard.js) is not a run, so it earns
  // no status: read as "ran, produced nothing" it would demote the recipe.
  // Nothing is written; the refusal names the --attended command.
  if (isBlockedRefusal(result)) {
    out(result);
    process.exit(1);
  }

  // "Did it work" means records came back, not merely that nothing threw. A
  // timed-out run that still extracted everything counts — that is what
  // partialResults exists to say.
  // A fill_form action is judged on its fill (lib/fillContract.js): a field
  // count from a run where nothing failed. The page loading is not evidence
  // that a single answer landed, and `article` is dropped from a fill's output.
  // A describe_form action is judged on the fields it described
  // (lib/describeVerdict.js): `article` is the posting page's text whether or
  // not the form was ever reached, so it says nothing about a describe.
  const fillVerdict = verdictInputsFromFill(result.fill);
  const describeVerdict = fillVerdict ? null : verdictInputsFromDescribe(site.action_type, result.diagnostics);
  const count = fillVerdict
    ? fillVerdict.extracted
      ? result.fill.counts.filled
      : 0
    : describeVerdict
      ? describeVerdict.fields
      : result.count ?? (result.article ? 1 : 0);
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

  // A wall is not a broken recipe, and the automatic failure sweep already
  // knows the difference — read it rather than guessing. "broken" invites
  // re-deriving a recipe that may be perfectly correct behind a login.
  //
  // Note this can only ever conclude "blocked" (a property of the site), not
  // "blocked-attn" (a property of what the agent has been able to work out).
  // The latter is a judgement about being out of moves, which nothing can
  // detect automatically — it has to be set deliberately, with notes.
  // A fill reports its own wall (it checks before touching anything), and that
  // is used first: a fill that stopped at a wall exits cleanly, so there is no
  // debugDir capture to read.
  let wall = fillVerdict?.wall ?? null;
  if (!wall && !extracted && result.debugDir) {
    try {
      const probes = JSON.parse(require('fs').readFileSync(path.join(result.debugDir, 'diagnostics.json'), 'utf8'));
      // The antibot probe is authoritative: it names the service, weighs
      // whether the challenge IS the page, and catches wordings the generic
      // blockers regexes miss (Cloudflare's "Verifying you are human" does not
      // match a /verify you are human/ pattern). blockers is the fallback, for
      // walls that are not anti-bot services — a plain login page.
      const antibot = probes.find(p => p.kind === 'antibot');
      if (antibot?.blocking && antibot.detected?.length) wall = antibot.detected;
      if (!wall) {
        // The fallback list comes from the signature table's own service names
        // rather than being hardcoded here — a new wall service added at
        // runtime should count immediately, without a second place to update.
        const { WALL_SERVICES } = require('./failuresDb');
        const legacyToService = { captcha: 'captcha_widget', botCheck: 'rate_limit', loginWall: 'login_wall' };
        const blockers = probes.find(p => p.kind === 'blockers');
        const walls = (blockers?.flags ?? [])
          .map(f => legacyToService[f] ?? f)
          .filter(s => WALL_SERVICES.includes(s));
        if (walls.length) wall = walls;
      }
    } catch {
      /* no capture or unreadable — fall through to the ordinary verdict */
    }
  }

  // --attended answers the one question that decides between the two blocked
  // states, and answers it from a RUN rather than from an agent's opinion:
  // with a person present to clear whatever is in the way, does the recipe
  // complete?
  //
  //   records came back  -> a human alone was sufficient. If a wall was seen,
  //                         that is "blocked" (needs a person every run); if
  //                         none was, the recipe simply works.
  //   nothing came back  -> a human alone was NOT sufficient, so this is not
  //                         merely blocked. It stays blocked-attn: there is
  //                         real work left that the user's presence did not
  //                         resolve.
  //
  // This is the ONLY route out of blocked-attn. An agent cannot promote it by
  // asserting the recipe is fine, which is the point — entering that state is
  // cheap and cautious, leaving it has to be earned.
  // "blocked" claims a person is SUFFICIENT. Detecting a wall does not
  // establish that — the wall might need credentials nobody has, or the recipe
  // might be broken behind it too. So an unattended run that hits a wall can
  // only conclude "blocked-attn": something is in the way and whether a person
  // resolves it is still unknown. Only an attended run that actually returned
  // records can promote to "blocked".
  //
  // Getting this wrong made indeed.com "blocked" on no evidence of
  // attendability, which is exactly the discretion this is meant to remove.
  const notThePage = result.notThePage ?? null;
  const verdict = decideVerdict({ extracted, wall, attended, alreadyProven, notThePage: Boolean(notThePage) });

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
    ...(notThePage ? { notThePage } : {}),
    ...(describeVerdict ? { describe: { fields: describeVerdict.fields, url: result.url ?? null } } : {}),
    ...(result.fill
      ? {
          fill: {
            status: result.fill.status,
            error: result.fill.error ?? null,
            counts: result.fill.counts,
            formChanged: result.fill.formChanged,
            wall: result.fill.wall,
            failed: (result.fill.fields || []).filter(f => f.outcome === 'failed').map(f => `${f.selector}: ${f.reason}`),
          },
        }
      : {}),
  };

  if (dry) {
    out({ ...report, note: 'Dry run — status not changed.' });
    process.exit(extracted ? 0 : 1);
  }

  if (verdict === 'inconclusive' && notThePage) {
    out({
      ...report,
      newStatus: site.status,
      definitionHasPassingRun: alreadyProven,
      note:
        `Inconclusive, status unchanged: the run landed on ${notThePage.landed}, not a page this recipe reads ` +
        `(expect_url ${notThePage.expected}). The params most likely name something that no longer exists (a closed ` +
        'posting redirects to its board), which says nothing about the recipe. Re-run with params that name a live page.',
    });
    process.exit(0);
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
    // blocked-attn requires notes saying what the user needs to do, and when
    // this tool sets the status it has to supply them itself — otherwise it
    // would write a state that register.js would reject as unusable.
    if (verdict === 'blocked-attn') {
      const reason = wall
        ? `A wall was detected (${wall.join(', ')}) and no records came back${attended ? ' even with a person present' : ''}.`
        : 'A person being present was not enough to complete the run.';
      const next = attended
        ? 'An attended run has already been tried and did not succeed, so this needs real work, not another attempt: read debugDir/diagnostics.json.'
        : `NEXT STEP FOR THE USER: run \`node verify.js ${target} '${paramsArg && paramsArg !== '--attended' ? paramsArg : '{}'}' --attended\` and clear the wall in the window that opens. If records come back, this becomes "blocked" (needs a person each run). If not, it needs real work.`;
      const stamp = `[verify.js ${new Date().toISOString().slice(0, 10)}] ${reason} ${next}`;
      db.prepare('UPDATE sites SET notes = ? WHERE id = ?').run(
        site.notes ? `${site.notes}\n${stamp}` : stamp,
        site.id
      );
    }
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
    wallDetected: wall,
    note: wall
      ? `Not verified, but the page was a wall (${wall.join(', ')}) rather than a bad recipe — marked "blocked". ` +
        'The recipe may well be correct; it needs a person. Do not re-derive it on the strength of this run. ' +
        'If you cannot work out what the user needs to supply, set status "blocked-attn" with notes explaining the dead end.'
      : extracted
      ? `Verified: ${count} records extracted. register.js will now accept "status":"working" for this definition.`
      : 'Not verified. Read debugDir (diagnostics.json has the blocker and card-structure probes) before editing the recipe.',
  });
  process.exit(extracted ? 0 : 1);
}

// verify.js IS a sanctioned path: the status it writes was earned by a run it
// just performed, which is the only way working/blocked can be reached.
authorizeAsync('verify.js', main);
