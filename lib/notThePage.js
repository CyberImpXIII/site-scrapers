// The `expect_url` ui_steps step: after navigating, the page must be the kind
// of page the recipe reads, judged by its URL. When it is not, the run stops
// with a distinct NOT-THE-PAGE result instead of reading whatever is there.
//
// Found 2026-10-05 (reported by applications): a CLOSED Greenhouse posting,
// job-boards.greenhouse.io/allianceus/jobs/4361897009, answers with a
// server-side 302 to the company's board, /allianceus?error=true. Same host,
// so lib/forwarded.js (a change of SITE) rightly does not fire. Both
// Greenhouse recipes then reported success there: `#article` read the board's
// intro text as the job description (its wait and extract fall back to
// document.body), and `#action:describe_application_form` described the
// board's search box as the application form (1 field, "Search"). Both
// plausible, both wrong -- worse than a failure.
//
// The answer is a fact about the URL the browser is on, so it is checked
// against the URL rather than inferred from the page: a pattern the recipe
// supplies (its own knowledge of what its pages look like), never a guess
// about what a "closed" page says. The caller gets `notThePage` with what was
// asked for, where the browser landed and what was expected, and the article
// or records are null: nothing was read, which is not the same as "empty".
//
// A pattern that does not compile is a plain error (the recipe is wrong), not
// a NOT-THE-PAGE verdict about the site. test/not-the-page.test.js.

class NotThePage extends Error {
  constructor({ requested = null, landed, expected, reason = null }) {
    super(
      `not the page this recipe reads: landed on ${landed}, which does not match ${expected}` +
        (reason ? ` (${reason})` : '')
    );
    this.name = 'NotThePage';
    this.notThePage = { requested, landed, expected, reason };
  }
}

// The compiled pattern, or a thrown Error naming the bad pattern.
function compileExpectUrl(pattern) {
  if (typeof pattern !== 'string' || pattern === '') {
    throw new Error('expect_url step needs a non-empty "pattern" (a regular expression the landed URL must match)');
  }
  try {
    return new RegExp(pattern);
  } catch (e) {
    throw new Error(`expect_url pattern ${JSON.stringify(pattern)} is not a valid regular expression: ${e.message}`);
  }
}

// Null when `landed` matches; otherwise the NotThePage to throw. `landed` that
// is not a string (no URL could be read) never matches: an unknown page is
// not the page.
function checkExpectUrl({ pattern, landed, requested = null, reason = null }) {
  const rx = compileExpectUrl(pattern);
  if (typeof landed === 'string' && rx.test(landed)) return null;
  return new NotThePage({ requested, landed: typeof landed === 'string' ? landed : null, expected: pattern, reason });
}

// The run's `error` line, shared by the article/action and listing outputs.
function notThePageError(n) {
  return (
    `the browser landed on ${n.landed}${n.requested ? ` (asked for ${n.requested})` : ''}, ` +
    `which is not a page this recipe reads (expected a URL matching ${n.expected})` +
    (n.reason ? `: ${n.reason}` : '') +
    '. Nothing was extracted; the result is null, not empty.'
  );
}

module.exports = { NotThePage, compileExpectUrl, checkExpectUrl, notThePageError };
