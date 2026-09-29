// Site primitives: what a page knows about itself, pooled across its recipes.
//
// The claims this view makes are the risky part, not the plumbing. It tells you
// a generic action "ran here", which is an assertion about evidence -- and this
// repo's rule is that such a claim is earned by a run, never asserted. If the
// evidence wording drifted from what the data supports, the view would be
// confidently wrong in exactly the way that sends someone to trust an action
// that has never worked on this page.
//
// Page identity itself is tested separately in test/page-identity.test.js.
//
// Run via `npm test` / `./test.sh`.

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPrimitive, allPages, flagsFor, paramsFor, actionsFor } = require('../lib/primitives');
const { pageKeyFor } = require('../lib/pageIdentity');

const steps = s => JSON.stringify(s);
const recipe = (over = {}) => ({
  hostname: 'x.com',
  page_type: 'article',
  recipe_name: 'default',
  status: 'working',
  nav_method: 'direct_url',
  nav_template: '{{url}}',
  ready_timeout_ms: 20000,
  ...over,
});

// --- the earned claim -------------------------------------------------------

test('an action is only said to have RUN here when a working recipe pulls it in', () => {
  const working = recipe({
    page_type: 'action',
    recipe_name: 'describe',
    status: 'working',
    nav_method: 'ui_steps',
    nav_template: steps([{ action: 'goto', url: '{{url}}' }, { action: 'run_generic_action', ref: 'describe_form' }]),
  });
  const [ran] = actionsFor([working], []);
  assert.equal(ran.action, 'describe_form');
  assert.match(ran.evidence, /ran here/);
});

test('a recipe that has NOT earned working proves nothing about its actions', () => {
  // The direction that matters. needs-review means nobody has shown this works
  // on this page, so saying the action "ran here" would be inventing evidence.
  for (const status of ['needs-review', 'broken', 'blocked', 'blocked-attn']) {
    const unproven = recipe({
      page_type: 'action',
      status,
      nav_method: 'ui_steps',
      nav_template: steps([{ action: 'goto', url: '{{url}}' }, { action: 'run_generic_action', ref: 'dismiss_overlay' }]),
    });
    const [entry] = actionsFor([unproven], []);
    assert.equal(entry.evidence, 'referenced only', `status ${status} must not read as evidence`);
  }
});

test('run counts are quoted from health, not invented', () => {
  const r = recipe({
    page_type: 'action',
    nav_method: 'ui_steps',
    nav_template: steps([{ action: 'goto', url: '{{url}}' }, { action: 'run_generic_action', ref: 'paginate' }]),
  });
  const health = [{ hostname: 'x.com', page_type: 'action', recipe_name: 'default', recentOk: 3, recentRuns: 4, successRate: 75 }];
  const [entry] = actionsFor([r], health);
  assert.match(entry.evidence, /3\/4 recent runs/);

  // With no health row there must be no fabricated count.
  const [bare] = actionsFor([r], []);
  assert.match(bare.evidence, /ran here/);
  assert.doesNotMatch(bare.evidence, /recent runs/);
});

test('actions pulled in from pagination_config are found too', () => {
  // pagination_config is a second step list, and an action used only there was
  // invisible to a scan of nav_template alone.
  const r = recipe({
    pagination_method: 'steps',
    pagination_config: steps([{ action: 'run_generic_action', ref: 'paginate' }]),
  });
  assert.deepEqual(actionsFor([r], []).map(a => a.action), ['paginate']);
});

test('nested steps are walked, not just the top level', () => {
  const r = recipe({
    nav_method: 'ui_steps',
    nav_template: steps([
      { action: 'goto', url: '{{url}}' },
      { action: 'repeat', times: 1, steps: [{ action: 'run_generic_action', ref: 'dismiss_overlay' }] },
    ]),
  });
  assert.deepEqual(actionsFor([r], []).map(a => a.action), ['dismiss_overlay']);
});

// --- flags ------------------------------------------------------------------

test('slowRender is flagged only above the default, and says what it costs', () => {
  assert.equal(flagsFor([recipe({ ready_timeout_ms: 20000 })]).slowRender, undefined);
  const flag = flagsFor([recipe({ ready_timeout_ms: 45000 })]).slowRender;
  assert.match(flag, /45000/);
  // The consequence is the useful half: probing at the default reports zero of
  // everything, which reads as a broken selector rather than a slow page.
  assert.match(flag, /default/);
});

test('mustBeLoggedOut is surfaced, because a saved session silently returns nothing', () => {
  assert.match(flagsFor([recipe({ session_mode: 'none' })]).mustBeLoggedOut, /0 records/);
});

test('a handoff anywhere in the steps flags that a person is needed mid-run', () => {
  const r = recipe({
    nav_method: 'ui_steps',
    nav_template: steps([{ action: 'goto', url: '{{url}}' }, { action: 'handoff', reason: 'solve it' }]),
  });
  assert.ok(flagsFor([r]).needsAPersonMidRun);
});

test('flags pool across every recipe on the page', () => {
  // The whole point: the article recipe knows the page is slow, the action
  // recipe knows it needs a person, and a reader should get both.
  const flags = flagsFor([
    recipe({ ready_timeout_ms: 45000 }),
    recipe({ page_type: 'action', nav_method: 'ui_steps', nav_template: steps([{ action: 'handoff' }]) }),
  ]);
  assert.ok(flags.slowRender && flags.needsAPersonMidRun);
});

// --- params -----------------------------------------------------------------

test('params pool across recipes and keep which recipe proved each value', () => {
  const a = recipe({ nav_params_schema: '{"url":"the posting"}', param_probe_values: '[{"url":"https://x.com/1"}]' });
  const b = recipe({ page_type: 'action', recipe_name: 'describe', nav_params_schema: '{"captureMode":"none|flagged|all"}' });
  const { declared, knownWorkingValues } = paramsFor([a, b]);
  assert.deepEqual(Object.keys(declared).sort(), ['captureMode', 'url']);
  assert.deepEqual(knownWorkingValues['article:default'], [{ url: 'https://x.com/1' }]);
});

test('malformed stored JSON degrades to a gap, never to a throw', () => {
  // This view is read while troubleshooting, which is when the DB is most
  // likely to hold something half-written. Falling over would take away the
  // tool at the moment it is wanted.
  const bad = recipe({ nav_params_schema: '{not json', param_probe_values: 'also not json' });
  assert.deepEqual(paramsFor([bad]), { declared: {}, knownWorkingValues: {} });
  assert.deepEqual(actionsFor([recipe({ nav_method: 'ui_steps', nav_template: '{oops' })], []), []);
  assert.doesNotThrow(() => flagsFor([recipe({ nav_method: 'ui_steps', nav_template: '{oops' })]));
});

// --- assembly ---------------------------------------------------------------

test('a primitive names every recipe on the page and the failures of its host', () => {
  const article = recipe();
  const action = recipe({ page_type: 'action', recipe_name: 'describe', nav_method: 'ui_steps', nav_template: steps([{ action: 'goto', url: '{{url}}' }]) });
  const p = buildPrimitive(pageKeyFor(article), [article, action], {
    failures: [{ failure_type: 'slow_render', symptom: 's', resolution: 'raised the timeout', occurrences: 2, last_seen: 'then' }],
  });
  assert.equal(p.recipes.length, 2);
  assert.equal(p.entryUrl, '{{url}}');
  assert.equal(p.knownFailures[0].resolution, 'raised the timeout');
});

// --- suggestPlan: what to try here, and why in that order -------------------

const obs = (over = {}) => ({
  kind: 'generic_action', hostname: 'x.com', page_key: 'x.com\u001f{{url}}',
  observed_url: 'https://x.com/1', subject: 'dismiss_overlay', outcome: 'changed',
  detail: 'd', observed_at: new Date().toISOString(), times_observed: 1, ...over,
});

test('the plan is ordered by the KIND of evidence, not by a score', () => {
  const { suggestPlan } = require('../lib/primitives');
  const HERE = 'x.com\u001f{{url}}';
  const plan = suggestPlan({
    pageKey: HERE,
    hostname: 'x.com',
    observations: [obs({ subject: 'known_one' })],
    allObservations: [
      obs({ subject: 'known_one' }),
      // did something on ANOTHER page of this host
      obs({ subject: 'host_one', page_key: 'x.com\u001fhttps://x.com/{{c}}' }),
      // did something on a different host entirely -> base rate only
      obs({ subject: 'base_one', hostname: 'y.com', page_key: 'y.com\u001f{{url}}' }),
    ],
    availableActions: ['known_one', 'host_one', 'base_one', 'never_tried'],
  });
  assert.deepEqual(
    plan.map(p => `${p.tier}:${p.action}`),
    ['same-host:host_one', 'base-rate:base_one', 'untried:never_tried', 'known-here:known_one'],
    'same-host beats base-rate beats untried, and what is already known here sinks to the bottom'
  );
});

test('a stale measurement goes to the FRONT, not the bottom', () => {
  // The one case where something already measured here is the most urgent
  // thing to run: the answer exists but may describe a page that has changed.
  const { suggestPlan } = require('../lib/primitives');
  const { STALE_AFTER_DAYS } = require('../lib/observations');
  const old = new Date(Date.now() - (STALE_AFTER_DAYS + 5) * 86400000).toISOString();
  const plan = suggestPlan({
    pageKey: 'x.com\u001f{{url}}',
    hostname: 'x.com',
    observations: [obs({ subject: 'gone_stale', observed_at: old })],
    allObservations: [obs({ subject: 'gone_stale', observed_at: old })],
    availableActions: ['gone_stale', 'never_tried'],
  });
  assert.equal(plan[0].tier, 'retry-here');
  assert.match(plan[0].why, /may have changed/);
});

test('base rate counts PAGES, so one page trialled often does not outvote many', () => {
  const { suggestPlan } = require('../lib/primitives');
  const many = [];
  // `often` did something on one page, measured repeatedly.
  for (let i = 0; i < 5; i++) many.push(obs({ subject: 'often', hostname: 'z.com', page_key: 'z.com\u001fp1' }));
  // `broad` did something on three distinct pages.
  for (const p of ['p1', 'p2', 'p3']) many.push(obs({ subject: 'broad', hostname: 'z.com', page_key: `z.com\u001f${p}` }));
  const plan = suggestPlan({
    pageKey: 'new.com\u001f{{url}}', hostname: 'new.com',
    observations: [], allObservations: many, availableActions: ['often', 'broad'],
  });
  assert.equal(plan[0].action, 'broad', 'three pages of evidence beats one page measured five times');
  assert.equal(plan.find(p => p.action === 'broad').rate, '3/3');
  assert.equal(plan.find(p => p.action === 'often').rate, '1/1');
});

test('an action that reliably does nothing sinks below one that does something', () => {
  const { suggestPlan } = require('../lib/primitives');
  const all = [
    obs({ subject: 'works', hostname: 'z.com', page_key: 'z.com\u001fp1', outcome: 'changed' }),
    obs({ subject: 'works', hostname: 'z.com', page_key: 'z.com\u001fp2', outcome: 'changed' }),
    obs({ subject: 'inert', hostname: 'z.com', page_key: 'z.com\u001fp1', outcome: 'no_effect' }),
    obs({ subject: 'inert', hostname: 'z.com', page_key: 'z.com\u001fp2', outcome: 'no_effect' }),
  ];
  const plan = suggestPlan({
    pageKey: 'new.com\u001f{{url}}', hostname: 'new.com',
    observations: [], allObservations: all, availableActions: ['inert', 'works'],
  });
  assert.equal(plan[0].action, 'works');
  assert.equal(plan.find(p => p.action === 'inert').rate, '0/2', 'still listed — no_effect elsewhere is not proof about here');
});

test('errors elsewhere do not count as the action doing something', () => {
  const { suggestPlan } = require('../lib/primitives');
  const plan = suggestPlan({
    pageKey: 'new.com\u001f{{url}}', hostname: 'new.com', observations: [],
    allObservations: [obs({ subject: 'broken', hostname: 'z.com', page_key: 'z.com\u001fp1', outcome: 'error' })],
    availableActions: ['broken'],
  });
  assert.equal(plan[0].rate, '0/1');
});

test('allPages keeps recipes with no entry point out of the page list', () => {
  const { pages, unkeyed } = allPages([
    recipe(),
    recipe({ page_type: 'action', recipe_name: 'stray', nav_method: 'ui_steps', nav_template: steps([{ action: 'click', selector: '#x' }]) }),
  ]);
  assert.equal(pages.length, 1);
  assert.equal(unkeyed.length, 1, 'a recipe that cannot be placed must be reported, not silently dropped');
});
