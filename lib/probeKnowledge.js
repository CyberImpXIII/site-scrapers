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

  // --- card_anatomy: framework utility classes, which RANK LOW, never drop --
  // Most of what card_anatomy reports on a modern site is layout scaffolding.
  // On builtin.com the top of the list was div.col-12.col-lg-7,
  // div.d-flex.align-items-start and div.d-none.d-xl-block — pure Bootstrap —
  // while the two real hooks, div.left-side-tile-item-2 and -3, were further
  // down. Sorting the framework noise into a tail puts the semantic hooks where
  // they are read first.
  //
  // This is a RANKING vocabulary, and the distinction is the whole safety
  // argument. On that same builtin.com card, div.d-flex.align-items-start is
  // the ONLY hook for four fields (time, locations, salary, level) — excluding
  // utility classes would have left nothing to extract. nodesk.co is starker
  // still: its real title hook is a.mr-2.text-sm, utility classes both. So a
  // pattern that over-matches costs a part its position in the list and
  // nothing else, which is why these can be broad without being dangerous.
  // Anything that filtered on them would have to be far more conservative.
  //
  // The kind names the primary CONSUMER, not an exclusive owner — card_anatomy
  // already reads repeated_structure's generated_class list the same way.
  //
  // Bootstrap
  ['card_anatomy', 'utility_class', 'pattern', '^d-(sm|md|lg|xl|xxl)?-?(none|block|flex|inline|inline-block|inline-flex|grid|table)$'],
  ['card_anatomy', 'utility_class', 'pattern', '^col(-(sm|md|lg|xl|xxl))?(-(auto|1[0-2]|[1-9]))?$'],
  ['card_anatomy', 'utility_class', 'pattern', '^(row|container|container-fluid|clearfix)$'],
  ['card_anatomy', 'utility_class', 'pattern', '^fs-[1-6]$'],
  ['card_anatomy', 'utility_class', 'pattern', '^(justify|align)-(content|items|self)-[a-z]+$'],
  // Tailwind
  ['card_anatomy', 'utility_class', 'pattern', '^(flex|grid|block|inline|inline-block|inline-flex|hidden|contents|relative|absolute|sticky|fixed)$'],
  ['card_anatomy', 'utility_class', 'pattern', '^(items|justify|self|content|place|order)-[a-z0-9]+$'],
  ['card_anatomy', 'utility_class', 'pattern', '^(w|h|min-w|max-w|min-h|max-h)-(full|screen|auto|fit|px|\\d+(\\.\\d+)?)$'],
  ['card_anatomy', 'utility_class', 'pattern', '^text-(xs|sm|base|lg|\\d?xl)$'],
  ['card_anatomy', 'utility_class', 'pattern', '^(font|leading|tracking|whitespace|truncate|overflow)-?[a-z0-9]*$'],
  ['card_anatomy', 'utility_class', 'pattern', '^(rounded|border|shadow|ring|opacity|cursor|transition)(-[a-z0-9]+)*$'],
  ['card_anatomy', 'utility_class', 'pattern', '^(sm|md|lg|xl|2xl|hover|focus|active|group-hover|dark):'],
  // Spacing and gaps — shared shape across Bootstrap and Tailwind
  ['card_anatomy', 'utility_class', 'pattern', '^[mp][trblxyse]?-(auto|px|\\d+(\\.\\d+)?)$'],
  ['card_anatomy', 'utility_class', 'pattern', '^(gap|space)(-[xy])?-(px|\\d+(\\.\\d+)?)$'],
  // Bulma
  ['card_anatomy', 'utility_class', 'pattern', '^(is|has)-[a-z0-9-]+$'],
];

module.exports = { PROBE_KNOWLEDGE };
