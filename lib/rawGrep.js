// Search the card source text, with surrounding context.
//
// Every extraction fault ends at the same question: what does the page ACTUALLY
// say around this value? Until now the only answers were `lab.js raw`, which
// caps at three samples and so misses the card you care about, or opening a
// browser. Neither tells you why a regex matched "$100" on 2 of 57 cards.
//
// Context, not just the match, is the point: a bare currency match already
// proved it can return a number stripped of the unit that gives it meaning, and
// the fix depends entirely on what sits beside it.

const DEFAULT_CONTEXT = 60;
const DEFAULT_LIMIT = 12;

// Collapse the runs of whitespace that DOM text extraction leaves behind, so a
// snippet is one readable line rather than a column of newlines.
function tidy(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

function compile(pattern, flags = '') {
  // Always global: the interesting case is a pattern matching more than once.
  const g = flags.includes('g') ? flags : `${flags}g`;
  return new RegExp(pattern, g);
}

// One entry per match: which record, the matched text, and the text either side.
function grepRaw(records, pattern, { context = DEFAULT_CONTEXT, limit = DEFAULT_LIMIT, field = '_raw', flags = '' } = {}) {
  const re = compile(pattern, flags);
  const hits = [];
  let total = 0;
  (records || []).forEach((r, index) => {
    const blob = r && r[field];
    if (typeof blob !== 'string' || blob === '') return;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(blob)) !== null) {
      total += 1;
      if (hits.length < limit) {
        hits.push({
          index,
          match: m[0],
          before: tidy(blob.slice(Math.max(0, m.index - context), m.index)),
          after: tidy(blob.slice(m.index + m[0].length, m.index + m[0].length + context)),
        });
      }
      // A zero-width match would loop forever otherwise -- an easy pattern to
      // write by accident (`\b`, or a fully-optional group).
      if (m[0] === '') re.lastIndex += 1;
    }
  });
  return { total, shown: hits.length, truncated: Math.max(0, total - hits.length), hits };
}

// How many records have a source blob at all. A grep that reports 0 hits means
// something different when the answer is "0 of 57 records carried source text"
// -- that is a harness fault, not a finding about the page.
function searchableCount(records, field = '_raw') {
  return (records || []).filter((r) => typeof (r && r[field]) === 'string' && r[field] !== '').length;
}

module.exports = { grepRaw, searchableCount, tidy, DEFAULT_CONTEXT, DEFAULT_LIMIT };
