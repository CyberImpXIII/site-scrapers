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
  // CSS-modules' other common output shape: _name_hash_line, e.g. Ashby's
  // _title_1dvh9_382 and _container_j2da7_1. Found because card_anatomy
  // proposed `h3._title_1dvh9_382.ashby-job-posting-brief-title` on a real
  // board -- leading with the hashed class while the site's own stable
  // `ashby-`prefixed class sat right beside it. None of the patterns above
  // match this form: there is no css-/sc- prefix, no trailing hex run after a
  // dash, and no double underscore.
  ['repeated_structure', 'generated_class', 'pattern', '^_[A-Za-z0-9]+_[a-z0-9]{4,}(_\\d+)?$'],

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

  // --- card_anatomy: value SHAPES that suggest what a field is -------------
  // The category carries the proposed field name after the dot, so adding a
  // shape is a row rather than a code change, and the value stays a plain
  // pattern like every other row here.
  //
  // The hard limit, from docs/lessons.md: a probe may recognise a SHAPE it has
  // been told about. It may never decide what a novel field means — a probe
  // that guessed field names is how a salary came to be reported as a
  // location, on a card where the salary segment merely looked like the
  // location segment. So a proposal is attached as evidence next to the part
  // it came from, is only made when the shape holds for EVERY sample of that
  // part, and is never applied.
  //
  // Names match the field names already used by recipes here, so a proposal
  // slots straight in rather than inventing a synonym.
  ['card_anatomy', 'field_shape.salary', 'pattern', '^[^a-z]*[$£€¥][\\d,.]+\\s*(k|m)?\\b'],
  ['card_anatomy', 'field_shape.salary', 'pattern', '\\b(usd|eur|gbp|cad|aud)\\b.*[\\d,]{3,}'],
  ['card_anatomy', 'field_shape.salary', 'pattern', '[\\d,]{3,}\\s*(-|–|to)\\s*[\\d,]{3,}\\s*(per|/|a)\\s*(year|yr|hour|hr|month|mo)'],
  ['card_anatomy', 'field_shape.posted_ago', 'pattern', '^\\d+\\s*(second|minute|hour|day|week|month|year)s?\\s+ago$'],
  ['card_anatomy', 'field_shape.posted_ago', 'pattern', '^\\d+\\s*[smhdwy]\\s*ago$'],
  ['card_anatomy', 'field_shape.posted_ago', 'pattern', '^(just now|today|yesterday)$'],
  ['card_anatomy', 'field_shape.posted_ago', 'pattern', '^posted\\s+\\d+\\s*\\w+\\s+ago$'],
  ['card_anatomy', 'field_shape.commitment', 'pattern', '^(full[- ]?time|part[- ]?time|contract|contractor|temporary|internship|intern|freelance|permanent|casual)$'],
  ['card_anatomy', 'field_shape.workplace', 'pattern', '^(remote|hybrid|on[- ]?site|in[- ]?office|work from home|wfh)$'],

  // --- repeated_structure: ad and sponsored containers, RANKED LOW ---------
  // The semantic chrome tags (header/footer/nav/aside) are universal HTML and
  // stay in code. These are class and id names, which vary per site, so they
  // are data for the same reason the build-hash patterns are: meeting a new ad
  // framework should not need a release.
  //
  // Matched against a container's class and id. Ranked down, never dropped —
  // `promoted` in particular is a real job badge on some boards as well as an
  // ad marker, so a hit must never be able to remove a candidate.
  ['repeated_structure', 'ad_container', 'pattern', 'sponsor'],
  ['repeated_structure', 'ad_container', 'pattern', 'advert'],
  ['repeated_structure', 'ad_container', 'pattern', '(^|[^a-z])ads?([^a-z]|$)'],
  ['repeated_structure', 'ad_container', 'pattern', 'promoted'],
  ['repeated_structure', 'ad_container', 'pattern', 'taboola|outbrain|adsense|doubleclick'],
];

module.exports = { PROBE_KNOWLEDGE };
