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
//   node lab.js sel <url> '<css,css,...>'         # match counts for candidate selectors
//   node lab.js peek <target> '<params>'          # run a recipe, show samples + per-field null counts
//   node lab.js raw <target> '<params>'           # same, but show each card's source text
//   node lab.js set <target> '<json>'             # set card_selector / anchor / timeout / fields at once
//   node lab.js params <target> '<A>' '<B>'       # do two different params actually return different results?
//   node lab.js new <target>                      # print a register.js skeleton for a new recipe
//   node lab.js history <target>                 # params that have actually returned records (for param_probe_values)
//
// `set` takes: {"card_selector":"...", "card_anchor_text":"...",
//   "ready_timeout_ms":25000, "nav_template":"...", "nav_params_schema":"{}",
//   "notes":"...", "fields":[{"field_name":"title","extract_kind":"positional_segment","segment_index":0}]}
// Only the keys you pass are changed; "fields" replaces the whole set.
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

  if (cmd === 'probe' || cmd === 'sel') {
    if (!a) die(`Usage: node lab.js ${cmd} <url>${cmd === 'sel' ? " '<css,css>'" : ''}`);
    const tail =
      cmd === 'probe'
        ? [
            { action: 'run_generic_action', ref: 'diagnose_page' },
            { action: 'run_generic_action', ref: 'diagnose_antibot' },
            { action: 'probe', kind: 'empty_state', label: 'empty' },
          ]
        : [{ action: 'run_generic_action', ref: 'probe_selectors', with: { selectors: '{{sel}}' } }];
    ensureProber(db, [
      { action: 'goto', url: '{{url}}' },
      { action: 'run_generic_action', ref: 'dismiss_overlay' },
      { action: 'wait', ms: 5000 },
      ...tail,
    ]);
    const r = await runEngine(`${PROBER}#action:default`, { url: a, sel: b || '', noSession: true, noDiagnostics: true });
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
      if (p.kind === 'selectors') out({ selectors: p.matches });
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

  if (cmd === 'peek' || cmd === 'raw') {
    if (!a) die(`Usage: node lab.js ${cmd} <target> '<params>'`);
    const r = await runEngine(a, b ? JSON.parse(b) : {}, cmd === 'raw');
    const jobs = r.jobs || (r.article ? [r.article] : []);
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
    const ids = r => JSON.stringify((r.jobs || []).map(j => j.href ?? j.title ?? '').slice(0, 25));
    const inert = ra.count > 0 && ids(ra) === ids(rb);
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

  die(`Unknown command "${cmd ?? ''}". Use: probe | sel | peek | raw | set | params | new`);
}

main();
