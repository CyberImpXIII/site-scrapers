// lib/labReport.js: how lab.js summarises a prober run. Each case is a shape
// that once broke or blanked lab.js's output.

const test = require('node:test');
const assert = require('node:assert/strict');
const { formsSummary, proberFailure } = require('../lib/labReport');

test('an errored forms probe (no `fields`) is summarised, not thrown on', () => {
  // pantheon.io 2026-10-05: reading p.fields.length threw and lost every
  // other probe's output.
  assert.deepEqual(formsSummary({ kind: 'forms', error: 'timed out describing forms' }), {
    fields: null,
    error: 'timed out describing forms',
  });
  assert.deepEqual(formsSummary({ kind: 'forms', fields: 'not a list' }), {
    fields: null,
    error: 'forms probe returned no field list',
  });
  assert.equal(formsSummary(undefined).fields, null);
});

test('a forms probe with fields is summarised by count', () => {
  const s = formsSummary({ fields: [{}, {}, {}], requiredCount: 2, fileUploadPresent: true, submits: [{ text: 'Apply' }] });
  assert.deepEqual(s, { fields: 3, required: 2, fileUpload: true, submits: [{ text: 'Apply' }] });
});

test('a failed prober run says why even when the engine set no error', () => {
  // "prober run failed: undefined" on a 404 board slug.
  assert.equal(proberFailure({ success: false, error: 'boom' }), 'boom');
  const noError = proberFailure({ success: false, timedOut: true, url: 'https://x.example/404' });
  assert.doesNotMatch(noError, /undefined/);
  assert.match(noError, /timed out/);
  assert.match(noError, /x\.example\/404/);
  assert.match(proberFailure({ success: false, failedStep: 2 }), /step 2/);
  assert.match(proberFailure({ success: false }), /did not load/);
  assert.doesNotMatch(proberFailure(null), /undefined/);
});
