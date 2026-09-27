// Unit tests for the duplication audit's pure logic (audit.js).
//
// These matter because a wrong answer here is not a crash, it is bad advice:
// a false positive sends someone refactoring a recipe that was fine, and a
// false negative lets copy-paste accumulate while the audit reports all clear.
// The static checks are pure functions over step lists, so they are testable
// without a browser or a network.
//
// Run via `npm test` / `./test.sh`.

const test = require('node:test');
const assert = require('node:assert/strict');
const { signature, literalsOf, findRepeatedSequences, findSharedLiterals } = require('../audit');

// --- signature(): same KIND of step, ignoring site-specific values ---------

test('two steps doing the same thing to different selectors share a signature', () => {
  const a = { action: 'click', selector: '.one' };
  const b = { action: 'click', selector: '#two' };
  assert.equal(signature(a), signature(b), 'the selector is site knowledge, not part of the shape');
});

test('a flag that changes behaviour changes the signature', () => {
  const plain = { action: 'click', selector: '.x' };
  const optional = { action: 'click', selector: '.x', stop_if_missing: true };
  assert.notEqual(
    signature(plain),
    signature(optional),
    'stop_if_missing changes control flow, so these are not interchangeable'
  );
});

test('repeat counts are part of the shape', () => {
  assert.notEqual(
    signature({ action: 'repeat', times: 1, steps: [] }),
    signature({ action: 'repeat', times: 5, steps: [] })
  );
});

test('probe kinds are distinguished', () => {
  assert.notEqual(
    signature({ action: 'probe', kind: 'forms' }),
    signature({ action: 'probe', kind: 'blockers' }),
    'two probes asking different questions are not the same step'
  );
});

// --- literalsOf(): what is hard-coded, excluding parameters ----------------

test('an unsubstituted parameter is not a literal', () => {
  assert.deepEqual(literalsOf({ action: 'click', selector: '{{entry_selector}}' }), [],
    'a parameter is the opposite of a hard-coded value');
  assert.deepEqual(literalsOf({ action: 'goto', url: '{{url}}' }), []);
});

test('real values are reported with the field they came from', () => {
  const found = literalsOf({ action: 'type', selector: '#email', text: 'someone@example.com' });
  assert.deepEqual(
    found.map(f => f.field).sort(),
    ['selector', 'text'],
    'both a selector and typed text are hard-coded values'
  );
});

test('a partially parameterised string still counts as a literal', () => {
  // "{{q}}" alone is a parameter; a URL merely CONTAINING one is still a
  // site-specific template and belongs to the recipe.
  const found = literalsOf({ action: 'goto', url: 'https://example.com/jobs?q={{q}}' });
  assert.equal(found.length, 1);
  assert.equal(found[0].field, 'url');
});

test('very short values are ignored as noise', () => {
  assert.deepEqual(literalsOf({ action: 'click', selector: 'a' }), [],
    'a one-character selector is not a meaningful shared literal');
});

// --- findRepeatedSequences(): what is worth extracting --------------------

const recipe = (key, raw) => ({ key, raw, expanded: raw });

test('a sequence in two recipes is reported; a sequence in one is not', () => {
  const shared = [
    { action: 'waitForSelector', selector: '.a' },
    { action: 'scroll_bottom' },
    { action: 'collect' },
  ];
  const found = findRepeatedSequences([
    recipe('a.com#listing:default', shared),
    recipe('b.com#listing:default', shared),
    recipe('c.com#listing:default', [{ action: 'goto', url: 'https://c.com' }, { action: 'wait', ms: 1 }]),
  ]);
  assert.ok(found.length > 0, 'a sequence shared by two recipes is an extraction candidate');
  assert.ok(
    found.every(f => f.recipes.length >= 2),
    'nothing appearing in only one recipe should be reported — there is nothing to share'
  );
  const top = found[0];
  assert.ok(top.recipes.includes('a.com#listing:default') && top.recipes.includes('b.com#listing:default'));
});

test('a sequence made only of references is already factored out', () => {
  const refs = [
    { action: 'run_generic_action', ref: 'dismiss_overlay' },
    { action: 'run_generic_action', ref: 'describe_form' },
  ];
  const found = findRepeatedSequences([recipe('a.com#action:x', refs), recipe('b.com#action:x', refs)]);
  assert.deepEqual(found, [], 'reporting these would advise extracting an extraction');
});

test('longer shared sequences outrank shorter ones', () => {
  const long = [
    { action: 'waitForSelector', selector: '.a' },
    { action: 'scroll_bottom' },
    { action: 'collect' },
    { action: 'wait', ms: 100 },
  ];
  const found = findRepeatedSequences([recipe('a#l:d', long), recipe('b#l:d', long)]);
  assert.ok(found[0].steps >= found[found.length - 1].steps, 'the biggest single extraction should be first');
});

// --- findSharedLiterals(): copy-paste hiding a parameter -------------------

test('the same literal in two recipes is reported, in one is not', () => {
  const found = findSharedLiterals([
    recipe('a#l:d', [{ action: 'click', selector: '.cookie-accept-all' }]),
    recipe('b#l:d', [{ action: 'click', selector: '.cookie-accept-all' }]),
    recipe('c#l:d', [{ action: 'click', selector: '.unique-to-c-only' }]),
  ]);
  assert.equal(found.length, 1, 'only the duplicated literal is a finding');
  assert.match(found[0].literal, /cookie-accept-all/);
  assert.equal(found[0].recipes.length, 2);
});

test('a parameter shared across recipes is not a finding', () => {
  const found = findSharedLiterals([
    recipe('a#l:d', [{ action: 'goto', url: '{{url}}' }]),
    recipe('b#l:d', [{ action: 'goto', url: '{{url}}' }]),
  ]);
  assert.deepEqual(found, [], 'sharing a parameter name is reuse working, not duplication');
});

// --- unfillablePlaceholders(): can this recipe even be exercised? ----------
// Getting this wrong is how a verified recipe gets reported as a liar. An
// earlier version looked for the word "required" in the schema prose, which
// missed wellfound.com — whose schema documents `role` without calling it
// required — so the sweep ran it with no params, left "{{role}}" in the URL,
// got nothing back, and condemned a recipe verified at 39 records.

const { unfillablePlaceholders } = require('../audit');

test('a template with no placeholders is always runnable', () => {
  assert.deepEqual(unfillablePlaceholders('https://x.test/jobs', null), []);
  assert.deepEqual(unfillablePlaceholders('', null), []);
  assert.deepEqual(unfillablePlaceholders(null, null), []);
});

test('a placeholder with no probe value is unfillable', () => {
  assert.deepEqual(unfillablePlaceholders('https://x.test/role/{{role}}', null), ['role']);
  assert.deepEqual(unfillablePlaceholders('https://x.test/role/{{role}}', {}), ['role']);
});

test('a placeholder the probe set supplies is fillable', () => {
  assert.deepEqual(
    unfillablePlaceholders('https://x.test/role/{{role}}', { role: 'software-engineer' }),
    [],
    'this is the wellfound case — documented without the word "required", but supplied'
  );
});

test('only the MISSING placeholders are reported', () => {
  assert.deepEqual(
    unfillablePlaceholders('https://x.test?q={{query}}&loc={{location}}', { query: 'sales' }),
    ['location']
  );
});

test('a repeated placeholder is reported once', () => {
  assert.deepEqual(unfillablePlaceholders('https://x.test/{{q}}/page?q={{q}}', null), ['q']);
});

test('an empty-string value still counts as supplied', () => {
  // The caller chose to pass it. Substitution will produce an empty segment,
  // which is the recipe's business, not the audit's.
  assert.deepEqual(unfillablePlaceholders('https://x.test?q={{q}}', { q: '' }), []);
});

test('a ui_steps template is scanned the same way', () => {
  const steps = JSON.stringify([{ action: 'goto', url: 'https://x.test' }, { action: 'type', text: '{{search}}' }]);
  assert.deepEqual(unfillablePlaceholders(steps, null), ['search']);
  assert.deepEqual(unfillablePlaceholders(steps, { search: 'qa' }), []);
});
