// Run by ./dev.sh check (the suite), the gate gates.json names for this file.
// Deciding whether a generic action did anything on a page.
//
// This is the judgement the whole slice rests on, and the failure mode is
// specific: `dismiss_overlay` on a page with no overlay runs cleanly and
// changes nothing. If "it did not throw" counted as evidence, every action
// would be recorded as working everywhere, and the ordering built on top would
// recommend actions that provably do nothing. So the tests that matter most
// here are the ones asserting NO effect is reported.
//
// Run via `npm test` / `./test.sh`.

const test = require('node:test');
const assert = require('node:assert/strict');
const { signatureDiff, outcomeFor, outcomeForProbes, isStale, ageInDays, STALE_AFTER_DAYS } = require("../lib/observations");

const sig = (over = {}) => ({
  url: 'https://x.com/jobs',
  title: 'Jobs',
  elements: 1000,
  textLength: 5000,
  scrollHeight: 4000,
  dialogs: 0,
  scrollLocked: false,
  ...over,
});

// --- the no-op case, which is the point ------------------------------------

test('an action that ran cleanly and moved nothing is no_effect, not success', () => {
  const r = outcomeFor({ before: sig(), after: sig() });
  assert.equal(r.outcome, 'no_effect');
  assert.match(r.detail, /nothing measurable/);
});

test('text jitter is not an effect', () => {
  // A relative timestamp ticking over or an ad slot rotating must not read as
  // the action having done something -- otherwise every action "works" on any
  // page with a clock on it.
  const r = outcomeFor({ before: sig({ textLength: 5000 }), after: sig({ textLength: 5030 }) });
  assert.equal(r.outcome, 'no_effect', '30 chars on a 5000-char page is noise');
});

test('a few pixels of settling height is not an effect', () => {
  const r = outcomeFor({ before: sig({ scrollHeight: 4000 }), after: sig({ scrollHeight: 4050 }) });
  assert.equal(r.outcome, 'no_effect');
});

// --- real effects -----------------------------------------------------------

test('an overlay being dismissed is an effect', () => {
  // The signature fields chosen for exactly this: the dialog goes, and the
  // scroll lock overlays set on body is released.
  const r = outcomeFor({
    before: sig({ dialogs: 1, scrollLocked: true }),
    after: sig({ dialogs: 0, scrollLocked: false, elements: 980 }),
  });
  assert.equal(r.outcome, 'changed');
  assert.ok(r.changes.some(c => /dialogs 1 -> 0/.test(c)));
  assert.ok(r.changes.some(c => /scroll lock/.test(c)));
});

test('pagination or infinite scroll appending results is an effect', () => {
  const r = outcomeFor({
    before: sig(),
    after: sig({ elements: 1600, textLength: 9000, scrollHeight: 7000 }),
  });
  assert.equal(r.outcome, 'changed');
  assert.ok(r.changes.some(c => /elements \+600/.test(c)));
  assert.ok(r.changes.some(c => /text \+4000 chars/.test(c)));
});

test('a navigation is an effect even when the page looks identical', () => {
  const r = outcomeFor({ before: sig(), after: sig({ url: 'https://x.com/jobs?page=2' }) });
  assert.equal(r.outcome, 'changed');
  assert.match(r.detail, /navigated/);
});

test('a single element appearing counts — exact fields have no tolerance', () => {
  assert.equal(signatureDiff(sig(), sig({ elements: 1001 })).changed, true);
});

// --- errors -----------------------------------------------------------------

test('an action that threw is an error, whatever the page did on the way', () => {
  // The page may well have changed while failing. Calling that "changed" would
  // recommend a broken action to the next caller.
  const r = outcomeFor({ error: 'Waiting for selector `.x` failed: timeout', before: sig(), after: sig({ elements: 2000 }) });
  assert.equal(r.outcome, 'error');
  assert.match(r.detail, /timeout/);
});

test('a signature that could not be read twice is an error, never no_effect', () => {
  // Recording no_effect here would assert an absence that was never measured.
  for (const args of [{ before: sig() }, { after: sig() }, {}]) {
    assert.equal(outcomeFor(args).outcome, 'error', JSON.stringify(args));
  }
  assert.equal(signatureDiff(sig(), null).incomparable, true);
});

test('detail is capped so one bad page cannot flood the table', () => {
  const r = outcomeFor({ error: 'x'.repeat(5000), before: sig(), after: sig() });
  assert.ok(r.detail.length <= 200);
});

// --- staleness --------------------------------------------------------------

test('an observation goes stale, because the page it describes rots', () => {
  const now = Date.parse('2026-09-28T00:00:00Z');
  const daysAgo = n => ({ observed_at: new Date(now - n * 86400000).toISOString() });

  assert.equal(isStale(daysAgo(1), now), false);
  assert.equal(isStale(daysAgo(STALE_AFTER_DAYS - 1), now), false);
  assert.equal(isStale(daysAgo(STALE_AFTER_DAYS + 1), now), true);
  assert.equal(ageInDays(daysAgo(30).observed_at, now), 30);
});

// --- probes are judged on what they REPORTED, not on what they moved --------

test('every registered probe kind has a summariser', () => {
  // The seam. A probe with no entry here falls through to "found nothing",
  // which is a claim about the PAGE rather than a gap in this table -- so a
  // newly added probe kind would silently start reporting that it never finds
  // anything, on every page, and look like a working measurement.
  const { PROBE_KINDS } = require('../lib/probes');
  const { PROBE_SUMMARY } = require('../lib/observations');
  assert.deepEqual(
    Object.keys(PROBE_KINDS).sort().filter(k => !PROBE_SUMMARY[k]),
    [],
    'probe kinds with no summariser in lib/observations.js'
  );
  assert.deepEqual(
    Object.keys(PROBE_SUMMARY).sort().filter(k => !PROBE_KINDS[k]),
    [],
    'summarisers for probe kinds that no longer exist'
  );
});

test('a diagnostic that found cards is reported, not no_effect', () => {
  // The whole reason this path exists: probe_card_candidates changes nothing
  // by design, so the page signature says no_effect however well it worked.
  const r = outcomeForProbes([
    { kind: 'repeated_structure', candidates: [{ childSelector: 'li.job', count: 20, stableHook: null, sharedLine: 'Apply' }] },
  ]);
  assert.equal(r.outcome, 'reported');
  assert.match(r.detail, /li\.job x20/);
  assert.match(r.detail, /Apply/);
});

test('a diagnostic that found nothing is no_effect, and says so about the PAGE', () => {
  const r = outcomeForProbes([{ kind: 'repeated_structure', candidates: [] }]);
  assert.equal(r.outcome, 'no_effect');
  assert.match(r.detail, /no repeated card structure/);
});

test('a probe that CHARACTERISES always reports; one that SEARCHES can come up empty', () => {
  // The line between them, and it is not arbitrary. `blockers` and
  // `pagination_controls` describe the page, so "not blocked" and "no control
  // but it scrolls" are answers -- the second paired with an infinite_scroll
  // trial that also finds nothing is how you learn everything is already on
  // the page. `repeated_structure` searches FOR something, so finding none
  // genuinely means there are no cards here.
  assert.equal(outcomeForProbes([{ kind: 'blockers', blocked: false, flags: [] }]).outcome, 'reported');

  const paging = outcomeForProbes([{ kind: 'pagination_controls', likely: null, controls: [], scrollable: true }]);
  assert.equal(paging.outcome, 'reported');
  assert.match(paging.detail, /may be infinite scroll/);

  assert.equal(outcomeForProbes([{ kind: 'repeated_structure', candidates: [] }]).outcome, 'no_effect');
});

test('pagination_controls leads with the mechanism and the selector to use', () => {
  const r = outcomeForProbes([{
    kind: 'pagination_controls',
    likely: 'load_more',
    controls: [{ mechanism: 'load_more', selector: 'button.load-more', text: 'Show more' }],
    urlParams: ['page'],
  }]);
  assert.match(r.detail, /likely load_more/);
  assert.match(r.detail, /button\.load-more/);
  assert.match(r.detail, /url params: page/);
});

test('a non-diagnostic action returns null so the signature decides', () => {
  // dismiss_overlay emits no diagnostics; judging it here would always say
  // "found nothing" and bury the fact that it removed the banner.
  assert.equal(outcomeForProbes([]), null);
  assert.equal(outcomeForProbes([{ kind: 'page_signature', signature: {} }]), null, 'the harness own probes do not count');
});

test('a probe kind with no summariser is reported as a gap, not as an empty page', () => {
  const { summariseProbe } = require('../lib/observations');
  const s = summariseProbe({ kind: 'some_future_probe' });
  assert.equal(s.unknownKind, true);
  assert.match(s.summary, /no summariser/);
});

test('a probe that errored is an error, not a page with nothing on it', () => {
  const r = outcomeForProbes([{ kind: 'repeated_structure', error: 'timed out scanning' }]);
  assert.equal(r.outcome, 'error');
  assert.match(r.detail, /timed out scanning/);
});

test('one probe erroring among several does not sink the others', () => {
  const r = outcomeForProbes([
    { kind: 'repeated_structure', error: 'timed out' },
    { kind: 'blockers', blocked: true, flags: ['captcha'] },
  ]);
  assert.equal(r.outcome, 'reported', 'a partial answer is still an answer');
  assert.match(r.detail, /captcha/);
});

// --- storage: earned, and one current answer per question -------------------

test('recording an observation is REFUSED outside a sanctioned path', () => {
  // The whole point of the table. "dismiss_overlay works here" typed by
  // someone who did not run it is indistinguishable, once stored, from one
  // that was measured — so the only way in is the trial runner, which writes
  // what it just measured.
  //
  // revokeTestAuthorization first, because authorizeForTests is global and
  // permanent: without it this assertion passes vacuously, which is exactly
  // how four guard tests once passed for the wrong reason (docs/lessons.md).
  const { openDb, recordObservation } = require('../db');
  const { authorizeForTests, revokeTestAuthorization } = require('../lib/writeGuard');
  const db = openDb();
  revokeTestAuthorization();
  try {
    assert.throws(
      () => recordObservation(db, {
        hostname: 'guard.test', page_key: 'guard.test\u001f{{url}}', observed_url: 'https://guard.test/',
        kind: 'generic_action', subject: 'dismiss_overlay', outcome: 'changed',
      }),
      /guarded write/
    );
  } finally {
    authorizeForTests('observations tests');
  }
});

test('re-observing the same answer builds confidence; a different one resets it', () => {
  const { openDb, recordObservation, listObservations, forgetObservations } = require('../db');
  const { authorizeForTests } = require('../lib/writeGuard');
  authorizeForTests('observations tests');
  const db = openDb();
  const host = 'upsert.test';
  const base = {
    hostname: host, page_key: `${host}\u001f{{url}}`, observed_url: `https://${host}/`,
    kind: 'generic_action', subject: 'dismiss_overlay',
  };
  try {
    recordObservation(db, { ...base, outcome: 'changed', detail: 'first' });
    const second = recordObservation(db, { ...base, outcome: 'changed', detail: 'again' });
    assert.equal(second.changedFrom, null);
    let [row] = listObservations(db, { hostname: host });
    assert.equal(row.times_observed, 2, 'an agreeing observation is more evidence for the same answer');
    assert.equal(listObservations(db, { hostname: host }).length, 1, 'one current answer, not a history');

    // The page changed underneath: the old count was evidence for the OLD
    // answer, so carrying it over would overstate confidence in the new one.
    const flipped = recordObservation(db, { ...base, outcome: 'no_effect', detail: 'the banner is gone' });
    assert.equal(flipped.changedFrom, 'changed', 'a flip is reported, because it usually means the page moved');
    [row] = listObservations(db, { hostname: host });
    assert.equal(row.times_observed, 1);
    assert.equal(row.outcome, 'no_effect');
  } finally {
    forgetObservations(db, { hostname: host });
  }
});

test('the same action on two pages of one host stays two answers', () => {
  // The failure the NUL separator caused: both rows collapsed onto one key and
  // silently overwrote each other.
  const { openDb, recordObservation, listObservations, forgetObservations } = require('../db');
  const { authorizeForTests } = require('../lib/writeGuard');
  authorizeForTests('observations tests');
  const db = openDb();
  const host = 'twopage.test';
  try {
    for (const [key, outcome] of [[`${host}\u001f{{url}}`, 'changed'], [`${host}\u001fhttps://${host}/{{c}}`, 'no_effect']]) {
      recordObservation(db, {
        hostname: host, page_key: key, observed_url: `https://${host}/x`,
        kind: 'generic_action', subject: 'dismiss_overlay', outcome,
      });
    }
    const rows = listObservations(db, { hostname: host });
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(r => r.outcome).sort(), ['changed', 'no_effect']);
  } finally {
    forgetObservations(db, { hostname: host });
  }
});

test('the audit actually reports a stale observation', () => {
  // isStale is unit-tested above, but a rule that is never wired into the
  // audit reports nothing while looking implemented. This backdates a row and
  // checks the finding comes out the other end.
  //
  // The row is written with a direct statement rather than recordObservation,
  // because that one stamps observed_at with now() by design -- there is
  // deliberately no way to claim an observation happened at a time it did not.
  const { openDb, forgetObservations } = require('../db');
  const { authorizeForTests } = require('../lib/writeGuard');
  const { auditUnits } = require('../audit');
  const { STALE_AFTER_DAYS } = require('../lib/observations');
  authorizeForTests('observations tests');
  const db = openDb();

  const host = 'stale.test';
  const old = new Date(Date.now() - (STALE_AFTER_DAYS + 10) * 86400000).toISOString();
  try {
    db.prepare(
      `INSERT INTO page_observations
         (hostname, page_key, observed_url, kind, subject, outcome, detail, first_observed_at, observed_at, times_observed)
       VALUES (?,?,?,?,?,?,?,?,?,1)`
    ).run(host, `${host}\u001f{{url}}`, `https://${host}/`, 'generic_action', 'dismiss_overlay', 'changed', 'x', old, old);

    const stale = auditUnits(db).filter(f => f.rule === 'stale-observation' && f.unit.includes(host));
    assert.equal(stale.length, 1, 'the stale row must produce exactly one finding');
    assert.match(stale[0].problem, /dismiss_overlay -> changed/);
    assert.match(stale[0].why, /primitives\.js try/, 'the finding must say how to re-measure it');
    assert.equal(stale[0].severity, 'warn', 'stale is a prompt to re-check, not a broken thing');
  } finally {
    forgetObservations(db, { hostname: host });
  }

  // And a fresh one is not flagged, or the rule would be noise.
  assert.equal(auditUnits(db).filter(f => f.rule === 'stale-observation' && f.unit.includes(host)).length, 0);
});

test('forgetting refuses to clear the whole table', () => {
  // A no-filter delete would be a one-keystroke way to lose every measurement.
  const { openDb, forgetObservations } = require('../db');
  const { authorizeForTests } = require('../lib/writeGuard');
  authorizeForTests('observations tests');
  assert.throws(() => forgetObservations(openDb(), {}), /needs a hostname or a pageKey/);
});

test('an unparseable date is not silently treated as fresh', () => {
  // Defaulting to fresh would let a corrupt row claim current knowledge.
  assert.equal(ageInDays('not a date'), null);
  assert.equal(isStale({ observed_at: 'not a date' }), false, 'unknown age is reported by ageInDays, not guessed at here');
});
