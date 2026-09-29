// Deciding whether a generic action actually DID anything on a page.
//
// The trap this exists to avoid: running `dismiss_overlay` on a page with no
// overlay succeeds. Every step is a no-op, nothing throws, and the run reports
// success — so "the action ran without erroring" is not evidence that it works
// here, and recording it as such would manufacture exactly the confident
// folklore these observations are meant to replace.
//
// So an action is judged on whether the PAGE CHANGED, measured by comparing a
// cheap signature taken before and after. The recorded outcome is therefore a
// claim this code can actually support:
//
//   changed    the page measurably differs afterwards
//   reported   a DIAGNOSTIC action came back with findings
//   no_effect  it ran, and nothing measurable moved or was found
//   error      it threw
//
// `reported` exists because a probe deliberately changes nothing. Judging
// probe_card_candidates by the page signature would record no_effect for it on
// every page in existence, including ones where it found the cards perfectly —
// the measure has to be what it REPORTED, not what it moved. Which action is
// which is not a list kept anywhere: an action that emitted diagnostics is
// judged on them, one that did not is judged on the signature. A list would
// drift the first time an action was added.
//
// "changed" deliberately does not mean "worked". An action can change the page
// unhelpfully. It means: this action does something here, so it is worth trying
// before one that provably does nothing. That is the question ordering needs
// answered, and it is answerable.
//
// THRESHOLDS LIVE HERE, IN CODE, not in the probe-knowledge table — they are
// tuning, not knowledge about a site, and the reasoning is the same as for the
// probe thresholds: making them editable invites widening them until every
// action looks like it did something.

// Text jitters on its own: a relative timestamp ticking over, a rotating ad
// slot, a live counter. Requiring both a proportional and an absolute move
// stops that reading as an effect on a long page, while still catching a real
// change on a short one.
const TEXT_DELTA_FRACTION = 0.02;
const TEXT_DELTA_MIN_CHARS = 50;
// Lazy-loaded images settling can nudge height by a few pixels.
const HEIGHT_DELTA_FRACTION = 0.05;

// Fields where ANY difference is meaningful, with how to say it.
const EXACT_FIELDS = [
  ['url', (a, b) => `navigated: ${a} -> ${b}`],
  ['dialogs', (a, b) => `dialogs ${a} -> ${b}`],
  ['scrollLocked', (a, b) => `scroll lock ${a} -> ${b}`],
  ['title', (a, b) => `title: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`],
];

/**
 * Compares two page signatures. Returns { changed, changes } where `changes`
 * is a list of short human-readable differences — the evidence, kept so a
 * reader can disagree with the verdict rather than having to trust it.
 */
function signatureDiff(before, after) {
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') {
    return { changed: false, changes: [], incomparable: true };
  }
  const changes = [];

  for (const [field, describe] of EXACT_FIELDS) {
    if (before[field] === undefined || after[field] === undefined) continue;
    if (before[field] !== after[field]) changes.push(describe(before[field], after[field]));
  }

  const elemDelta = num(after.elements) - num(before.elements);
  if (elemDelta !== 0) changes.push(`elements ${signed(elemDelta)} (${before.elements} -> ${after.elements})`);

  const textDelta = num(after.textLength) - num(before.textLength);
  const textBase = Math.max(num(before.textLength), 1);
  if (Math.abs(textDelta) >= TEXT_DELTA_MIN_CHARS && Math.abs(textDelta) / textBase >= TEXT_DELTA_FRACTION) {
    changes.push(`text ${signed(textDelta)} chars`);
  }

  const heightDelta = num(after.scrollHeight) - num(before.scrollHeight);
  const heightBase = Math.max(num(before.scrollHeight), 1);
  if (Math.abs(heightDelta) / heightBase >= HEIGHT_DELTA_FRACTION) {
    changes.push(`page height ${signed(heightDelta)}px`);
  }

  return { changed: changes.length > 0, changes };
}

const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const signed = n => (n > 0 ? `+${n}` : String(n));

/**
 * The outcome to record for one action trial.
 *
 * An action that threw is `error` regardless of what the signatures say — the
 * page may well have changed on the way to failing, and calling that "changed"
 * would recommend it to the next caller.
 */
function outcomeFor({ error, before, after }) {
  if (error) {
    return { outcome: 'error', detail: String(error).slice(0, 200), changes: [] };
  }
  const diff = signatureDiff(before, after);
  if (diff.incomparable) {
    // Never seen both sides, so there is nothing to conclude. Recording
    // `no_effect` here would be asserting an absence we did not measure.
    return { outcome: 'error', detail: 'the page signature could not be read before and after', changes: [] };
  }
  return {
    outcome: diff.changed ? 'changed' : 'no_effect',
    detail: diff.changed ? diff.changes.join('; ').slice(0, 200) : 'ran, nothing measurable moved',
    changes: diff.changes,
  };
}

// What a probe result actually says, per kind, as { found, summary }.
//
// `found` is the judgement: did this probe come back with something, on this
// page. It is per-kind because the shapes differ — `blockers` finding nothing
// is GOOD news and still counts as a report, while `repeated_structure`
// finding nothing means there are no cards here. Both are answers; both are
// worth recording; neither is "the action did not work".
//
// Keyed on `kind`, which every probe result carries, so it does not depend on
// the label a generic action happens to use. test/observations.test.js asserts
// this covers every registered PROBE_KIND — a probe with no summariser here
// would be silently judged as having found nothing.
const PROBE_SUMMARY = {
  repeated_structure: p => {
    const n = (p.candidates || []).length;
    const top = (p.candidates || [])[0];
    return {
      found: n > 0,
      summary: n
        ? `${n} card candidate${n === 1 ? '' : 's'}; best ${top.stableHook || top.childSelector} x${top.count}${top.sharedLine ? ` (shared line ${JSON.stringify(top.sharedLine)})` : ''}`
        : 'no repeated card structure on this page',
    };
  },
  card_anatomy: p => ({
    found: (p.parts || []).length > 0,
    summary: `${(p.parts || []).length} parts across ${p.cardsSampled || 0} cards`,
  }),
  card_match: p => {
    const hits = Object.values(p.fields || {}).filter(f => f && f.selector).length;
    return { found: hits > 0, summary: `${hits} of ${Object.keys(p.fields || {}).length} fields matched to a selector` };
  },
  blockers: p => ({
    found: true, // "not blocked" is a finding, and the one you most want
    summary: p.blocked ? `BLOCKED: ${(p.flags || []).join(', ')}` : 'not blocked',
  }),
  antibot: p => ({
    found: true,
    summary: p.detected ? `${(p.services || []).join(', ') || 'anti-bot'} present, blocking=${p.blocking}` : 'no anti-bot service detected',
  }),
  empty_state: p => ({ found: true, summary: `empty-state: ${p.likelyCause || 'no verdict'}` }),
  forms: p => ({
    found: (p.fields || []).length > 0,
    summary: `${(p.fields || []).length} form fields, ${p.requiredCount || 0} required`,
  }),
  selectors: p => {
    const hit = (p.matches || []).filter(m => m.count > 0).length;
    return { found: hit > 0, summary: `${hit} of ${(p.matches || []).length} selectors matched` };
  },
  // Taken constantly by the trial harness itself; never a finding of its own.
  page_signature: () => ({ found: false, summary: 'page signature' }),
};

function summariseProbe(diag) {
  if (!diag || !diag.kind) return { found: false, summary: 'unrecognisable probe result' };
  if (diag.error) return { found: false, error: diag.error, summary: `probe error: ${diag.error}` };
  const fn = PROBE_SUMMARY[diag.kind];
  // An unknown kind is reported as unknown rather than as "found nothing":
  // the latter is a claim about the page, this is a gap in this table.
  if (!fn) return { found: false, summary: `no summariser for probe kind "${diag.kind}"`, unknownKind: true };
  return fn(diag);
}

/**
 * The outcome for an action judged on what it REPORTED rather than what it
 * moved. `diags` are the probe results emitted while that action ran.
 */
function outcomeForProbes(diags) {
  const real = (diags || []).filter(d => d && d.kind && d.kind !== 'page_signature');
  if (!real.length) return null; // not a diagnostic action; judge it on the signature

  const summaries = real.map(summariseProbe);
  const errored = summaries.filter(s => s.error);
  if (errored.length === summaries.length) {
    return { outcome: 'error', detail: errored.map(s => s.summary).join('; ').slice(0, 200), changes: [] };
  }
  const found = summaries.filter(s => s.found);
  return {
    outcome: found.length ? 'reported' : 'no_effect',
    detail: (found.length ? found : summaries).map(s => s.summary).join('; ').slice(0, 200),
    changes: [],
  };
}

// A page is someone else's HTML and it rots. An observation recorded against a
// layout that has since been redesigned is the "stale notes are worse than
// none" failure in docs/lessons.md: it reads as current knowledge and sends
// someone down a path that closed months ago.
const STALE_AFTER_DAYS = 90;

function ageInDays(observedAt, now = Date.now()) {
  const t = Date.parse(observedAt);
  if (!Number.isFinite(t)) return null;
  return Math.floor((now - t) / 86400000);
}

function isStale(observation, now = Date.now(), maxAgeDays = STALE_AFTER_DAYS) {
  const age = ageInDays(observation && observation.observed_at, now);
  return age !== null && age > maxAgeDays;
}

module.exports = {
  signatureDiff,
  outcomeFor,
  outcomeForProbes,
  summariseProbe,
  PROBE_SUMMARY,
  isStale,
  ageInDays,
  STALE_AFTER_DAYS,
  TEXT_DELTA_FRACTION,
  TEXT_DELTA_MIN_CHARS,
};
