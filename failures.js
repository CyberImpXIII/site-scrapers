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

// node:sqlite emits an ExperimentalWarning on every run, which lands on
// stderr and makes this tool's output awkward to pipe into jq. Real warnings
// are not expected here and would be noise in a machine-read stream.
process.removeAllListeners('warning');


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
  listBlockerSignatures,
  insertBlockerSignature,
  deleteBlockerSignature,
  listProbeKnowledge,
  insertProbeKnowledge,
} = require('./failuresDb');
const { authorize } = require('./lib/writeGuard');

function fail(msg) {
  console.log(JSON.stringify({ success: false, error: msg }));
  process.exit(1);
}

function main() {
  const [, , cmd, arg, ...rest] = process.argv;
  const db = openFailuresDb();

  if (cmd === 'probe-knowledge') {
    const rows = listProbeKnowledge(db, { probeKind: arg });
    console.log(JSON.stringify({
      count: rows.length,
      knowledge: rows.map(r => ({ id: r.id, probe: r.probe_kind, category: r.category, kind: r.value_kind, value: r.value, source: r.source, notes: r.notes })),
      note:
        'What the probes KNOW: attribute names, phrases and markers that grow as new sites are met. The probe kinds themselves ' +
        'stay in code — executing JavaScript from a writable row would be arbitrary code execution. Numeric thresholds also stay ' +
        'in code, because they are tuning rather than knowledge. Add a discovery with `add-probe-knowledge`; builtin rows are ' +
        'seeded from lib/probeKnowledge.js and re-seeded on every open.',
    }, null, 2));
    return;
  }

  if (cmd === 'add-probe-knowledge') {
    if (!arg) fail('Usage: node failures.js add-probe-knowledge \'{"probe_kind":"forms","category":"stable_attr","value_kind":"attr","value":"data-foo","notes":"..."}\'');
    let def;
    try {
      def = JSON.parse(arg);
    } catch (e) {
      fail(`Not valid JSON: ${e.message}`);
    }
    if (!def.probe_kind || !def.category || !def.value) fail('probe_kind, category and value are all required');
    const CATEGORIES = ['stable_attr', 'required_marker', 'submit_text', 'empty_phrase', 'generated_class'];
    if (!CATEGORIES.includes(def.category)) fail(`category must be one of: ${CATEGORIES.join(', ')}`);
    if ((def.value_kind ?? 'pattern') === 'pattern') {
      // A pattern that cannot compile would be skipped forever, which looks
      // identical to one that simply never matches.
      try {
        new RegExp(def.value, 'i');
      } catch (e) {
        fail(`value is not a valid regex: ${e.message}`);
      }
    }
    insertProbeKnowledge(db, def);
    console.log(JSON.stringify({
      success: true,
      probe: def.probe_kind,
      category: def.category,
      note: 'Recorded. Every later probe run uses it — no code change, no restart. If it proves general, promote it into lib/probeKnowledge.js so a fresh clone has it too.',
    }));
    return;
  }

  if (cmd === 'signatures') {
    const rows = listBlockerSignatures(db, { service: arg });
    console.log(JSON.stringify({
      count: rows.length,
      signatures: rows.map(r => ({
        id: r.id,
        service: r.service,
        where: r.where_seen,
        pattern: r.pattern,
        weight: r.blocking_weight,
        source: r.source,
        notes: r.notes,
      })),
      note:
        'weight 2 = this signal alone means the page is walled; 1 = corroborating only (a challenge widget on a working ' +
        'page is the classic 1). builtin rows are seeded from lib/blockerSignatures.js and re-seeded on every open — ' +
        'edit that file to change one. Add discoveries with `add-signature`; they are source=user and survive re-seeding.',
    }, null, 2));
    return;
  }

  if (cmd === 'add-signature') {
    if (!arg) fail('Usage: node failures.js add-signature \'{"service":"...","where_seen":"title|body|resource|dom","pattern":"...","flags":"i","blocking_weight":1|2,"notes":"..."}\'');
    let def;
    try {
      def = JSON.parse(arg);
    } catch (e) {
      fail(`Not valid JSON: ${e.message}`);
    }
    if (!def.service || !def.where_seen || !def.pattern) fail('service, where_seen and pattern are all required');
    const WHERE = ['title', 'body', 'resource', 'dom'];
    if (!WHERE.includes(def.where_seen)) fail(`where_seen must be one of: ${WHERE.join(', ')}`);
    if (def.where_seen !== 'dom') {
      // Refuse a pattern that cannot compile: a bad row would be silently
      // skipped by the probe forever, which looks like the signature simply
      // never matching.
      try {
        new RegExp(def.pattern, def.flags || '');
      } catch (e) {
        fail(`pattern is not a valid regex: ${e.message}`);
      }
    }
    insertBlockerSignature(db, def);
    console.log(JSON.stringify({
      success: true,
      service: def.service,
      where: def.where_seen,
      weight: def.blocking_weight ?? 1,
      note: 'Recorded. Every later run of the antibot probe uses it — no code change and no restart needed. If it proves general, promote it into lib/blockerSignatures.js so a fresh clone has it too.',
    }));
    return;
  }

  if (cmd === 'forget-signature') {
    if (!arg) fail('Usage: node failures.js forget-signature <id>');
    const r = deleteBlockerSignature(db, Number(arg));
    console.log(JSON.stringify({ success: r.deleted, ...(r.reason ? { error: r.reason } : {}) }));
    process.exit(r.deleted ? 0 : 1);
  }

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

// failures.js IS a sanctioned path: it enforces the closed failure taxonomy and
// refuses a pattern that will not compile before anything is written.
authorize('failures.js', main);
