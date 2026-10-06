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

// A placeholder is the question when a field has no label (the applications
// side reads it that way), so it is held to the label cap, not the old 60.
const PLACEHOLDER_Q = `Tell us, in your own words, which ${'fixture broadcast systems '.repeat(4)}you have supported and for how long`;
// Hostile: over MAX_LABEL_CHARS, so describe caps them and says so.
const HOSTILE_LABEL = `H${'hostile label text '.repeat(80)}`;
const HOSTILE_PLACEHOLDER = `P${'hostile placeholder text '.repeat(60)}`;
const HOSTILE_HTML = `<!doctype html><html><body><form>
  <label for="h1">${HOSTILE_LABEL}</label><input id="h1" name="h1" type="text">
  <input id="p1" name="p1" type="text" placeholder="${PLACEHOLDER_Q}">
  <input id="p2" name="p2" type="text" placeholder="${HOSTILE_PLACEHOLDER}">
</form></body></html>`;

let described;
let filled;
let hostileDescribed;
let hostileFilled;

test.before(async () => {
  await withPage(async page => {
    await page.setContent(HTML);
    described = await probeForms(page, 80);
    // No answers: nothing is typed, only the report's rows are read.
    filled = await fillForm(page, { fields: described.fields, answers: {} });
    await page.setContent(HOSTILE_HTML);
    hostileDescribed = await probeForms(page, 80);
    hostileFilled = await fillForm(page, { fields: hostileDescribed.fields, answers: {} });
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

// Reported by applications (2026-10-06, from reading the code): a label describe
// had capped (1000 + "…") was cut AGAIN by the fill report, to 1000 + "...", so
// the two reports disagreed on that field. Counterfactual: on 8a3194b this
// fails with the fill row ending "..." and 1003 characters long.
test('a label describe capped comes back identical in the fill report', () => {
  const d = hostileDescribed.fields.find(f => f.selector === '#h1');
  const r = hostileFilled.fields.find(f => f.selector === '#h1');
  assert.ok(HOSTILE_LABEL.length > MAX_LABEL_CHARS, 'fixture label must exceed the cap');
  assert.equal(d.label.length, MAX_LABEL_CHARS + 1);
  assert.ok(d.label.endsWith('…'));
  assert.equal(r.label, d.label);
});

// Reported by applications (2026-10-06): placeholder was cut at 60 and not
// counted, and a label-less field's placeholder is its question there.
// Counterfactual: on 8a3194b the placeholder comes back 61 characters ending
// "…", and labelsTruncated is 1 (the label only).
test('a long placeholder is returned whole, and one over the cap is counted', () => {
  assert.ok(PLACEHOLDER_Q.length > 60 && PLACEHOLDER_Q.length < MAX_LABEL_CHARS);
  const p1 = hostileDescribed.fields.find(f => f.selector === '#p1');
  const p2 = hostileDescribed.fields.find(f => f.selector === '#p2');
  assert.equal(p1.label, null, 'the fixture field must have no label, so the placeholder is its question');
  assert.equal(p1.placeholder, PLACEHOLDER_Q);
  assert.equal(p2.placeholder.length, MAX_LABEL_CHARS + 1);
  assert.ok(p2.placeholder.endsWith('…'));
  assert.equal(hostileDescribed.labelsTruncated, 2, 'the capped label (#h1) and the capped placeholder (#p2)');
  assert.equal(described.labelsTruncated, 0);
});

test('the hostile-page cap is far above any real question', () => {
  assert.ok(MAX_LABEL_CHARS >= 500, `MAX_LABEL_CHARS ${MAX_LABEL_CHARS} would cut real questions`);
});
