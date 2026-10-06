// Exhaustive coverage of the status state machine (lib/verdict.js).
//
// This exists because the rule it encodes was once violated in exactly the way
// a test would have caught: "blocked" means a person alone is sufficient, and
// the inline version of this logic awarded it on mere wall detection, with no
// attended run ever performed. Every input combination is asserted here rather
// than a representative sample, because the whole point is that no path can
// quietly award an earned status.
//
// Run via `npm test` / `./test.sh`.

const test = require('node:test');
const assert = require('node:assert/strict');
const { decideVerdict, isWritableStatus, HAND_SETTABLE, EARNED_BY_RUN } = require('../lib/verdict');

// --- The invariant that was actually broken --------------------------------

test('an UNATTENDED run can never award "blocked", whatever it saw', () => {
  // "blocked" asserts a person is sufficient. Nothing unattended can know that.
  for (const wall of [null, [], ['cloudflare'], ['login_wall', 'captcha_widget']]) {
    for (const extracted of [true, false]) {
      for (const alreadyProven of [true, false]) {
        const v = decideVerdict({ extracted, wall, attended: false, alreadyProven });
        assert.notEqual(
          v,
          'blocked',
          `unattended run awarded "blocked" for wall=${JSON.stringify(wall)} extracted=${extracted}`
        );
      }
    }
  }
});

test('only an attended run that RETURNED RECORDS can award "blocked"', () => {
  assert.equal(decideVerdict({ extracted: true, wall: ['cloudflare'], attended: true }), 'blocked');
  // Attended but empty: the person's presence was not enough.
  assert.equal(decideVerdict({ extracted: false, wall: ['cloudflare'], attended: true }), 'blocked-attn');
});

// --- Unattended paths ------------------------------------------------------

test('unattended: records means working, regardless of anything else', () => {
  assert.equal(decideVerdict({ extracted: true, wall: null }), 'working');
  assert.equal(decideVerdict({ extracted: true, wall: ['cloudflare'] }), 'working',
    'a wall that did not stop us returning records did not stop us');
  assert.equal(decideVerdict({ extracted: true, alreadyProven: true }), 'working');
});

test('unattended: a wall with no records parks the work rather than judging it', () => {
  assert.equal(decideVerdict({ extracted: false, wall: ['cloudflare'] }), 'blocked-attn');
  assert.equal(decideVerdict({ extracted: false, wall: ['login_wall'] }), 'blocked-attn');
  // Even a previously-working recipe: a wall is new information that needs a
  // person, not a reason to call the recipe fine.
  assert.equal(decideVerdict({ extracted: false, wall: ['datadome'], alreadyProven: true }), 'blocked-attn');
});

test('unattended: no wall and no records demotes only an unproven definition', () => {
  assert.equal(decideVerdict({ extracted: false, wall: null, alreadyProven: false }), 'broken');
  // A definition that has produced records before gets the benefit of the
  // doubt: an empty run is most often a query that matched nothing.
  assert.equal(decideVerdict({ extracted: false, wall: null, alreadyProven: true }), 'inconclusive');
});

test('a run that landed on NOT-THE-PAGE writes no status, whatever else it saw', () => {
  // expect_url failed (lib/notThePage.js): a closed posting, say. Nothing about
  // the recipe was tested, so neither "broken" nor any earned status.
  for (const attended of [false, true]) {
    for (const alreadyProven of [false, true]) {
      for (const wall of [null, ['cloudflare']]) {
        assert.equal(decideVerdict({ extracted: false, wall, attended, alreadyProven, notThePage: true }), 'inconclusive');
      }
    }
  }
  // The counterfactual: the same run without the flag is demoted.
  assert.equal(decideVerdict({ extracted: false, wall: null, alreadyProven: false }), 'broken');
});

test('a run FORWARDED off the site writes no status, whatever else it saw', () => {
  // lib/forwarded.js: records are null, the board was never read. Before
  // 2026-10-06 an unproven definition read as "broken" on such a run.
  for (const attended of [false, true]) {
    for (const alreadyProven of [false, true]) {
      for (const wall of [null, ['cloudflare']]) {
        assert.equal(decideVerdict({ extracted: false, wall, attended, alreadyProven, forwarded: true }), 'inconclusive');
      }
    }
  }
});

// --- Attended paths --------------------------------------------------------

test('attended with records and no wall means the recipe simply works', () => {
  assert.equal(decideVerdict({ extracted: true, wall: null, attended: true }), 'working');
  assert.equal(decideVerdict({ extracted: true, wall: [], attended: true }), 'working');
});

test('attended and empty is always blocked-attn, never broken', () => {
  // Distinct from the unattended case: a person WAS there and it still failed,
  // so this is known to need real work — but the useful signal is "escalated
  // and still stuck", which is what blocked-attn says.
  for (const alreadyProven of [true, false]) {
    for (const wall of [null, ['cloudflare']]) {
      assert.equal(decideVerdict({ extracted: false, wall, attended: true, alreadyProven }), 'blocked-attn');
    }
  }
});

// --- Input shape tolerance -------------------------------------------------

test('wall accepts null, an empty array, a populated array or a bare truthy value', () => {
  assert.equal(decideVerdict({ extracted: false, wall: [] }), 'broken', 'an empty array is not a wall');
  assert.equal(decideVerdict({ extracted: false, wall: null }), 'broken');
  assert.equal(decideVerdict({ extracted: false, wall: 'cloudflare' }), 'blocked-attn', 'a bare string counts');
  assert.equal(decideVerdict({ extracted: false, wall: ['x'] }), 'blocked-attn');
});

test('every verdict is either writable or explicitly a report', () => {
  assert.equal(isWritableStatus('inconclusive'), false, 'inconclusive means leave the status alone');
  for (const v of ['working', 'blocked', 'blocked-attn', 'broken']) {
    assert.equal(isWritableStatus(v), true);
  }
});

// --- The gate the state machine exists to protect -------------------------

test('earned and hand-settable statuses do not overlap', () => {
  for (const s of EARNED_BY_RUN) {
    assert.ok(!HAND_SETTABLE.includes(s), `${s} must not be hand-settable — it is a claim about reality`);
  }
  // blocked-attn is deliberately on the cautious side of the line: nothing can
  // detect "the agent is out of moves", and being wrong about it only parks
  // work rather than claiming success.
  assert.ok(HAND_SETTABLE.includes('blocked-attn'));
  assert.ok(EARNED_BY_RUN.includes('blocked'), 'blocked is the one this whole file exists to protect');
  assert.ok(EARNED_BY_RUN.includes('working'));
});
