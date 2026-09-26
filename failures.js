#!/usr/bin/env node
// The troubleshooting memory: what has broken before, and what fixed it.
// Backed by data/failures.db, separate from scrapers.db (see failuresDb.js
// for why).
//
// Usage:
//   node failures.js match <hostname> ['<json probe>']   # BEFORE re-deriving a recipe: has this break been seen?
//   node failures.js common [limit]                      # which failure types dominate, across every site
//   node failures.js list [hostname] [--type=<name>]     # recorded failures, most frequent first
//   node failures.js types                               # the taxonomy (closed vocabulary -- prefer reusing)
//   node failures.js record '<json>'                     # record a DIAGNOSED failure
//   node failures.js forget <id>                         # remove one record (it was wrong, or no longer true)
//
// Record shape:
//   {
//     "failure_type": "consent_overlay",   // REQUIRED, must be in the taxonomy
//     "hostname": "example.com",           // optional -- omit for a site-independent pattern
//     "page_type": "listing",
//     "recipe_name": "default",
//     "version_label": "v2.1",             // which recipe version produced it
//     "step_action": "waitForSelector",    // from the run's failedStep
//     "step_selector": ".results",
//     "step_from": "generic:dismiss_overlay",
//     "symptom": "0 results, DOM shows a cookie dialog over the list",  // REQUIRED
//     "diagnosis": "consent banner renders after first paint, covers cards",
//     "resolution": "composed dismiss_overlay before the collect step",
//     "debug_dir": "data/.debug/..."
//   }
//
// Recording the same shape twice bumps `occurrences` instead of adding a
// row -- a repeat is itself the finding. Identity is (failure_type,
// hostname, page_type, recipe_name, step_selector, step_action); symptom
// text is excluded on purpose, since "timeout 8000ms" and "timeout 30000ms"
// are plainly the same recurring problem.
//
// Keep the taxonomy SMALL. `node failures.js types` first; only add a new
// type with "new_failure_type_description" when nothing existing fits, not
// as a shortcut. A taxonomy that fragments ("cookie_wall" beside
// "consent_overlay") cannot answer "have we seen this before", which is the
// only reason this database exists.

const {
  openFailuresDb,
  listFailureTypes,
  getFailureType,
  insertFailureType,
  recordFailure,
  listFailures,
  commonFailures,
  matchFailures,
  deleteFailure,
} = require('./failuresDb');

function fail(msg) {
  console.log(JSON.stringify({ success: false, error: msg }));
  process.exit(1);
}

function main() {
  const [, , cmd, arg, ...rest] = process.argv;
  const db = openFailuresDb();

  if (cmd === 'types') {
    console.log(JSON.stringify(listFailureTypes(db), null, 2));
    return;
  }

  if (cmd === 'common') {
    const rows = commonFailures(db, Number(arg) || 10);
    console.log(JSON.stringify(
      rows.length ? rows : { note: 'Nothing recorded yet. Record diagnosed failures with `node failures.js record`.' },
      null,
      2
    ));
    return;
  }

  if (cmd === 'list') {
    const typeArg = [arg, ...rest].find(a => a && a.startsWith('--type='));
    const hostname = arg && !arg.startsWith('--') ? arg : undefined;
    console.log(JSON.stringify(
      listFailures(db, { hostname, failureType: typeArg ? typeArg.slice('--type='.length) : undefined }),
      null,
      2
    ));
    return;
  }

  if (cmd === 'match') {
    if (!arg) fail("Usage: node failures.js match <hostname> ['<json probe>']  (probe may carry failure_type/symptom/step_selector/step_action/step_from)");
    let probe = {};
    if (rest[0]) {
      try {
        probe = JSON.parse(rest[0]);
      } catch (e) {
        fail(`Probe is not valid JSON: ${e.message}`);
      }
    }
    const hits = matchFailures(db, { hostname: arg, ...probe });
    console.log(JSON.stringify(
      {
        hostname: arg,
        matches: hits.map(h => ({
          id: h.id,
          score: h.score,
          why: h.why,
          failure_type: h.failure_type,
          hostname: h.hostname,
          occurrences: h.occurrences,
          symptom: h.symptom,
          diagnosis: h.diagnosis,
          resolution: h.resolution,
          last_seen: h.last_seen,
        })),
        note: hits.length
          ? 'Check these before re-deriving the recipe. A match on a DIFFERENT site is still useful when the resolution transfers.'
          : 'No known pattern matches. If you diagnose this one, record it so the next run is cheaper.',
      },
      null,
      2
    ));
    return;
  }

  if (cmd === 'record') {
    if (!arg) fail("Usage: node failures.js record '<json>'  (see this file's header for the shape)");
    let def;
    try {
      def = JSON.parse(arg);
    } catch (e) {
      fail(`Not valid JSON: ${e.message}`);
    }
    if (!def.failure_type) fail('failure_type is required — run `node failures.js types` for the taxonomy');
    if (!def.symptom) fail('symptom is required — what was actually observed');

    // Taxonomy enforcement, same bargain as action_types: a closed
    // vocabulary is the only thing that makes "is this the same failure?"
    // answerable, so a new type has to be deliberate.
    if (!getFailureType(db, def.failure_type)) {
      if (!def.new_failure_type_description) {
        fail(
          `"${def.failure_type}" is not in the failure taxonomy. Run \`node failures.js types\` and prefer an existing one — ` +
            'near-duplicates make failures unmatchable. If nothing genuinely fits, re-run with ' +
            '"new_failure_type_description": "<what this type means>".'
        );
      }
      insertFailureType(db, def.failure_type, def.new_failure_type_description);
    }

    const result = recordFailure(db, def);
    console.log(JSON.stringify({
      success: true,
      ...result,
      failure_type: def.failure_type,
      note:
        result.recorded === 'repeat'
          ? `Seen ${result.occurrences} times now — a recurring failure is worth fixing at the source, or noting in the recipe.`
          : 'Recorded. `node failures.js match <hostname>` will surface it next time.',
    }));
    return;
  }

  if (cmd === 'forget') {
    if (!arg) fail('Usage: node failures.js forget <id>');
    deleteFailure(db, Number(arg));
    console.log(JSON.stringify({ success: true, forgot: Number(arg) }));
    return;
  }

  fail(`Unknown command "${cmd ?? ''}". Use: match | common | list | types | record | forget`);
}

main();
