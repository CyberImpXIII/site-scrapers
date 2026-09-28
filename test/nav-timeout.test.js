// How long a navigation is allowed, derived from the recipe's own
// ready_timeout_ms (engine.js navTimeoutFor).
//
// Puppeteer's 30s default used to be hardcoded at every page.goto, which
// silently contradicted the one knob a recipe has for saying "this site is
// slow". builtin.com declares ready_timeout_ms 60000 because its content
// arrives past 40s, and would still have died at 30 seconds while NAVIGATING —
// surfacing as "Navigation timeout of 30000 ms exceeded" with failedStep null,
// an error naming neither the recipe nor a step, and leaving the advice "raise
// the goto timeout" impossible to act on because there was no knob.
//
// Not tested here: that a navigation actually survives past 30s. That test
// would cost 30 seconds of wall clock to assert one number reached Puppeteer,
// which is not worth it in a suite meant to run before every commit. What IS
// worth guarding is the derivation, where a quiet NaN would disable every
// timeout in the engine at once.
//
// Run via `npm test` / `./test.sh`.

const test = require('node:test');
const assert = require('node:assert/strict');
const { navTimeoutFor, DEFAULT_NAV_TIMEOUT_MS } = require('../engine');

test('a slow recipe gets a proportionally slow navigation', () => {
  assert.equal(navTimeoutFor(60000), 60000, "builtin.com's 60s must reach the navigation, not just the content wait");
  assert.equal(navTimeoutFor(45000), 45000);
});

test('a fast recipe is never given a SHORTER navigation than the default', () => {
  // The direction matters. A short ready_timeout_ms says "the content appears
  // quickly", not "the page must arrive quickly" — most recipes sit at 20-25s
  // and shortening their navigation on that basis would break working recipes
  // to fix none.
  assert.equal(navTimeoutFor(20000), DEFAULT_NAV_TIMEOUT_MS);
  assert.equal(navTimeoutFor(1), DEFAULT_NAV_TIMEOUT_MS);
  assert.equal(navTimeoutFor(0), DEFAULT_NAV_TIMEOUT_MS);
});

test('a missing or unusable value falls back rather than producing NaN', () => {
  // Math.max(30000, NaN) is NaN, and Puppeteer reads a NaN timeout as "no
  // timeout" — every navigation in the engine would hang forever instead of
  // failing, which is the worst available outcome and an invisible one.
  for (const bad of [undefined, null, '', 'soon', NaN, {}, []]) {
    assert.equal(
      navTimeoutFor(bad),
      DEFAULT_NAV_TIMEOUT_MS,
      `navTimeoutFor(${JSON.stringify(bad)}) must fall back, got ${navTimeoutFor(bad)}`
    );
  }
});

test('a numeric string works, since a DB column can hand one back', () => {
  assert.equal(navTimeoutFor('60000'), 60000);
});
