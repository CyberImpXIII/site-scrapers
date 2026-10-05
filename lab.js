#!/usr/bin/env node
// Recipe workbench: the operations you repeat constantly while BUILDING a
// recipe, as commands instead of throwaway one-liners.
//
// Written because building the last batch of recipes meant writing long
// inline `node -e "..."` blobs over and over — expensive, unreadable, and
// repeatedly broken by shell quoting. Node rather than Python so it can
// require('./db') and therefore respect versioning, the WAL pragmas and the
// status gate; a separate sqlite client would drift from those.
//
// Usage:
//   node lab.js probe <url>                       # what cards/forms/blockers are on this page
//   node lab.js sel <url> '<css,css,...>' [--wait=MS]   # match counts for candidate selectors
//   node lab.js inside <url> '<card_selector>' [--wait=MS]  # what is INSIDE a card, to pick child_text selectors
//   node lab.js match <target> '<params>' [--wait=MS]  # which selector yields each field's KNOWN value in every card
//   node lab.js peek <target> '<params>'          # run a recipe, show samples + per-field null counts
//   node lab.js raw <target> '<params>'           # same, but show each card's source text
//   node lab.js distinct <target> '<params>'      # per-field value spread + values shared between fields (drift)
//   node lab.js grep <target> '<params>' '<regex>'  # what the card text says AROUND a value, across every card
//   node lab.js set <target> '<json>'             # set card_selector / anchor / timeout / fields at once
//   node lab.js params <target> '<A>' '<B>'       # do two different params actually return different results?
//   node lab.js new <target>                      # print a register.js skeleton for a new recipe
//   node lab.js history <target>                 # params that have actually returned records (for param_probe_values)
//
// `set` takes: {"card_selector":"...", "card_anchor_text":"...",
//   "ready_timeout_ms":25000, "nav_template":"...", "nav_params_schema":"{}",
//   "notes":"...", "fields":[{"field_name":"title","extract_kind":"positional_segment","segment_index":0}]}
// Only the keys you pass are changed; "fields" replaces the whole set.
// "notes_append" adds to the existing notes rather than replacing them.
// Status is never set here — that is verify.js's job, from a real run.

// node:sqlite emits an ExperimentalWarning on every run, which lands on
// stderr and makes this tool's output awkward to pipe into jq. Real warnings
// are not expected here and would be noise in a machine-read stream.
process.removeAllListeners('warning');


const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const path = require('path');
const { openDb, getSite, getFields, insertField, parseSiteArg, snapshotVersionIfChanged } = require('./db');
const { recordsOf, countOf, recordIdentities, sameRecords } = require('./lib/outputShape');
const { distinctByField, crossFieldValues } = require('./lib/distinctValues');
const { grepRaw, searchableCount } = require('./lib/rawGrep');

const REPO_ROOT = __dirname;
const PROBER = 'lab-prober.internal';

function out(o) {
  console.log(JSON.stringify(o, null, 2));
}
function die(msg) {
  out({ success: false, error: msg });
  process.exit(1);
}

async function runEngine(target, params, raw = false) {
  const args = [path.join(REPO_ROOT, 'engine.js'), target, JSON.stringify({ allowUnverified: true, ...params })];
  if (raw) args.push('--raw');
  try {
    const { stdout } = await execFileAsync(process.execPath, args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch (e) {
    try {
      return JSON.parse(e.stdout);
    } catch {
      return { success: false, error: (e.stderr || e.message || '').slice(0, 400) };
    }
  }
}

// A throwaway action recipe used to point the diagnostic probes at an
// arbitrary URL without registering anything real. Kept internal so it never
// shows up as a job-search recipe someone might try to use.
function ensureProber(db, steps) {
  const existing = getSite(db, PROBER, 'action', 'default');
  const tpl = JSON.stringify(steps);
  if (existing) {
    db.prepare('UPDATE sites SET nav_template = ?, status = ? WHERE id = ?').run(tpl, 'working', existing.id);
    return existing.id;
  }
  const { upsertSite } = require('./db');
  const id = upsertSite(db, {
    hostname: PROBER,
    page_type: 'action',
    recipe_name: 'default',
    action_type: 'login',
    status: 'working',
    nav_method: 'ui_steps',
    nav_template: tpl,
    content_selector: 'body',
    ready_timeout_ms: 30000,
    notes: 'Internal scaffolding for lab.js. Not a real recipe — safe to delete.',
  });
  insertField(db, id, { field_name: 'body', extract_kind: 'full_blob' }, 0);
  return id;
}

function nullCounts(jobs) {
  const keys = [...new Set(jobs.flatMap(j => Object.keys(j)))].filter(k => k !== '_raw');
  return Object.fromEntries(keys.map(k => [k, `${jobs.filter(j => j[k] === null || j[k] === undefined || j[k] === '').length}/${jobs.length} null`]));
}

async function main() {
  const [, , cmd, a, b, c] = process.argv;
  const db = openDb();

  if (cmd === 'probe' || cmd === 'sel' || cmd === 'inside') {
    if (!a) die(`Usage: node lab.js ${cmd} <url>${cmd === 'sel' ? " '<css,css>'" : cmd === 'inside' ? " '<card_selector>'" : ''}`);
    if (cmd === 'inside' && (!b || b.startsWith('--'))) die("Usage: node lab.js inside <url> '<card_selector>'");
    const tail =
      cmd === 'probe'
        ? [
            { action: 'run_generic_action', ref: 'diagnose_page' },
            { action: 'run_generic_action', ref: 'diagnose_antibot' },
            { action: 'probe', kind: 'empty_state', label: 'empty' },
          ]
        : cmd === 'inside'
          ? [{ action: 'run_generic_action', ref: 'probe_card_anatomy', with: { card_selector: '{{sel}}' } }]
          : [{ action: 'run_generic_action', ref: 'probe_selectors', with: { selectors: '{{sel}}' } }];
    // The settle wait is a parameter because a fixed 5s lies about slow sites.
    // Probing a Workday tenant reported 0 matches for a selector its own recipe
    // uses successfully — the page simply had not rendered inside 5 seconds, and
    // the probe reported that as "the selector matches nothing", which is the
    // wrong conclusion and the expensive kind. If a recipe needs a large
    // ready_timeout_ms, pass a comparable wait here.
    const settleMs = Number(
      (process.argv.find(x => x.startsWith('--wait=')) || '').slice('--wait='.length)
    );
    const wait = Number.isFinite(settleMs) && settleMs > 0 ? settleMs : 5000;
    ensureProber(db, [
      { action: 'goto', url: '{{url}}' },
      { action: 'run_generic_action', ref: 'dismiss_overlay' },
      { action: 'wait', ms: wait },
      ...tail,
    ]);
    // Probe with the TARGET host's saved session, not logged out. The prober
    // used to pass noSession unconditionally, which made it structurally
    // unable to see any page that needs one — and it reported that as a fact
    // about the page ("card_selector matched nothing") rather than as its own
    // blindness. joblist.ala.org returns 21 records with its session and 0
    // without, so every probe against it was confidently wrong. A probe is
    // supposed to show what the recipe will see. --no-session restores the
    // clean-state behaviour when that is what you actually want.
    const noSession = process.argv.includes('--no-session');
    let sessionHostname = null;
    try {
      sessionHostname = new URL(a).hostname;
    } catch {
      // Not a URL — leave the jar to the prober's own hostname rather than
      // guessing, which is the old behaviour and no worse than it.
    }
    const r = await runEngine(`${PROBER}#action:default`, {
      url: a,
      sel: (b && !b.startsWith('--') ? b : '') || '',
      ...(noSession || !sessionHostname ? { noSession: true } : { sessionHostname }),
      noDiagnostics: true,
    });
    if (!r.success) die(`prober run failed: ${r.error}`);
    for (const p of r.diagnostics || []) {
      if (p.kind === 'blockers') out({ blockers: { blocked: p.blocked, flags: p.flags, bodyTextLength: p.bodyTextLength, title: p.title } });
      if (p.kind === 'antibot') {
        out({
          antibot: {
            detected: p.detected,
            blocking: p.blocking,
            presentButNotBlocking: p.presentButNotBlocking,
            services: p.services,
            automationSignals: p.automationSignals,
            advice: p.advice,
          },
        });
      }
      if (p.kind === 'empty_state') out({ emptyState: { likelyCause: p.likelyCause, explicitEmptyMessage: p.explicitEmptyMessage, largestSiblingGroup: p.largestSiblingGroup, advice: p.advice } });
      // A probe reports failure in `error`, and printing only `matches` threw
      // that away: JSON.stringify drops an undefined value, so a probe that
      // errored printed `{}` — the tool saying nothing at all while the reason
      // sat in the result it was handed. `card_anatomy` below already carried
      // its error through; this did not, and it cost a diagnosis on
      // ziprecruiter where `lab.js sel a` printed `{}` and looked like the
      // site's fault rather than the probe's.
      if (p.kind === 'selectors') out({ selectors: p.matches ?? null, error: p.error ?? null });
      if (p.kind === 'card_anatomy') {
        out({
          cardAnatomy: { cardCount: p.cardCount, cardsSampled: p.cardsSampled, parts: p.parts, error: p.error ?? null },
          hint: p.hint,
        });
      }
      if (p.kind === 'forms') out({ forms: { fields: p.fields.length, required: p.requiredCount, fileUpload: p.fileUploadPresent, submits: p.submits } });
      if (p.kind === 'repeated_structure') {
        out({
          cardCandidates: (p.candidates || []).slice(0, 5).map(x => ({
            childSelector: x.childSelector,
            count: x.count,
            childrenWithLinks: x.childrenWithLinks,
            stableHook: x.stableHook,
            selectorIsGenerated: x.selectorIsGenerated,
            sharedLine: x.sharedLine,
            sharedLineIn: x.sharedLineIn,
            sampleText: x.sampleText,
          })),
          hint: p.hint,
        });
      }
    }
    return;
  }

  // The migration question, answered as a search instead of a judgement.
  //
  // `inside` reports every part of a card and leaves you to decide which is
  // the title; for a recipe that ALREADY WORKS that decision is redundant,
  // because the values are known — so the real question is only "which
  // selector yields this exact value in every card". That is checkable, so it
  // is done here rather than read off a 15KB anatomy dump. Two runs: one to
  // learn the values, one to find the selectors that reproduce them.
  if (cmd === 'match') {
    if (!a) die("Usage: node lab.js match <target> '<params>' [--wait=MS]");
    const params = b && !b.startsWith('--') ? JSON.parse(b) : {};
    const r = await runEngine(a, params);
    const records = recordsOf(r);
    if (!records.length) {
      die(
        `the recipe returned no records, so there are no known values to match against` +
          `${r.error ? `: ${r.error}` : ''}. Fix the run first, or use \`node lab.js inside\` to choose selectors from scratch.`
      );
    }
    if (!r.url) die('the run did not report a final URL, so the page cannot be re-opened to search it');

    const { hostname, pageType, recipeName } = parseSiteArg(a);
    const site = getSite(db, hostname, pageType, recipeName);
    if (!site) die(`no recipe registered for ${a}`);
    if (!site.card_selector) {
      die(
        `${a} has no card_selector — this matches selectors INSIDE a card, so it needs to know what a card is. ` +
          'Run `node lab.js probe <url>` to find one first.'
      );
    }

    // A value hundreds of characters long is a description blob, not a hook,
    // and sending it would bloat the payload for a field that can only come
    // back null. Dropped explicitly rather than silently, so the output never
    // implies a field was searched for when it wasn't.
    const MAX_MATCHABLE_VALUE = 300;
    const expected = {};
    const tooLong = [];
    for (const key of [...new Set(records.flatMap(j => Object.keys(j)))]) {
      if (key === '_raw') continue;
      const values = records.map(j => (typeof j[key] === 'string' ? j[key] : null));
      const strings = values.filter(v => v !== null && v.trim());
      if (!strings.length) continue;
      if (strings.some(v => v.length > MAX_MATCHABLE_VALUE)) {
        tooLong.push(key);
        continue;
      }
      expected[key] = values;
    }
    if (!Object.keys(expected).length) {
      die(`every field is non-string or longer than ${MAX_MATCHABLE_VALUE} chars, so there is nothing matchable`);
    }

    const settleMs = Number((process.argv.find(x => x.startsWith('--wait=')) || '').slice('--wait='.length));
    const wait = Number.isFinite(settleMs) && settleMs > 0 ? settleMs : 5000;
    ensureProber(db, [
      { action: 'goto', url: '{{url}}' },
      { action: 'run_generic_action', ref: 'dismiss_overlay' },
      { action: 'wait', ms: wait },
      {
        action: 'run_generic_action',
        ref: 'probe_card_match',
        with: { card_selector: '{{sel}}', expected: '{{expected}}' },
      },
    ]);
    // Same session reasoning as the probe commands above, and it bites harder
    // here: the run that learned these values used the recipe's session, so
    // probing for them logged out would report selector:null for every field
    // — which reads as "every value is derived" rather than "I could not load
    // the page". Key the jar to the host the recipe actually visited.
    let matchSessionHost = null;
    try {
      matchSessionHost = new URL(r.url).hostname;
    } catch {
      matchSessionHost = site.hostname;
    }
    const p = await runEngine(`${PROBER}#action:default`, {
      url: r.url,
      sel: site.card_selector,
      expected: JSON.stringify(expected),
      ...(matchSessionHost ? { sessionHostname: matchSessionHost } : { noSession: true }),
      noDiagnostics: true,
    });
    if (!p.success) die(`prober run failed: ${p.error}`);
    const probe = (p.diagnostics || []).find(d => d.kind === 'card_match');
    if (!probe) die('the card_match probe did not report — check that probe_card_match is registered');
    if (probe.error) die(`card_match: ${probe.error}`);

    out({
      target: a,
      cardSelector: site.card_selector,
      mode: probe.mode,
      cardCount: probe.cardCount,
      cardsSampled: probe.cardsSampled,
      recordsGiven: probe.recordsGiven,
      ...(tooLong.length ? { notMatchable: { fields: tooLong, why: `values longer than ${MAX_MATCHABLE_VALUE} chars` } } : {}),
      fields: probe.fields,
      hint: probe.hint,
    });
    return;
  }

  if (cmd === 'peek' || cmd === 'raw') {
    if (!a) die(`Usage: node lab.js ${cmd} <target> '<params>'`);
    const r = await runEngine(a, b ? JSON.parse(b) : {}, cmd === 'raw');
    const jobs = recordsOf(r);
    out({
      target: a,
      success: r.success,
      count: r.count ?? jobs.length,
      url: r.url,
      timedOut: r.timedOut,
      partialResults: r.partialResults ?? false,
      error: r.error ?? null,
      failedStep: r.failedStep ?? null,
      failureContext: r.failureContext ?? null,
      debugDir: r.debugDir ?? null,
      samples: jobs.slice(0, 3),
      fieldCoverage: jobs.length ? nullCounts(jobs) : null,
    });
    return;
  }

  if (cmd === 'grep') {
    if (!a || c === undefined) die("Usage: node lab.js grep <target> '<params>' '<regex>'");
    // Always raw: the source blob is the thing being searched.
    const r = await runEngine(a, b ? JSON.parse(b) : {}, true);
    const jobs = recordsOf(r);
    const searchable = searchableCount(jobs);
    out({
      target: a,
      success: r.success,
      count: r.count ?? jobs.length,
      // Distinguishes "the page does not say this" from "no card carried source
      // text", which look identical in a hit count of zero.
      searchableRecords: searchable,
      timedOut: r.timedOut,
      error: r.error ?? null,
      failedStep: r.failedStep ?? null,
      debugDir: r.debugDir ?? null,
      pattern: c,
      ...grepRaw(jobs, c),
    });
    return;
  }

  if (cmd === 'distinct') {
    if (!a) die("Usage: node lab.js distinct <target> '<params>'");
    const r = await runEngine(a, b ? JSON.parse(b) : {}, false);
    const jobs = recordsOf(r);
    const shared = crossFieldValues(jobs);
    out({
      target: a,
      success: r.success,
      count: r.count ?? jobs.length,
      // The same failure detail peek reports. Omitting it meant a failed run
      // printed "success=false n=0" and nothing else, which forces a SECOND
      // live run just to find out what broke -- the exact fault CLAUDE.md
      // names, committed here within an hour of writing the rule down.
      url: r.url,
      timedOut: r.timedOut,
      partialResults: r.partialResults ?? false,
      error: r.error ?? null,
      failedStep: r.failedStep ?? null,
      failureContext: r.failureContext ?? null,
      debugDir: r.debugDir ?? null,
      fields: distinctByField(jobs),
      // Named for what it means rather than what it is: every entry here is a
      // pair of fields that may be reading the same element.
      possibleDrift: shared,
      driftFields: [...new Set(shared.flatMap((s) => s.fields.map((f) => f.field)))],
    });
    return;
  }

  if (cmd === 'set') {
    if (!a || !b) die("Usage: node lab.js set <target> '<json>'");
    const { hostname, pageType, recipeName } = parseSiteArg(a);
    const site = getSite(db, hostname, pageType, recipeName);
    if (!site) die(`No recipe for "${a}"`);
    let def;
    // `@path` reads the JSON from a file. Long notes contain apostrophes and
    // nested quotes, and shell-escaping those inline is how a set silently
    // turns into a no-op — which is exactly what happened to a usajobs.gov
    // note before this existed.
    const raw = b.startsWith('@') ? require('fs').readFileSync(b.slice(1), 'utf8') : b;
    try {
      def = JSON.parse(raw);
    } catch (e) {
      die(`not valid JSON${b.startsWith('@') ? ` in ${b.slice(1)}` : ''}: ${e.message}`);
    }

    // The same gate register.js enforces, because a second write path that
    // skips it is no gate at all. "working" and "blocked" are claims that have
    // to come from a run; the cautious statuses stay settable here.
    const EARNED = ['working', 'blocked'];
    if (EARNED.includes(def.status)) {
      die(
        `status "${def.status}" cannot be set here — it has to be earned by a run. ` +
          `Use: node verify.js ${a} '<params>'  (add --attended to prove a person alone is sufficient). ` +
          'Settable by hand: broken, needs-review, blocked-attn (the last requires notes).'
      );
    }

    // notes_append adds to the existing notes instead of replacing them. A
    // recipe's notes are its accumulated history — why a selector is odd, what
    // was already ruled out — and that is the part nobody re-derives. Setting
    // `notes` to add one finding means reproducing the whole existing string
    // by hand, which has twice meant writing a throwaway script to read the
    // old value first. Resolved here so the next append is one key.
    if ('notes_append' in def) {
      if ('notes' in def) die('pass either "notes" (replace) or "notes_append" (add to), not both');
      def.notes = `${site.notes || ''}\n${def.notes_append}`.trim();
    }

    const cols = [
      'card_selector', 'card_anchor_text', 'ready_timeout_ms', 'nav_template', 'nav_params_schema',
      'notes', 'content_selector', 'card_min_text_len', 'param_probe_values', 'status',
    ];
    // Every recipe edit goes through the gate: offline audits before and
    // after, a snapshot to roll back to, and a change_log row so an edit made
    // OFF this path is detectable by its absence. Requires a `note` describing
    // the change, which doubles as the log summary — an unexplained edit is
    // what the gate exists to stop.
    if (!def.note) {
      die('a "note" is required: it describes the change, gates it, and becomes the change_log summary');
    }
    const { guardedChange } = require('./lib/gate');
    const gated = guardedChange(db, {
      target: `${hostname}#${pageType}:${recipeName}`,
      summary: def.note,
      scope: 'status' in def && Object.keys(def).length <= 2 ? 'status' : 'recipe',
      siteId: site.id,
      mutate: () => applyRecipeEdit(),
    });

    function applyRecipeEdit() {
    const setting = cols.filter(k => k in def);
    if (setting.length) {
      db.prepare(`UPDATE sites SET ${setting.map(k => `${k} = ?`).join(', ')} WHERE id = ?`)
        // These columns are TEXT holding JSON, so accept the natural
        // object/array form in the input and serialise it here rather than
        // making every caller pre-stringify.
        .run(
          ...setting.map(k =>
            ['param_probe_values', 'nav_params_schema', 'nav_template'].includes(k) && typeof def[k] !== 'string'
              ? JSON.stringify(def[k])
              : def[k]
          ),
          site.id
        );
    }
    if (Array.isArray(def.fields)) {
      db.prepare('DELETE FROM site_fields WHERE site_id = ?').run(site.id);
      def.fields.forEach((f, i) => insertField(db, site.id, f, i));
    }
    snapshotVersionIfChanged(db, site.id, { note: def.note });
    return [...setting, ...(def.fields ? ['fields'] : [])];
    }

    out({
      success: gated.ok,
      target: a,
      changed: gated.result,
      version: gated.versionAfter,
      // Re-read: `site` was fetched before the UPDATE, so reporting its status
      // would echo the old value back and look like the write failed.
      status: getSite(db, hostname, pageType, recipeName).status,
      fields: getFields(db, site.id).map(f => f.field_name),
      gate: {
        findingsBefore: gated.findingsBefore,
        findingsAfter: gated.findingsAfter,
        introducedFindings: gated.introducedFindings,
        // Which reusable actions this recipe pulls in, and the suites that
        // cover them — a recipe referencing dismiss_overlay depends on that
        // action's behaviour, so validating one without the other is partial.
        referencedActions: gated.referencedActions,
        actionTests: gated.actionTests,
        rolledBack: gated.rolledBack,
        ...(gated.rollbackNote ? { rollbackNote: gated.rollbackNote } : {}),
      },
      note: gated.ok
        ? 'Gate passed. Status unchanged — run `node verify.js` to earn "working" from a real run.'
        : 'GATE FAILED: this change introduced the findings above and was rolled back. Fix them, then retry.',
    });
    if (!gated.ok) process.exit(1);
    return;
  }

  if (cmd === 'params') {
    if (!a || !b || !c) die("Usage: node lab.js params <target> '<paramsA>' '<paramsB>'");
    // Catches the failure mode where a recipe declares a parameter and
    // silently ignores it: nodesk.co accepted {"search":"sales"} and
    // {"search":"engineer"} and returned byte-identical results, because the
    // site filters client-side and never reads ?s=. That is worse than a
    // broken recipe — it answers the wrong question without complaining.
    const [ra, rb] = [await runEngine(a, JSON.parse(b)), await runEngine(a, JSON.parse(c))];
    // One identity (lib/outputShape.js): raw hrefs carried linkedin's per-run
    // trackingId, so an ignored param read as "changes the result set".
    const ids = r => recordIdentities(r).slice(0, 25);
    const inert = countOf(ra) > 0 && sameRecords(ids(ra), ids(rb));
    out({
      target: a,
      a: { params: JSON.parse(b), url: ra.url, count: ra.count },
      b: { params: JSON.parse(c), url: rb.url, count: rb.count },
      paramsInert: inert,
      verdict: inert
        ? 'INERT — both parameter sets returned the same records. The recipe is ignoring its params; either find the real filter mechanism or drop the param from nav_params_schema so it stops promising something it does not do.'
        : 'Parameters change the result set, as a caller would expect.',
    });
    return;
  }

  if (cmd === 'history') {
    // What params have actually WORKED for this recipe. The answer to "what do
    // I put in param_probe_values" is usually already in run history, and
    // recovering it beats inventing values that may match nothing — an
    // article recipe needs a real posting URL, and guessing one is useless.
    if (!a) die('Usage: node lab.js history <target>');
    const { hostname, pageType, recipeName } = parseSiteArg(a);
    const site = getSite(db, hostname, pageType, recipeName);
    if (!site) die(`No recipe for "${a}"`);
    const rows = db
      .prepare(
        `SELECT params_json, result_count, version_label, ran_at FROM scrape_runs
          WHERE site_id = ? AND IFNULL(result_count,0) > 0
          ORDER BY id DESC LIMIT 20`
      )
      .all(site.id);
    const seen = new Set();
    const distinct = [];
    for (const r of rows) {
      let p;
      try {
        p = JSON.parse(r.params_json || '{}');
      } catch {
        continue;
      }
      // Drop harness-only params: they are not part of the recipe's contract.
      for (const k of ['allowUnverified', 'noSession', 'noDiagnostics', 'rollingFrames', 'rollingIntervalMs', 'attended', 'attendedTimeoutMs', 'session']) {
        delete p[k];
      }
      const key = JSON.stringify(p);
      if (key === '{}' || seen.has(key)) continue;
      seen.add(key);
      distinct.push({ params: p, records: r.result_count, version: r.version_label, at: r.ran_at });
    }
    out({
      target: a,
      placeholdersInTemplate: [...String(site.nav_template || '').matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]),
      currentProbeValues: site.param_probe_values ? JSON.parse(site.param_probe_values) : null,
      paramsThatReturnedRecords: distinct,
      note: distinct.length
        ? 'Pick two contrasting sets from these for param_probe_values — they are known to return records, so an empty comparison will not be a false alarm.'
        : 'No successful run with params on record. Run it once with real params first, then come back.',
    });
    return;
  }

  if (cmd === 'adopt-history') {
    // Sets param_probe_values from the two most recent DISTINCT param sets that
    // actually returned records. Exists because `audit.js working` cannot
    // validate a recipe whose template has placeholders it has no values for,
    // and 18 recipes were in that state — values that are known to work are
    // already sitting in run history, so adopting them beats inventing them.
    if (!a) die('Usage: node lab.js adopt-history <target>   (--force to overwrite existing probe values)');
    const { hostname, pageType, recipeName } = parseSiteArg(a);
    const site = getSite(db, hostname, pageType, recipeName);
    if (!site) die(`No recipe for "${a}"`);
    const placeholders = [...String(site.nav_template || '').matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]);
    if (!placeholders.length) {
      out({ target: a, skipped: true, why: 'nav_template has no placeholders, so there is nothing to probe' });
      return;
    }
    if (site.param_probe_values && b !== '--force') {
      out({ target: a, skipped: true, why: 'already has param_probe_values; pass --force to replace them' });
      return;
    }
    const rows = db
      .prepare('SELECT params_json FROM scrape_runs WHERE site_id = ? AND IFNULL(result_count,0) > 0 ORDER BY id DESC LIMIT 40')
      .all(site.id);
    const seen = new Set();
    const picks = [];
    for (const r of rows) {
      let p;
      try {
        p = JSON.parse(r.params_json || '{}');
      } catch {
        continue;
      }
      for (const k of ['allowUnverified', 'noSession', 'noDiagnostics', 'rollingFrames', 'rollingIntervalMs', 'attended', 'attendedTimeoutMs', 'session']) {
        delete p[k];
      }
      // Must actually cover the template, or adopting it just moves the problem.
      if (!placeholders.every(n => n in p)) continue;
      const key = JSON.stringify(p);
      if (seen.has(key)) continue;
      seen.add(key);
      picks.push(p);
      if (picks.length === 2) break;
    }
    if (!picks.length) {
      out({
        target: a,
        skipped: true,
        why: `no successful run supplied every placeholder (${placeholders.join(', ')}) — run it once with real params first`,
      });
      return;
    }
    db.prepare('UPDATE sites SET param_probe_values = ? WHERE id = ?').run(JSON.stringify(picks), site.id);
    out({
      target: a,
      adopted: picks.length,
      probeValues: picks,
      note:
        picks.length === 1
          ? 'Only one distinct working param set on record. Enough for `audit.js working`, but `audit.js params` needs two to prove a parameter is not inert.'
          : 'Two distinct sets adopted — enough for both `audit.js working` and `audit.js params`.',
    });
    return;
  }

  if (cmd === 'new') {
    out({
      skeleton: {
        hostname: a || 'example.com',
        page_type: 'listing',
        recipe_name: 'default',
        status: 'needs-review',
        nav_method: 'url_param',
        nav_template: 'https://example.com/jobs?q={{query}}',
        nav_params_schema: '{"query":"string, search keywords"}',
        card_selector: 'PUT A SELECTOR FROM `lab.js probe <url>` HERE',
        ready_timeout_ms: 25000,
        notes: '',
        fields: [{ field_name: 'title', extract_kind: 'positional_segment', segment_index: 0 }],
      },
      workflow: [
        '1. node lab.js probe <url>            -- find the card container',
        '2. node register.js \'<skeleton>\'      -- status stays needs-review; "working" is not accepted yet',
        '3. node lab.js raw <target> \'{}\'      -- read real card text, design the fields',
        '4. node lab.js set <target> \'{"fields":[...]}\'',
        '5. node lab.js params <target> \'{"query":"sales"}\' \'{"query":"engineer"}\'  -- prove the param does something',
        '6. node verify.js <target> \'{}\'       -- a passing run is what sets status to working',
      ],
    });
    return;
  }

  die(`Unknown command "${cmd ?? ''}". Use: probe | sel | inside | match | peek | raw | set | params | history | adopt-history | new`);
}

main();
