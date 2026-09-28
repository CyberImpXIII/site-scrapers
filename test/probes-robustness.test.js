// Do probes fail EFFECTIVELY, and do parameters actually do something?
//
// Probes run when things are already broken — that is their whole purpose — so
// they meet pages that are half-dead, enormous, or navigating away underneath
// them. A probe that throws takes down the diagnostic that was supposed to
// explain the failure, and a probe that returns unbounded output is a token bomb
// in the middle of an incident. Neither is hypothetical: the earlier
// `empty_state` bug was a probe throwing "Cannot read properties of undefined",
// and it was only visible because runProbe caught it into an `error` field.
//
// These use FAKE page objects rather than a browser: a real page cannot be made
// to hang or throw on demand, and the behaviour under test is the error handling,
// not the DOM. Fast and deterministic as a result.
//
// Run via `npm test` / `./test.sh`.

const test = require('node:test');
const assert = require('node:assert/strict');
const { runProbe, PROBE_KINDS, autoDiagnose } = require('../lib/probes');

const ALL_KINDS = Object.keys(PROBE_KINDS);

// A page whose evaluate misbehaves in a specific way.
const fakePage = behaviour => ({
  url: () => 'about:blank',
  $$: async () => [],
  evaluate: behaviour,
});

test('every probe kind is registered with a callable implementation', () => {
  assert.ok(ALL_KINDS.length >= 5, `expected the full probe set, got ${ALL_KINDS.join(', ')}`);
  for (const kind of ALL_KINDS) {
    assert.equal(typeof PROBE_KINDS[kind], 'function', `${kind} must be callable`);
  }
});

test('no probe throws when the page evaluate throws', async () => {
  for (const kind of ALL_KINDS) {
    const page = fakePage(async () => {
      throw new Error('Execution context was destroyed');
    });
    const result = await runProbe(page, { kind, label: kind, selectors: '.x', record_nouns: 'items' });
    assert.equal(typeof result, 'object', `${kind} must return an object`);
    assert.ok(result.error, `${kind} must report an error rather than throwing: ${JSON.stringify(result)}`);
    assert.equal(result.label, kind, 'the label must survive, or the caller cannot tell which probe failed');
  }
});

test('no probe throws when the page returns null or garbage', async () => {
  for (const shape of [null, undefined, 42, 'a string', []]) {
    for (const kind of ALL_KINDS) {
      const result = await runProbe(fakePage(async () => shape), { kind, label: kind, selectors: '.x' });
      assert.equal(typeof result, 'object', `${kind} on ${JSON.stringify(shape)} must return an object`);
      // Either a well-formed result or an explicit error — never a throw, and
      // never undefined, which would read as "no problem found".
      assert.ok(result.kind || result.error, `${kind} on ${JSON.stringify(shape)} returned neither kind nor error`);
    }
  }
});

test('a probe that hangs returns an error instead of hanging the run', async () => {
  // The real risk: a wedged renderer. Without the internal timeout the probe
  // would wait forever, and the run would look hung rather than failed.
  const hang = fakePage(() => new Promise(() => {}));
  const started = Date.now();
  const result = await runProbe(hang, { kind: 'blockers', label: 'hang' });
  const elapsed = Date.now() - started;
  assert.ok(result.error, `expected a timeout error, got ${JSON.stringify(result)}`);
  assert.match(result.error, /timed out/i);
  assert.ok(elapsed < 15000, `the probe should give up inside its own budget, took ${elapsed}ms`);
});

test('an unknown probe kind is reported, and lists the kinds that exist', async () => {
  const result = await runProbe(fakePage(async () => ({})), { kind: 'not_a_real_kind', label: 'bogus' });
  assert.match(result.error, /unknown probe kind/i);
  for (const kind of ALL_KINDS) {
    assert.ok(result.error.includes(kind), `the error should name "${kind}" so the caller can correct it`);
  }
});

test('autoDiagnose returns one labelled result per sweep probe, even when all fail', async () => {
  // This runs inside failure capture. If it threw, a failed run would lose its
  // diagnostics entirely — the case it exists to serve.
  const broken = fakePage(async () => {
    throw new Error('Target closed');
  });
  const results = await autoDiagnose(broken);
  assert.ok(Array.isArray(results) && results.length >= 3, 'the sweep must still produce a result per probe');
  for (const r of results) {
    assert.ok(r.label && r.label.startsWith('auto:'), `expected a labelled entry, got ${JSON.stringify(r)}`);
    assert.ok(r.error, 'each should carry its own error rather than the sweep aborting');
  }
});

// --- Output is bounded ----------------------------------------------------
// A probe reports into a transcript, so unbounded output is a real cost. These
// assert the caps hold on pathological input rather than trusting the constants.

test('repeated_structure caps how many candidates it reports', async () => {
  const many = Array.from({ length: 500 }, (_, i) => ({
    containerSelector: `div.c${i}`,
    childSelector: `div.k${i}`,
    count: 10,
    avgTextLength: 100,
    childrenWithLinks: 10,
    sampleText: 'x'.repeat(5000),
    sharedLine: 'View',
    sharedLineIn: '10/10',
    stableHook: null,
    selectorIsGenerated: false,
  }));
  const result = await runProbe(fakePage(async () => many), { kind: 'repeated_structure', label: 'cards' });
  assert.ok(Array.isArray(result.candidates), 'expected candidates back');
  assert.ok(result.candidates.length <= 10, `expected a capped list, got ${result.candidates.length}`);
  for (const c of result.candidates) {
    assert.ok(c.sampleText.length <= 200, `sample text should be truncated, got ${c.sampleText.length} chars`);
  }
});

test('forms caps how many fields it reports and truncates labels', async () => {
  const fields = Array.from({ length: 200 }, (_, i) => ({
    selector: `#f${i}`,
    tag: 'input',
    type: 'text',
    name: `f${i}`,
    label: 'L'.repeat(1000),
    placeholder: 'P'.repeat(1000),
    required: false,
    requiredEvidence: null,
    hasValue: false,
  }));
  const result = await runProbe(fakePage(async () => ({ fields, submits: [] })), { kind: 'forms', label: 'forms' });
  assert.ok(result.fields.length <= 60, `expected a capped field list, got ${result.fields.length}`);
  for (const f of result.fields) {
    if (f.label) assert.ok(f.label.length <= 100, `label should be truncated, got ${f.label.length}`);
  }
});

test('a probe never reports a form field value, even when the page offers one', async () => {
  // The page is the untrusted side here: if it hands back a value, the probe
  // must not pass it through. A page mid-login holds a typed password.
  const result = await runProbe(
    fakePage(async () => ({
      fields: [
        {
          selector: '#p',
          tag: 'input',
          type: 'password',
          name: 'password',
          label: 'Password',
          placeholder: null,
          required: true,
          requiredEvidence: 'attribute',
          hasValue: true,
          value: 'hunter2-must-not-appear',
        },
      ],
      submits: [],
    })),
    { kind: 'forms', label: 'forms' }
  );
  assert.ok(!JSON.stringify(result).includes('hunter2-must-not-appear'), 'a value must never reach the output');
  assert.equal(result.fields[0].hasValue, true, 'that a value exists is still reported');
  assert.equal(result.passwordFieldPresent, true);
});

// --- Parameters have an effect --------------------------------------------
// A parameter that is documented, referenced, and does nothing is worse than no
// parameter: the caller believes they changed something. probe_card_candidates
// shipped exactly that, documenting min_group while hardcoding 3.

test('min_group is passed through to the probe rather than ignored', async () => {
  let seen = null;
  const capture = {
    url: () => 'about:blank',
    $$: async () => [],
    evaluate: async (fn, ...args) => {
      seen = args;
      return [];
    },
  };
  await runProbe(capture, { kind: 'repeated_structure', label: 'cards', min_group: 7 });
  assert.ok(seen, 'the probe should have evaluated');
  assert.ok(seen.includes(7), `expected min_group 7 to reach page context, got args ${JSON.stringify(seen)}`);
});

test('an unsubstituted min_group placeholder falls back to the default', async () => {
  // "{{min_group}}" is a truthy STRING, so a naive `?? 3` would pass it into a
  // numeric comparison and silently match nothing.
  let seen = null;
  const capture = {
    url: () => 'about:blank',
    $$: async () => [],
    evaluate: async (fn, ...args) => {
      seen = args;
      return [];
    },
  };
  await runProbe(capture, { kind: 'repeated_structure', label: 'cards', min_group: '{{min_group}}' });
  assert.ok(seen.includes(3), `expected the default 3, got args ${JSON.stringify(seen)}`);
  assert.ok(!seen.includes('{{min_group}}'), 'the raw placeholder must not reach page context');
});

test('record_nouns is parameterised, with a domain-neutral default', async () => {
  let seen = null;
  const capture = {
    url: () => 'about:blank',
    $$: async () => [],
    evaluate: async (fn, ...args) => {
      seen = args;
      return { explicitEmptyMessage: null, matchedPhrases: 0, largestSiblingGroup: 0, bodyTextLength: 5000 };
    },
  };
  await runProbe(capture, { kind: 'empty_state', label: 'empty', record_nouns: 'jobs, openings' });
  const nouns = seen.find(a => Array.isArray(a));
  assert.deepEqual(nouns, ['jobs', 'openings'], 'the caller\'s vocabulary should be used');

  await runProbe(capture, { kind: 'empty_state', label: 'empty' });
  const defaults = seen.find(a => Array.isArray(a));
  assert.ok(defaults.includes('results'), 'the default must be domain-neutral');
  assert.ok(!defaults.includes('jobs'), 'baking job-board nouns in is what made this a parameter');
});

test('selectors accepts both a list and a comma-separated string', async () => {
  let seen = null;
  const capture = {
    url: () => 'about:blank',
    $$: async () => [],
    evaluate: async (fn, ...args) => {
      seen = args;
      return [];
    },
  };
  await runProbe(capture, { kind: 'selectors', label: 's', selectors: ['.a', '.b'] });
  assert.deepEqual(seen.find(a => Array.isArray(a)), ['.a', '.b']);

  await runProbe(capture, { kind: 'selectors', label: 's', selectors: '.a, .b' });
  assert.deepEqual(seen.find(a => Array.isArray(a)), ['.a', '.b'], 'a `with:` value arrives as a string');
});

test('an empty selectors parameter is reported rather than silently probing nothing', async () => {
  const result = await runProbe(fakePage(async () => []), { kind: 'selectors', label: 's', selectors: '' });
  assert.match(result.error, /no selectors given/i);
});
