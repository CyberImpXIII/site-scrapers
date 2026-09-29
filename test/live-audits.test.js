// The live audits' CLASSIFICATION logic (audit.js params / working / fixed-params).
//
// These sweeps need a network and take minutes, so they cannot run in ./test.sh
// — but the part that does damage when wrong has nothing to do with driving
// Chrome. It is the verdict. A false LIAR sends someone to fix a recipe that
// works; a missed INERT lets a recipe keep answering the wrong question. That
// logic is tested here with an injected runner, so it is deterministic and fast.
//
// This matters because it already went wrong twice. The audit reported five
// recipes as LIAR when the real cause was browser contention (hence INFRA), and
// it reported a recipe verified at 39 records as a LIAR because it decided
// "needs parameters" by looking for the word "required" in schema prose.
//
// Run via `npm test` / `./test.sh`.

const test = require('node:test');
const assert = require('node:assert/strict');
const { auditWorking, auditParameters, auditFixedParams } = require('../audit');
const { openDb, upsertSite, insertField, deleteSite, getSite } = require('../db');
const { authorizeForTests } = require('../lib/writeGuard');

let db;
const created = [];

// A recipe with a known shape, so a verdict can be asserted against it rather
// than against whatever the real library happens to contain.
function fixture(name, overrides = {}) {
  const id = upsertSite(db, {
    hostname: 'liveaudit.test',
    page_type: 'listing',
    recipe_name: name,
    status: 'working',
    nav_method: 'url_param',
    nav_template: 'https://liveaudit.test/jobs',
    card_selector: 'li.card',
    notes: 'Test-only recipe for test/live-audits.test.js. Safe to delete if found stray.',
    ...overrides,
  });
  if (!created.includes(id)) created.push(id);
  insertField(db, id, { field_name: 'title', extract_kind: 'positional_segment', segment_index: 0 }, 0);
  return `liveaudit.test#listing:${name}`;
}

const find = (findings, target) => findings.find(f => f.recipe === target);

// A sweep visits every recipe in the library, so a fake runner keyed on a call
// COUNT would give different answers depending on what else happens to be in
// the DB. auditFixedParams works by swapping nav_template in place, so a runner
// that reads the current template decides exactly as a real run would, and does
// so independently of ordering.
const templateOf = target => getSite(db, 'liveaudit.test', 'listing', target.split(':')[1]).nav_template;

test.before(() => {
  authorizeForTests();
  db = openDb();
});

test.after(() => {
  for (const id of created) deleteSite(db, id);
});

// --- auditWorking ----------------------------------------------------------

test('a recipe returning records is ok; one returning none is a LIAR', async () => {
  const good = fixture('w_ok');
  const bad = fixture('w_liar');
  const findings = await auditWorking(db, {
    run: async target => (target === good ? { success: true, count: 12 } : { success: false, count: 0 }),
  });
  assert.equal(find(findings, good).result, 'ok');
  assert.equal(find(findings, bad).result, 'LIAR');
  assert.match(find(findings, bad).why, /claims working but returned no records/);
});

test('a browser failure is INFRA, never LIAR', async () => {
  // The verdict that matters most. Running two sweeps at once produced these
  // errors across five recipes that all returned records when run alone, and
  // calling them LIARs would send someone to fix working recipes.
  const target = fixture('w_infra');
  for (const error of [
    'Engine threw: Attempted to use detached Frame',
    'Engine threw: Execution context was destroyed',
    'Engine threw: Protocol error (Page.navigate): Target closed',
    'Engine threw: Session closed',
  ]) {
    const findings = await auditWorking(db, { run: async () => ({ success: false, count: 0, error }) });
    const f = find(findings, target);
    assert.equal(f.result, 'INFRA', `"${error}" should be INFRA, got ${f.result}`);
    assert.match(f.why, /BROWSER failed, not the recipe/);
    assert.match(f.why, /re-run this recipe alone/i, 'it has to say what to do next');
  }
});

test('an ordinary failure is still a LIAR, not INFRA', async () => {
  // The negative: INFRA must not become a catch-all that hides real breakage.
  const target = fixture('w_real_fail');
  const findings = await auditWorking(db, {
    run: async () => ({ success: false, count: 0, error: 'Waiting for selector `.card` failed: timeout' }),
  });
  assert.equal(find(findings, target).result, 'LIAR');
});

test('records that arrived past the deadline are PARTIAL, not a failure', async () => {
  const target = fixture('w_partial');
  const findings = await auditWorking(db, {
    run: async () => ({ success: false, count: 25, timedOut: true, partialResults: true }),
  });
  const f = find(findings, target);
  assert.equal(f.result, 'PARTIAL');
  assert.match(f.why, /raise ready_timeout_ms/);
});

test('a recipe whose template has unfillable placeholders is UNRUNNABLE', async () => {
  // Not a pass. The sweep could not exercise it at all, and reporting that as
  // ok would be a false clean bill of health.
  const target = fixture('w_unrunnable', { nav_template: 'https://liveaudit.test/role/{{role}}' });
  const findings = await auditWorking(db, { run: async () => ({ success: true, count: 5 }) });
  const f = find(findings, target);
  assert.equal(f.result, 'UNRUNNABLE');
  assert.match(f.why, /\{\{role\}\}/, 'it must name the placeholder it could not fill');
});

test('a placeholder the probe values DO supply is runnable', async () => {
  // The regression that called a recipe verified at 39 records a LIAR: the old
  // check looked for the word "required" in schema prose, which wellfound.com's
  // schema does not contain.
  const target = fixture('w_supplied', {
    nav_template: 'https://liveaudit.test/role/{{role}}',
    nav_params_schema: '{"role":"a role slug"}',
    param_probe_values: JSON.stringify([{ role: 'engineer' }, { role: 'sales' }]),
  });
  const findings = await auditWorking(db, { run: async () => ({ success: true, count: 39 }) });
  assert.equal(find(findings, target).result, 'ok');
});

test('only recipes claiming working are swept', async () => {
  const target = fixture('w_broken', { status: 'broken' });
  const findings = await auditWorking(db, { run: async () => ({ success: false, count: 0 }) });
  assert.equal(find(findings, target), undefined, 'a recipe already marked broken is not news');
});

// --- auditParameters -------------------------------------------------------

test('identical records for different params is INERT', async () => {
  // Worse than a broken recipe: it answers the wrong question confidently.
  const target = fixture('p_inert', {
    nav_params_schema: '{"q":"search terms"}',
    nav_template: 'https://liveaudit.test/jobs?q={{q}}',
    param_probe_values: JSON.stringify([{ q: 'sales' }, { q: 'engineer' }]),
  });
  const same = { success: true, count: 30, records: [{ href: '/a' }, { href: '/b' }] };
  const findings = await auditParameters(db, { run: async () => same });
  const f = find(findings, target);
  assert.equal(f.result, 'INERT');
  assert.match(f.why, /ignoring its parameters/);
});

test('two params that redirect to the same page is INCONCLUSIVE, not INERT', async () => {
  // Real case: remoteok.com was reported INERT for tags `customer-support` and
  // `support`, because the site redirects the second to the first. The two are
  // synonyms for one filter, so identical records prove nothing -- but INERT
  // says "the recipe ignores its parameters" and would have sent someone to
  // re-derive a recipe that works. The verdicts demand opposite work, so they
  // must not share a bucket.
  const target = fixture('p_aliased', {
    nav_params_schema: '{"tag":"a tag slug"}',
    nav_template: 'https://liveaudit.test/remote-{{tag}}-jobs',
    param_probe_values: JSON.stringify([{ tag: 'customer-support' }, { tag: 'support' }]),
  });
  const landed = {
    success: true,
    count: 50,
    url: 'https://liveaudit.test/remote-customer-support-jobs',
    records: [{ href: '/a' }, { href: '/b' }],
  };
  const f = find(await auditParameters(db, { run: async () => landed }), target);
  assert.equal(f.result, 'INCONCLUSIVE');
  assert.match(f.why, /synonyms for one filter/);
  assert.doesNotMatch(f.why, /ignoring its parameters/, 'it must not read as a broken recipe');
});

test('identical records from DIFFERENT urls is still INERT', async () => {
  // The other side of that boundary: when the two params really did reach
  // different pages and still produced identical records, the parameter is
  // being ignored and that IS the finding.
  const target = fixture('p_inert_urls', {
    nav_params_schema: '{"q":"search terms"}',
    nav_template: 'https://liveaudit.test/jobs?q={{q}}',
    param_probe_values: JSON.stringify([{ q: 'sales' }, { q: 'engineer' }]),
  });
  // Derived from the params, not a call counter: auditParameters sweeps every
  // fixture this file has created, so a counter is not scoped to this target
  // and its parity depends on test order.
  const f = find(
    await auditParameters(db, {
      run: async (_t, params) => ({
        success: true,
        count: 30,
        url: `https://liveaudit.test/jobs?q=${params.q}`,
        records: [{ href: '/a' }, { href: '/b' }],
      }),
    }),
    target
  );
  assert.equal(f.result, 'INERT');
  assert.match(f.why, /ignoring its parameters/);
});

test('different records for different params is ok', async () => {
  const target = fixture('p_ok', {
    nav_params_schema: '{"q":"search terms"}',
    nav_template: 'https://liveaudit.test/jobs?q={{q}}',
    param_probe_values: JSON.stringify([{ q: 'sales' }, { q: 'engineer' }]),
  });
  let n = 0;
  const findings = await auditParameters(db, {
    run: async () => ({ success: true, count: 2, records: [{ href: `/${n++}` }] }),
  });
  assert.equal(find(findings, target).result, 'ok');
});

test('an article recipe is counted by its record, not by count:0', async () => {
  // An article run puts its one record in `article` and leaves `count` at 0.
  // Reading `count` here made EVERY article recipe look like it returned
  // nothing on both runs: five false INCONCLUSIVEs in one real sweep, each
  // reading as "your probe URLs are dead" rather than "this audit measured the
  // wrong field". auditWorking special-cased articles and this did not, which
  // is why both now go through recordsOf().
  // page_type is left alone deliberately: the defect is in how the RESULT is
  // counted, not in the recipe, so the mocked run returning an article shape
  // is the whole condition being reproduced.
  const target = fixture('p_article', {
    nav_params_schema: '{"url":"the page"}',
    nav_template: 'https://liveaudit.test/job/{{url}}',
    param_probe_values: JSON.stringify([{ url: 'a' }, { url: 'b' }]),
  });
  let n = 0;
  const findings = await auditParameters(db, {
    run: async () => ({ success: true, count: 0, article: { title: `Job ${n++}` } }),
  });
  const f = find(findings, target);
  assert.equal(f.result, 'ok', 'two different articles is a working parameter, not an empty run');
  assert.equal(f.a.count, 1, 'the extracted record is counted');
});

test('two empty runs are INCONCLUSIVE, not a pass and not a failure', async () => {
  // Both returned nothing, so the comparison proves nothing either way. Calling
  // it ok would be a false clean bill; calling it INERT would be a false alarm.
  const target = fixture('p_inconclusive', {
    nav_params_schema: '{"q":"search terms"}',
    nav_template: 'https://liveaudit.test/jobs?q={{q}}',
    param_probe_values: JSON.stringify([{ q: 'zzz' }, { q: 'qqq' }]),
  });
  const findings = await auditParameters(db, { run: async () => ({ success: true, count: 0, records: [] }) });
  const f = find(findings, target);
  assert.equal(f.result, 'INCONCLUSIVE');
  assert.match(f.why, /pick probe values known to return records/);
});

test('a parameterised recipe with no probe values is UNVALIDATABLE', async () => {
  const target = fixture('p_novalues', {
    nav_params_schema: '{"q":"search terms"}',
    nav_template: 'https://liveaudit.test/jobs?q={{q}}',
  });
  const findings = await auditParameters(db, { run: async () => ({ success: true, count: 5, records: [] }) });
  const f = find(findings, target);
  assert.equal(f.result, 'UNVALIDATABLE');
  assert.match(f.fix, /param_probe_values/, 'it should name the command that fixes it');
});

test('a recipe declaring no parameters is not swept', async () => {
  const target = fixture('p_noparams', { nav_params_schema: '{}' });
  const findings = await auditParameters(db, { run: async () => ({ success: true, count: 5, records: [] }) });
  assert.equal(find(findings, target), undefined, 'there is nothing to validate');
});

// --- auditFixedParams ------------------------------------------------------

test('a hardcoded value that suppresses all results is an error', async () => {
  // The usajobs.gov case: rmi=true returned 0 where removing it returned 25,
  // and it survived a whole investigation because a hardcoded value is not a
  // parameter and so is invisible to every other check.
  const target = fixture('f_suppressor', {
    nav_template: 'https://liveaudit.test/jobs?k={{q}}&rmi=true',
    nav_params_schema: '{"q":"keywords"}',
    param_probe_values: JSON.stringify([{ q: 'nurse' }]),
  });
  const findings = await auditFixedParams(db, {
    run: async t => (t === target ? { count: /rmi=true/.test(templateOf(t)) ? 0 : 25 } : { count: 10 }),
  });
  const f = find(findings, target);
  assert.ok(f, 'the suppressing parameter should be reported');
  assert.equal(f.severity, 'error');
  assert.equal(f.param, 'rmi=true');
  assert.match(f.why, /SUPPRESSES ALL RESULTS/);
});

test('a hardcoded value that merely filters is reported as ok, never as a defect', async () => {
  // One-directional on purpose: a value that REDUCES results is usually doing
  // its job, and flagging it would train people to ignore the audit.
  //
  // It IS listed though, at severity ok. Reporting only defects made the
  // audit's output unreadable the first time it was really run: "0 findings"
  // could not be told apart from "it checked nothing", and this is a live
  // audit that skips any recipe it cannot exercise. Naming what was checked
  // is the difference between a clean bill and silence.
  const target = fixture('f_filter', {
    nav_template: 'https://liveaudit.test/jobs?k={{q}}&remote=1',
    nav_params_schema: '{"q":"keywords"}',
    param_probe_values: JSON.stringify([{ q: 'nurse' }]),
  });
  const findings = await auditFixedParams(db, {
    run: async t => (t === target ? { count: /remote=1/.test(templateOf(t)) ? 20 : 25 } : { count: 10 }),
  });
  const f = find(findings, target);
  assert.ok(f, 'the recipe must appear, so a clean run is distinguishable from an empty one');
  assert.equal(f.severity, 'ok', 'a small increase is an ordinary filter, not a defect');
  assert.equal(f.recordsWith, 20);
  assert.equal(f.recordsWithout, 25);
});

test('a recipe the audit could NOT exercise is absent, not silently ok', async () => {
  // The other half of making the output readable: "ok" has to mean checked.
  // A recipe with no probe values cannot be run, so it must not appear at all
  // rather than appear as fine.
  const target = fixture('f_unexercisable', {
    nav_template: 'https://liveaudit.test/jobs?k={{q}}&remote=1',
    nav_params_schema: '{"q":"keywords"}',
    // no param_probe_values, so {{q}} cannot be filled
  });
  const findings = await auditFixedParams(db, { run: async () => ({ count: 10 }) });
  assert.equal(find(findings, target), undefined, 'unexercisable must not read as clean');
});

test('the template is restored even when a run throws', async () => {
  // This audit rewrites nav_template in place to A/B it. A crash mid-sweep must
  // not leave a recipe silently altered — that would be the audit corrupting
  // the thing it audits.
  const target = fixture('f_restore', {
    nav_template: 'https://liveaudit.test/jobs?k={{q}}&rmi=true',
    nav_params_schema: '{"q":"keywords"}',
    param_probe_values: JSON.stringify([{ q: 'nurse' }]),
  });
  const before = getSite(db, 'liveaudit.test', 'listing', 'f_restore').nav_template;
  await auditFixedParams(db, {
    // Crash on the run made WHILE the template is swapped out — the exact
    // window in which a failure could leave the recipe rewritten.
    run: async t => {
      if (t !== target) return { count: 10 };
      if (!/rmi=true/.test(templateOf(t))) throw new Error('simulated crash mid-sweep');
      return { count: 0 };
    },
  }).catch(() => {});
  const after = getSite(db, 'liveaudit.test', 'listing', 'f_restore').nav_template;
  assert.equal(after, before, 'nav_template must be restored regardless of how the run ended');
});

// --- a recipe vanishing mid-sweep ------------------------------------------

test('a recipe deleted mid-sweep is skipped, not a crash', async () => {
  // "List the recipes, then load each one" is not atomic, and a live sweep runs
  // for minutes. A recipe deleted or renamed under it used to make getSite
  // return undefined and kill the whole sweep on `site.hostname`, throwing away
  // every result gathered so far. Found because two test files running in
  // parallel did exactly this.
  // The names matter: listSites orders by recipe_name, so "w_survives" is
  // always visited before "w_vanishes" and the delete lands in the window
  // between the list and the load. Renaming either breaks the setup, not the
  // behaviour.
  const survivor = fixture('w_survives');
  const doomed = fixture('w_vanishes');
  const id = getSite(db, 'liveaudit.test', 'listing', 'w_vanishes').id;
  let deleted = false;
  const findings = await auditWorking(db, {
    run: async () => {
      if (!deleted) {
        deleteSite(db, id); // disappears while the sweep is still walking the list
        deleted = true;
      }
      return { success: true, count: 3 };
    },
  });
  assert.ok(deleted, 'the test must actually have deleted something');
  assert.equal(find(findings, doomed), undefined, 'the deleted recipe is simply absent');
  assert.equal(find(findings, survivor).result, 'ok', 'the sweep continues past it');
});

test('a template with no hardcoded values is skipped', async () => {
  const target = fixture('f_none', {
    nav_template: 'https://liveaudit.test/jobs?k={{q}}',
    nav_params_schema: '{"q":"keywords"}',
    param_probe_values: JSON.stringify([{ q: 'nurse' }]),
  });
  const findings = await auditFixedParams(db, { run: async () => ({ count: 10 }) });
  assert.equal(find(findings, target), undefined, 'there is no hardcoded value to A/B');
});
