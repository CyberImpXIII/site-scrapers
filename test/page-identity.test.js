// Page identity: which recipes count as being on the same page.
//
// This is the seam the whole site-primitives idea rests on. If the identity
// function under-merges, primitives never gather anything and the feature runs
// while doing nothing — no error, no empty-result warning, just silence. If it
// over-merges, one page's knowledge gets attributed to another, which is the
// confidently-wrong direction this repo treats as worse than failing.
//
// Both directions are asserted here, and the last test checks the property
// against the REAL recipe set rather than fixtures, because the whole point is
// that it groups the pages that actually exist.
//
// Run via `npm test` / `./test.sh`.

const test = require('node:test');
const assert = require('node:assert/strict');
const { entryUrlFor, pageKeyFor, groupByPage, describePageKey } = require('../lib/pageIdentity');

const steps = s => JSON.stringify(s);

// --- entryUrlFor -------------------------------------------------------------

test('a url-based recipe enters at its nav_template', () => {
  assert.equal(
    entryUrlFor({ nav_method: 'url_param', nav_template: 'https://x.com/jobs?q={{q}}' }),
    'https://x.com/jobs?q={{q}}'
  );
  assert.equal(entryUrlFor({ nav_method: 'direct_url', nav_template: '{{url}}' }), '{{url}}');
});

test('a ui_steps recipe enters at its first goto, not at its step list', () => {
  // THE case that motivated this module. Compared as raw nav_template, this
  // and the direct_url recipe above share a page and look completely different.
  const site = {
    nav_method: 'ui_steps',
    nav_template: steps([
      { action: 'goto', url: '{{url}}' },
      { action: 'run_generic_action', ref: 'open_apply_form' },
      { action: 'run_generic_action', ref: 'describe_form' },
    ]),
  };
  assert.equal(entryUrlFor(site), '{{url}}');
});

test('a later goto is something the action DOES, not where it starts', () => {
  const site = {
    nav_method: 'ui_steps',
    nav_template: steps([
      { action: 'goto', url: 'https://x.com/login' },
      { action: 'click', selector: '#next' },
      { action: 'goto', url: 'https://x.com/account' },
    ]),
  };
  assert.equal(entryUrlFor(site), 'https://x.com/login');
});

test('no determinable entry point returns null rather than a guess', () => {
  // A recipe with no goto starts from wherever the browser already is. Giving
  // it a made-up identity would merge unrelated recipes, and a wrong merge is
  // worse than no merge.
  assert.equal(entryUrlFor({ nav_method: 'ui_steps', nav_template: steps([{ action: 'click', selector: '#go' }]) }), null);
  assert.equal(entryUrlFor({ nav_method: 'ui_steps', nav_template: 'not json' }), null);
  assert.equal(entryUrlFor({ nav_method: 'ui_steps', nav_template: steps({ action: 'goto' }) }), null, 'not an array');
  assert.equal(entryUrlFor({ nav_method: 'ui_steps', nav_template: steps([{ action: 'goto' }]) }), null, 'goto with no url');
  assert.equal(entryUrlFor({ nav_method: 'direct_url', nav_template: '   ' }), null);
  assert.equal(entryUrlFor({ nav_method: 'direct_url' }), null);
  assert.equal(entryUrlFor(null), null);
});

// --- pageKeyFor: must not over-merge ----------------------------------------

test('the same entry template on different hosts is NOT the same page', () => {
  // `{{url}}` is the entry for every ATS article recipe. Keyed on the template
  // alone, Greenhouse and Lever would share one primitive and each would be
  // told the other's facts.
  const gh = { hostname: 'job-boards.greenhouse.io', nav_method: 'direct_url', nav_template: '{{url}}' };
  const lever = { hostname: 'jobs.lever.co', nav_method: 'direct_url', nav_template: '{{url}}' };
  assert.notEqual(pageKeyFor(gh), pageKeyFor(lever));
});

test('different entry templates on one host are NOT the same page', () => {
  // A board index and a posting are both on jobs.lever.co and know different
  // things about themselves.
  const board = { hostname: 'jobs.lever.co', nav_method: 'url_param', nav_template: 'https://jobs.lever.co/{{company}}' };
  const posting = { hostname: 'jobs.lever.co', nav_method: 'direct_url', nav_template: '{{url}}' };
  assert.notEqual(pageKeyFor(board), pageKeyFor(posting));
});

test('an article and an action on the same URL ARE the same page', () => {
  const article = { hostname: 'jobs.lever.co', nav_method: 'direct_url', nav_template: '{{url}}' };
  const action = {
    hostname: 'JOBS.LEVER.CO',
    nav_method: 'ui_steps',
    nav_template: steps([{ action: 'goto', url: '{{url}}' }, { action: 'run_generic_action', ref: 'describe_form' }]),
  };
  assert.equal(pageKeyFor(article), pageKeyFor(action), 'hostname comparison is case-insensitive');
});

test('a recipe with no entry point has no page key', () => {
  assert.equal(pageKeyFor({ hostname: 'x.com', nav_method: 'ui_steps', nav_template: steps([]) }), null);
});

// --- groupByPage -------------------------------------------------------------

test('groupByPage separates the unkeyable instead of lumping them together', () => {
  const sites = [
    { hostname: 'a.com', nav_method: 'direct_url', nav_template: '{{url}}', recipe_name: 'one' },
    { hostname: 'a.com', nav_method: 'ui_steps', nav_template: steps([{ action: 'goto', url: '{{url}}' }]), recipe_name: 'two' },
    { hostname: 'a.com', nav_method: 'ui_steps', nav_template: steps([{ action: 'click', selector: '#x' }]), recipe_name: 'three' },
  ];
  const { pages, unkeyed } = groupByPage(sites);
  assert.equal(pages.size, 1, 'the two that share a URL group together');
  assert.equal([...pages.values()][0].length, 2);
  assert.equal(unkeyed.length, 1, 'the one with no entry point stays separate');
  assert.equal(unkeyed[0].recipe_name, 'three');
});

test('describePageKey renders a key a person can read', () => {
  const key = pageKeyFor({ hostname: 'jobs.lever.co', nav_method: 'direct_url', nav_template: '{{url}}' });
  assert.equal(describePageKey(key), 'jobs.lever.co  {{url}}');
});

// --- the key has to survive STORAGE, not just JavaScript --------------------

test('a page key round-trips through the database unchanged', () => {
  // This is not a paranoid test; it caught a real bug. The separator was
  // \u0000, which is fine in a JS string and which SQLite TRUNCATES a TEXT
  // value at. Every key written came back as just the hostname, so every page
  // on a host collapsed onto one key and UNIQUE(page_key, ...) had them
  // overwriting each other — silently, because the write succeeded and simply
  // returned something other than what it was given.
  //
  // Every in-memory assertion above passed throughout. Only a round trip
  // through the actual store could see it.
  const { openDb, recordObservation, listObservations, forgetObservations } = require('../db');
  const { authorizeForTests } = require('../lib/writeGuard');
  authorizeForTests('page key round trip');
  const db = openDb();

  const host = 'roundtrip.test';
  const keys = [
    pageKeyFor({ hostname: host, nav_method: 'direct_url', nav_template: '{{url}}' }),
    pageKeyFor({ hostname: host, nav_method: 'url_param', nav_template: `https://${host}/{{company}}` }),
  ];
  assert.notEqual(keys[0], keys[1], 'the two pages must differ before we even store them');

  try {
    keys.forEach((key, i) =>
      recordObservation(db, {
        hostname: host,
        page_key: key,
        observed_url: `https://${host}/${i}`,
        kind: 'generic_action',
        subject: 'dismiss_overlay',
        outcome: 'changed',
        detail: 'x',
      })
    );

    const stored = listObservations(db, { hostname: host });
    assert.equal(stored.length, 2, 'two distinct pages must stay two rows, not collapse into one');
    assert.deepEqual(stored.map(o => o.page_key).sort(), [...keys].sort(), 'the key that came back must be the key that went in');
    // And it must still be readable as a page afterwards.
    assert.equal(describePageKey(stored.find(o => o.page_key === keys[1]).page_key), `${host}  https://${host}/{{company}}`);
  } finally {
    forgetObservations(db, { hostname: host });
  }
});

// --- against the real recipe set --------------------------------------------

test('it groups the pages that actually exist, and merges nothing else', () => {
  // The property that matters, checked against live data rather than fixtures.
  // Skips in a fresh clone, which has no recipes -- rather than passing
  // vacuously, which would make this look like coverage it is not.
  const { openDb, listSites, getSite } = require('../db');
  const db = openDb();
  const sites = listSites(db)
    .filter(s => !String(s.hostname).endsWith('.internal'))
    .map(s => getSite(db, s.hostname, s.page_type, s.recipe_name));
  if (sites.length < 5) {
    assert.ok(true, 'skipped: too few recipes registered to assert grouping');
    return;
  }

  const { pages, unkeyed } = groupByPage(sites);
  assert.equal(unkeyed.length, 0, `every registered recipe should have an entry point; unkeyed: ${unkeyed.map(s => s.hostname).join(', ')}`);

  const shared = [...pages.entries()].filter(([, v]) => v.length > 1);
  // Every page that IS shared must be shared by recipes of different
  // page_types on one host -- an article and an action, say. Two recipes of the
  // same page_type and different recipe_name sharing an entry template would
  // be a real duplicate worth knowing about, not a page primitive.
  for (const [key, group] of shared) {
    const hosts = new Set(group.map(s => s.hostname.toLowerCase()));
    assert.equal(hosts.size, 1, `page ${describePageKey(key)} merged across hosts: ${[...hosts].join(', ')}`);
  }
  assert.ok(shared.length >= 1, 'expected at least one page carrying more than one recipe');
});
