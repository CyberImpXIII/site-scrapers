// Static assertions on the browser launch configuration (lib/runner.js).
//
// These check OUR OWN config — no browser, no network, no site's view of us.
// That distinction is deliberate: verifying the "stop announcing automation"
// change by reading automation signals off a live page was refused by the
// permission classifier as security-weakening, so the change is verified here
// instead, by asserting the flags are what they are meant to be.
//
// The boundary these tests encode, and are meant to keep honest:
//   ALLOWED    removing a flag whose only function is to advertise automation
//   NOT DONE   patching navigator.plugins, spoofing WebGL vendor strings,
//              installing a stealth plugin, or anything else engineered to
//              defeat a detector
//
// Run via `npm test` / `./test.sh`.

const test = require('node:test');
const assert = require('node:assert/strict');
const { LAUNCH_FLAGS, IGNORED_DEFAULT_FLAGS, realisticUserAgent } = require('../lib/runner');

test('the sandbox flags required by this environment are present', () => {
  assert.ok(LAUNCH_FLAGS.includes('--no-sandbox'));
  assert.ok(LAUNCH_FLAGS.includes('--disable-setuid-sandbox'));
});

test('navigator.webdriver is not advertised', () => {
  assert.ok(
    LAUNCH_FLAGS.includes('--disable-blink-features=AutomationControlled'),
    'without this flag Chrome sets navigator.webdriver = true, which exists only to announce automation'
  );
});

test("Puppeteer's --enable-automation default is dropped", () => {
  assert.deepEqual(
    IGNORED_DEFAULT_FLAGS,
    ['--enable-automation'],
    'that flag sets navigator.webdriver and shows the automation infobar — pure announcement'
  );
});

test('no evasion flags are present', () => {
  // The line this file exists to hold. Removing an announcement is hygiene;
  // these would be engineering against a detector, and if one ever appears
  // here it should be a deliberate, reviewed decision rather than a quiet
  // addition to an args array.
  const forbidden = [
    '--disable-web-security',
    '--disable-features=IsolateOrigins',
    '--disable-site-isolation-trials',
    '--ignore-certificate-errors',
    '--allow-running-insecure-content',
    '--disable-popup-blocking',
  ];
  for (const flag of forbidden) {
    assert.ok(!LAUNCH_FLAGS.some(f => f.startsWith(flag)), `${flag} weakens the browser and is not hygiene`);
  }
});

test('the flag list stays small enough to review at a glance', () => {
  // A long args array is where an evasion flag hides. If this trips, justify
  // each addition rather than raising the bound.
  assert.ok(LAUNCH_FLAGS.length <= 6, `expected a short, reviewable flag list, got ${LAUNCH_FLAGS.length}`);
});

// --- User agent ------------------------------------------------------------

test('the user agent reports the real browser, with Headless normalised away', async () => {
  const ua = await realisticUserAgent({ userAgent: async () => 'Mozilla/5.0 HeadlessChrome/131.0.0.0 Safari/537.36' });
  assert.ok(!/Headless/.test(ua), '"Headless" is an automation announcement, so it is dropped');
  assert.match(ua, /Chrome\/131\.0\.0\.0/, 'the version stays truthful — only the word changes');
});

test('a browser that cannot report its UA falls back rather than sending an empty one', async () => {
  const fromThrow = await realisticUserAgent({
    userAgent: async () => {
      throw new Error('detached');
    },
  });
  assert.match(fromThrow, /^Mozilla\/5\.0 /, 'an empty UA is itself unusual, so there is a plausible fallback');

  const fromEmpty = await realisticUserAgent({ userAgent: async () => '' });
  assert.match(fromEmpty, /^Mozilla\/5\.0 /);
});

test('the user agent is not rewritten into a different browser or platform', async () => {
  // Reporting the engine accurately is the point. Claiming to be Firefox, or a
  // different OS, would be spoofing rather than declining to announce.
  const ua = await realisticUserAgent({
    userAgent: async () => 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 HeadlessChrome/130.0.0.0 Safari/537.36',
  });
  assert.match(ua, /Linux x86_64/, 'the real platform is preserved');
  assert.match(ua, /Chrome\/130\.0\.0\.0/, 'the real version is preserved');
  assert.ok(!/Firefox|Edg\//.test(ua));
});
