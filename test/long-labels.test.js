// A form field's label is the QUESTION, and the describe (forms probe) and
// fill reports return it whole. Until 2026-10-05 both cut it to 60 characters
// plus an ellipsis, so Posit's required human-check question
// (#question_32848993003, gh_jid 7999513003) read only "Just to ensure that
// you're human, on https://p3m.dev, what a…" and nobody could see what it
// asked. Two long questions sharing a 60-character prefix were also identical
// by label, which is how an answer gets matched to the wrong field.
//
// Driven in a real headless page, so the in-page reader (labelFor, the group
// question) is covered as well as the allowlist rebuild after it. The group
// question was cut at 200 IN the page with no marker at all.
//
// Counterfactual (run against the pre-change lib/probes.js and
// lib/fillForm.js): every equality below fails -- the labels come back 61
// characters long ending in "…", the fill rows 63 ending in "...", and the
// group question 200 characters with no marker.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withPage } = require('../lib/runner');
const { probeForms, MAX_LABEL_CHARS } = require('../lib/probes');
const { fillForm } = require('../lib/fillForm');

// The live Posit label's first 60 characters, then a plausible remainder (the
// real text is read by the live describe, not invented here).
const PREFIX = "Just to ensure that you're human, on https://p3m.dev, what a";
const Q1 = `${PREFIX}re the first three characters of the page title shown at the top left?`;
const Q2 = `${PREFIX}re the last four characters of the footer text on that same page?`;
const LONG_GROUP = `Which of the following fixture platforms have you used in a professional setting, ${'and for how long, '.repeat(12)}if any?`;

const HTML = `<!doctype html><html><body><form>
  <label for="q1">${Q1}*</label><input id="q1" name="q1" type="text">
  <label for="q2">${Q2}</label><input id="q2" name="q2" type="text">
  <fieldset id="g"><legend>${LONG_GROUP}</legend>
    <input type="radio" id="g0" name="g" value="a"><label for="g0">Alpha</label>
    <input type="radio" id="g1" name="g" value="b"><label for="g1">Beta</label>
  </fieldset>
</form></body></html>`;

let described;
let filled;

test.before(async () => {
  await withPage(async page => {
    await page.setContent(HTML);
    described = await probeForms(page, 80);
    // No answers: nothing is typed, only the report's rows are read.
    filled = await fillForm(page, { fields: described.fields, answers: {} });
  });
});

test('describe returns a label longer than 60 characters whole', () => {
  assert.ok(Q1.length > 60 && LONG_GROUP.length > 200, 'fixture labels must exceed both old caps');
  const q1 = described.fields.find(f => f.selector === '#q1');
  const q2 = described.fields.find(f => f.selector === '#q2');
  assert.equal(q1.label, `${Q1}*`);
  assert.equal(q2.label, Q2);
  // Identical to 60 characters (the old cut), so only the whole label tells them apart.
  assert.equal(q1.label.slice(0, 60), q2.label.slice(0, 60));
  assert.notEqual(q1.label, q2.label);
  assert.equal(described.labelsTruncated, 0);
});

test('describe returns a multi-option question longer than 200 characters whole', () => {
  const opt = described.fields.find(f => f.selector === '#g0');
  assert.equal(opt.group.question, LONG_GROUP.replace(/\s+/g, ' ').trim());
});

test('the fill report returns the same whole label', () => {
  const q1 = filled.fields.find(f => f.selector === '#q1');
  const q2 = filled.fields.find(f => f.selector === '#q2');
  assert.equal(q1.label, `${Q1}*`);
  assert.equal(q2.label, Q2);
  assert.equal(filled.formChanged, false, 'a whole label hashes the same on both sides');
});

test('the hostile-page cap is far above any real question', () => {
  assert.ok(MAX_LABEL_CHARS >= 500, `MAX_LABEL_CHARS ${MAX_LABEL_CHARS} would cut real questions`);
});
