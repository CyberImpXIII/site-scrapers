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
//   no_effect  it ran, and nothing measurable moved
//   error      it threw
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
  isStale,
  ageInDays,
  STALE_AFTER_DAYS,
  TEXT_DELTA_FRACTION,
  TEXT_DELTA_MIN_CHARS,
};
