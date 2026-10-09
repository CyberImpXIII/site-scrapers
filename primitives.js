#!/usr/bin/env node
// What is known about a PAGE, gathered across every recipe that targets it.
//
//   node primitives.js pages                  # every page, and how much is known
//   node primitives.js show <hostname|target> # one page, in full
//   node primitives.js try <url> [--actions=a,b] [--wait=MS]
//                                             # RUN generic actions against a page
//                                             # and record which ones do anything
//
// Read this BEFORE building a second recipe on a page that already has one.
// Three pages here already carry two recipes each, and each pair was
// characterised twice because nothing connected them.
//
// Derived from the recipe DB and the failures store on every call — see lib/primitives.js
// for why there is no table behind it.

process.removeAllListeners('warning');

const path = require('node:path');
const { openDb, listSites, getSite, getRecipeHealth, parseSiteArg, listGenericActions } = require('./db');
const { openFailuresDb, listFailures } = require('./failuresDb');
const { allPages } = require('./lib/primitives');

function out(o) {
  console.log(JSON.stringify(o, null, 2));
}
function die(msg) {
  out({ success: false, error: msg });
  process.exit(1);
}

function load() {
  const db = openDb();
  const sites = listSites(db)
    .filter(s => !String(s.hostname).endsWith('.internal'))
    .map(s => getSite(db, s.hostname, s.page_type, s.recipe_name));

  let failuresByHost = {};
  try {
    const fdb = openFailuresDb();
    for (const f of listFailures(fdb)) {
      (failuresByHost[f.hostname] ||= []).push(f);
    }
  } catch {
    failuresByHost = {}; // a missing failures store is not a reason to fail this
  }

  const { listObservations } = require('./db');
  const observationsByPageKey = {};
  for (const o of listObservations(db)) {
    (observationsByPageKey[o.page_key] ||= []).push(o);
  }

  return {
    ...allPages(sites, { health: getRecipeHealth(db), failuresByHost, observationsByPageKey }),
    // Observations filed against a URL that no recipe's entry template matches.
    // Kept visible rather than dropped: they are usually the most interesting
    // ones, since a page with no recipe is where the guesswork is worst.
    loose: Object.entries(observationsByPageKey)
      .filter(([key]) => !sites.some(s => require('./lib/pageIdentity').pageKeyFor(s) === key))
      .map(([key, obs]) => ({
        page: require('./lib/pageIdentity').describePageKey(key),
        hostname: obs[0].hostname,
        observations: obs.map(o => ({ subject: o.subject, outcome: o.outcome, detail: o.detail, observedAt: o.observed_at })),
      })),
  };
}

// The generic actions worth trying blind on an unknown page: the ones that are
// heuristic rather than site-specific, so they can meaningfully be asked "do
// you do anything here?". An action needing a selector (`paginate` wants
// next_selector) is excluded -- it would no-op for lack of input and record a
// misleading no_effect.
// Two halves, both parameterless so they can be asked of a page blind.
//
// The diagnostics come first because on a page with NO recipe they are the
// questions you actually have -- are there cards here and what is the
// selector, is there a wall, is there anti-bot -- and that is the case where
// the guesswork is worst. An action needing input (`paginate` wants
// next_selector, `probe_selectors` wants selectors) is excluded: it would
// no-op for lack of input and record a misleading answer.
const DEFAULT_TRIALS = [
  'probe_card_candidates',
  'probe_pagination_controls',
  'diagnose_blockers',
  'diagnose_antibot',
  'dismiss_overlay',
  'remove_overlay',
  'infinite_scroll',
  'expand_truncated_text',
];

// One page load per action, deliberately. Sharing a load makes each result
// depend on the ones before it -- dismiss_overlay having already removed the
// banner would make remove_overlay look like a no-op -- so the sequence would
// silently measure order rather than effect.
async function runTrials(url, actions, waitMs) {
  const { openDb, getSite, upsertSite, insertField } = require('./db');
  const { authorizeAsync } = require('./lib/writeGuard');
  const db = openDb();

  const PROBER = 'primitive-trial.internal';
  const steps = [];
  for (const [i, action] of actions.entries()) {
    steps.push({ action: 'goto', url: '{{url}}' });
    steps.push({ action: 'wait', ms: waitMs });
    steps.push({ action: 'probe', kind: 'page_signature', label: `before:${i}` });
    // repeat(1) so an action that raises StopRepeat (a `click stop_if_missing`
    // finding nothing) ends ITS block rather than the whole trial list, which
    // would silently skip every action after it.
    steps.push({ action: 'repeat', times: 1, steps: [{ action: 'run_generic_action', ref: action }] });
    steps.push({ action: 'probe', kind: 'page_signature', label: `after:${i}` });
  }

  const existing = getSite(db, PROBER, 'action', 'default');
  const tpl = JSON.stringify(steps);
  if (existing) {
    await authorizeAsync('primitives trial scaffolding', async () =>
      db.prepare('UPDATE sites SET nav_template = ?, status = ? WHERE id = ?').run(tpl, 'working', existing.id)
    );
  } else {
    await authorizeAsync('primitives trial scaffolding', async () => {
      const id = upsertSite(db, {
        hostname: PROBER, page_type: 'action', recipe_name: 'default', action_type: 'login',
        status: 'working', nav_method: 'ui_steps', nav_template: tpl, content_selector: 'body',
        ready_timeout_ms: 30000,
        notes: 'Internal scaffolding for primitives.js try. Not a real recipe — safe to delete.',
      });
      insertField(db, id, { field_name: 'body', extract_kind: 'full_blob' }, 0);
    });
  }

  const { execFile } = require('node:child_process');
  const execFileAsync = require('node:util').promisify(execFile);
  const args = [
    path.join(__dirname, 'engine.js'),
    `${PROBER}#action:default`,
    JSON.stringify({ url, allowUnverified: true, noSession: true, noDiagnostics: true }),
  ];
  let result;
  try {
    const { stdout } = await execFileAsync(process.execPath, args, {
      cwd: __dirname, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    result = JSON.parse(stdout);
  } catch (e) {
    try { result = JSON.parse(e.stdout); } catch { result = { success: false, error: (e.stderr || e.message || '').slice(0, 400) }; }
  }
  return { db, result };
}

async function tryActions() {
  const url = process.argv[3];
  if (!url || url.startsWith('--')) die('Usage: node primitives.js try <url> [--actions=a,b] [--wait=MS]');

  const flag = name => (process.argv.find(a => a.startsWith(`--${name}=`)) || '').split('=').slice(1).join('=');
  const actions = (flag('actions') || DEFAULT_TRIALS.join(',')).split(',').map(s => s.trim()).filter(Boolean);
  const waitMs = Number(flag('wait')) > 0 ? Number(flag('wait')) : 4000;
  if (actions.length > 8) die('at most 8 actions per trial — each one costs a page load');

  // A name that is not a registered action would fail at expansion and get
  // recorded as `error` — reading as "this action does not work on this page"
  // when the truth is it does not exist. Refuse before measuring anything.
  const registered = new Set(listGenericActions(openDb()).map(a => a.name));
  const unknown = actions.filter(a => !registered.has(a));
  if (unknown.length) {
    die(
      `not registered generic actions: ${unknown.join(', ')}. ` +
        `Known: ${[...registered].sort().join(', ')}. ` +
        'Recording a trial for a name that does not exist would look like the action failing here.'
    );
  }
  // A trial is an unattended run on an arbitrary page: never a submit
  // (lib/submitGuard.js). The engine would also refuse it (a submit inside a
  // repeat), but this says why, before a browser starts.
  {
    const g = require('./lib/submitGuard');
    const gdb = openDb();
    const submitting = actions.filter(a => g.actionSubmits(gdb, a));
    if (submitting.length) die(`${submitting.join(', ')}: ${g.REFUSAL}`);
  }

  let hostname;
  try { hostname = new URL(url).hostname.replace(/^www\./, '').toLowerCase(); }
  catch { return die(`not a URL: ${url}`); }

  const { db, result } = await runTrials(url, actions, waitMs);
  if (!result.success && !(result.diagnostics || []).length) {
    die(`the trial run failed before measuring anything: ${result.error || 'no diagnostics came back'}`);
  }

  // Attach to the page identity of an existing recipe on this host when the
  // trial URL plausibly belongs to it; otherwise key by the URL itself and say
  // so. Guessing a shared identity would attribute these findings to a page
  // they were not measured on.
  const { listSites, getSite: get } = require('./db');
  const { pageKeyFor, pageKeyFromParts, entryUrlFor, matchesEntryTemplate, describePageKey } = require('./lib/pageIdentity');
  const onHost = listSites(db)
    .filter(s => String(s.hostname).toLowerCase() === hostname)
    .map(s => get(db, s.hostname, s.page_type, s.recipe_name));

  // File against a page only when the trial URL actually FITS that page's
  // entry template. The first version attached to any recipe whose template
  // was a bare `{{url}}`, which is the one template that describes no shape at
  // all -- so trying the Lever BOARD filed its consent banner against the
  // POSTING page. Wrong attribution is worse than none: it sends the next
  // person looking for a dialog that is not on the page they are reading about.
  // Most specific wins, measured by how much of the template is literal.
  const fitting = onHost
    .filter(r => matchesEntryTemplate(url, entryUrlFor(r)))
    .sort((a, b) => String(entryUrlFor(b)).replace(/\{\{\w+\}\}/g, '').length
                  - String(entryUrlFor(a)).replace(/\{\{\w+\}\}/g, '').length);
  const match = fitting[0] || null;
  const pageKey = match ? pageKeyFor(match) : pageKeyFromParts(hostname, url);

  const byLabel = new Map();
  for (const d of result.diagnostics || []) if (d.label) byLabel.set(d.label, d);

  // Diagnostics an action emitted are the ones between its own markers. The
  // list is in execution order, so bracketing is exact and needs no list of
  // "which actions are probes" -- which would drift the first time one was
  // added.
  const emittedBy = i => {
    const all = result.diagnostics || [];
    const from = all.findIndex(d => d.label === `before:${i}`);
    const to = all.findIndex(d => d.label === `after:${i}`);
    return from >= 0 && to > from ? all.slice(from + 1, to) : [];
  };

  const { recordObservation } = require('./db');
  const { outcomeFor, outcomeForProbes } = require('./lib/observations');
  const { authorize } = require('./lib/writeGuard');
  const recorded = [];
  for (const [i, action] of actions.entries()) {
    const before = byLabel.get(`before:${i}`);
    const after = byLabel.get(`after:${i}`);
    const bySignature = outcomeFor({
      error: result.failedStep && result.failedStep.index != null && !after ? result.error : null,
      before: before && before.signature,
      after: after && after.signature,
    });
    // A diagnostic action changes nothing by design, so the signature says
    // no_effect however well it worked. Judge it on what it reported instead,
    // and mention the page moving too if it somehow did.
    const byReport = outcomeForProbes(emittedBy(i));
    const decided = byReport
      ? {
          ...byReport,
          detail: bySignature.outcome === 'changed'
            ? `${byReport.detail} [also moved the page: ${bySignature.detail}]`.slice(0, 200)
            : byReport.detail,
        }
      : bySignature;
    authorize(`primitives trial: ${action} on ${hostname}`, () =>
      recordObservation(db, {
        hostname,
        page_key: pageKey,
        observed_url: url,
        kind: 'generic_action',
        subject: action,
        outcome: decided.outcome,
        detail: decided.detail,
        evidence: { before: before && before.signature, after: after && after.signature, changes: decided.changes },
      })
    );
    recorded.push({ action, outcome: decided.outcome, detail: decided.detail });
  }

  out({
    url,
    hostname,
    attachedTo: match
      ? `the existing page ${describePageKey(pageKey)} (via ${match.page_type}:${match.recipe_name})`
      : 'this URL alone — no recipe on this host has an entry template matching it, and a template that matches everything is not evidence of anything',
    tried: recorded,
    hint:
      '"changed" means the action measurably moved this page, so it is worth trying here before one that provably does not. ' +
      'It does NOT mean the action helped — read `detail`. "no_effect" means it ran and nothing moved, which is a real answer: ' +
      'a page with no consent banner gives dismiss_overlay nothing to do. Re-run to confirm; agreeing observations raise times_observed.',
  });
}

function main() {
  const [, , cmd, arg] = process.argv;

  if (cmd === 'try') {
    tryActions().catch(e => die(String(e.message || e)));
    return;
  }

  if (cmd === 'suggest') {
    if (!arg) die('Usage: node primitives.js suggest <url|hostname>');
    const { suggestPlan } = require('./lib/primitives');
    const { listObservations } = require('./db');
    const { pageKeyFor, pageKeyFromParts, entryUrlFor, matchesEntryTemplate, describePageKey } = require('./lib/pageIdentity');
    const db = openDb();

    let hostname = arg;
    let isUrl = false;
    try { hostname = new URL(arg).hostname.replace(/^www\./, '').toLowerCase(); isUrl = true; } catch { /* a bare hostname */ }

    // Same attribution rule the trial uses, so `suggest` and `try` agree about
    // which page they are talking about.
    const onHost = listSites(db)
      .filter(s => String(s.hostname).toLowerCase() === hostname.toLowerCase())
      .map(s => getSite(db, s.hostname, s.page_type, s.recipe_name));
    const match = isUrl
      ? onHost.filter(r => matchesEntryTemplate(arg, entryUrlFor(r)))
          .sort((a, b) => String(entryUrlFor(b)).replace(/\{\{\w+\}\}/g, '').length
                        - String(entryUrlFor(a)).replace(/\{\{\w+\}\}/g, '').length)[0]
      : onHost[0];
    const pageKey = match ? pageKeyFor(match) : (isUrl ? pageKeyFromParts(hostname, arg) : null);

    const all = listObservations(db);
    const plan = suggestPlan({
      pageKey,
      hostname,
      observations: all.filter(o => o.page_key === pageKey),
      allObservations: all,
      availableActions: DEFAULT_TRIALS,
    });
    const next = plan.filter(p => p.tier !== 'known-here').map(p => p.action);
    out({
      target: arg,
      page: pageKey ? describePageKey(pageKey) : `${hostname} (no recipe and no URL given — host-level guess)`,
      plan,
      ...(next.length ? { run: `node primitives.js try <url> --actions=${next.join(',')}` } : {}),
      hint:
        'Ordered by the KIND of evidence behind each, not by a score: measured-here-and-stale first, then it worked elsewhere on this host, ' +
        'then how often it pays off anywhere, then never tried. "known-here" entries are at the bottom because there is nothing left to learn from them. ' +
        'There is deliberately no page-similarity notion beyond same-host — see TODO.',
    });
    return;
  }

  if (cmd === 'forget') {
    if (!arg) die('Usage: node primitives.js forget <hostname>  — drops every observation for that host');
    const { forgetObservations } = require('./db');
    const { authorize } = require('./lib/writeGuard');
    const db = openDb();
    const res = authorize(`forget observations for ${arg}`, () => forgetObservations(db, { hostname: arg }));
    out({
      hostname: arg,
      ...res,
      note: 'Re-measure with `node primitives.js try <url>`. An observation is only ever as current as the page it was taken from.',
    });
    return;
  }

  if (cmd === 'pages') {
    const { pages, unkeyed } = load();
    out({
      pages: pages.map(p => ({
        page: p.page,
        recipes: p.recipes.map(r => `${r.pageType}:${r.target.split(':').pop()}`),
        flags: Object.keys(p.flags),
        genericActions: p.genericActions.length,
      })),
      // Surfaced rather than hidden: a recipe with no determinable entry point
      // cannot share what it learns with anything, which is worth seeing.
      recipesWithNoEntryPoint: unkeyed.map(s => `${s.hostname}#${s.page_type}:${s.recipe_name}`),
      hint:
        'A page with 2+ recipes is one where the next recipe should start from `primitives.js show <hostname>` ' +
        'rather than from a browser. Pages listed with 1 recipe are still worth reading before adding a second.',
    });
    return;
  }

  if (cmd === 'show') {
    if (!arg) die('Usage: node primitives.js show <hostname|target>');
    const { hostname } = parseSiteArg(arg);
    const { pages } = load();
    const matches = pages.filter(p => p.hostname.toLowerCase() === hostname.toLowerCase());
    if (!matches.length) {
      die(
        `no registered recipe for "${hostname}", so nothing is known about its pages yet. ` +
          '`node query.js sites` lists what is registered; build the first recipe with `node lab.js new <hostname>`.'
      );
    }
    const { loose } = load();
    out({
      hostname,
      pages: matches,
      ...(loose.filter(l => l.hostname.toLowerCase() === hostname.toLowerCase()).length
        ? { looseObservations: loose.filter(l => l.hostname.toLowerCase() === hostname.toLowerCase()) }
        : {}),
      hint:
        'flags are things you would otherwise rediscover by running into them. ' +
        'genericActions with evidence "ran here via a working recipe" have demonstrably worked on THIS page — ' +
        'prefer them over guessing. "referenced only" means a recipe pulls it in but has not earned `working` yet, ' +
        'and an action absent from the list has never been tried here, which is not the same as not working.',
    });
    return;
  }

  die(`Unknown command "${cmd ?? ''}". Use: pages | show <hostname|target> | try <url> | suggest <url|hostname> | forget <hostname>`);
}

main();
