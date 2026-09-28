// The site-dependent knowledge probes use, seeded into failures.db.
//
// A distinction worth being explicit about: the probe KINDS stay in code.
// probeBlockers and probeRepeatedStructure run page.evaluate with real logic,
// and executing JavaScript stored in a writable database row would be arbitrary
// code execution from a data store — a security hole, not an improvement.
//
// What belongs in the DB is what the probes KNOW: attribute names, phrases and
// markers that grow as new sites and frameworks are met. Same reasoning as the
// blocker signatures, and the same failure it avoids — a list frozen in library
// code means every discovery needs a code change, and anything learned in a
// session is lost.
//
// Numeric thresholds stay in code on purpose. They are tuning, not knowledge:
// "a card group needs 3+ siblings" is a judgement about the algorithm, not a
// fact about a site, and making it editable invites someone to widen it until
// the probe reports noise.
//
// kinds:
//   attr     an attribute name a site sets deliberately, usable as a stable hook
//   pattern  a regex source, matched case-insensitively
//   text     a literal substring

const PROBE_KNOWLEDGE = [
  // --- forms: hooks a site provides on purpose -----------------------------
  // Ordered by how deliberate they are. A Workday tenant's card wrapper carries
  // no stable class at all but marks the title link with data-automation-id, so
  // the usable selector is structural, anchored to the hook.
  ['forms', 'stable_attr', 'attr', 'data-testid'],
  ['forms', 'stable_attr', 'attr', 'data-test-id'],
  ['forms', 'stable_attr', 'attr', 'data-test'],
  ['forms', 'stable_attr', 'attr', 'data-qa'],
  ['forms', 'stable_attr', 'attr', 'data-automation-id'],
  ['forms', 'stable_attr', 'attr', 'data-cy'],
  ['forms', 'stable_attr', 'attr', 'itemtype'],

  // --- forms: how a site says "required" ----------------------------------
  // Greenhouse marks required fields with a "*" in the LABEL and omits the HTML
  // attribute entirely; Lever uses "✱". Trusting the attribute alone reported a
  // 32-field form as almost entirely optional, which is the dangerous direction
  // to err for a form a person is about to fill in.
  ['forms', 'required_marker', 'pattern', '[*✱]'],
  ['forms', 'required_marker', 'pattern', '\\(required\\)'],
  ['forms', 'required_marker', 'pattern', '\\brequired\\b'],

  // --- forms: what a submit control says ----------------------------------
  // A modern submit is a <button>, not an input, so it is matched by text.
  ['forms', 'submit_text', 'pattern', 'submit|send|apply|continue|next|save'],

  // --- empty_state: how a site says "nothing matched" ---------------------
  // Deliberately narrow: a false positive here tells someone to stop looking for
  // a bug that is real. The record NOUNS are a per-call parameter, not knowledge,
  // because the word for what a site lists belongs to that site.
  ['empty_state', 'empty_phrase', 'pattern', 'nothing (?:found|matched)'],
  ['empty_state', 'empty_phrase', 'pattern', "we (?:could ?n'?t|did ?n'?t) find"],
  ['empty_state', 'empty_phrase', 'pattern', 'try (?:a )?(?:different|another|broadening|adjusting)'],
  ['empty_state', 'empty_phrase', 'pattern', 'broaden your search'],

  // --- repeated_structure: classes that will not survive a deploy ---------
  // Emotion and styled-components hashes, CSS-modules suffixes, Tailwind
  // arbitrary values. Proposing one of these as a card_selector is worse than
  // proposing nothing: it works today and breaks on the next release.
  ['repeated_structure', 'generated_class', 'pattern', '^[a-z]+-\\['],
  ['repeated_structure', 'generated_class', 'pattern', '^(css|sc|emotion|jsx)-[a-z0-9]{4,}$'],
  ['repeated_structure', 'generated_class', 'pattern', '__[A-Za-z0-9]{5,}$'],
  ['repeated_structure', 'generated_class', 'pattern', '-[a-f0-9]{6,}$'],
];

module.exports = { PROBE_KNOWLEDGE };
