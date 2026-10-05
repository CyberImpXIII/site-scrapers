// Whether a page that was asked for on one site ended up on ANOTHER site.
//
// Found 2026-10-05 (reported by applications' agent): a Greenhouse board slug
// whose company has its own careers page is forwarded off greenhouse.io --
// job-boards.greenhouse.io/stabilityai lands on stability.ai/careers,
// /dotmatics on www.dotmatics.com/jobs. The listing recipe then waited its
// full ready_timeout_ms for `tr.job-post` on a page that can never have it and
// reported a plain timeout with 0 records, which reads like "slow page" or "no
// openings" -- both wrong. The truthful answer is "this board is not here",
// with where it went.
//
// "Same site" is deliberately generous, so this only ever fires on a real
// change of site: the same host, a subdomain either way
// (boards.greenhouse.io -> job-boards.greenhouse.io), or the same last two
// labels. The last rule makes example.co.uk and other.co.uk "the same site",
// which is the safe direction: a missed forward leaves the old plain-timeout
// report, a false one would discard a real board's answer.
//
// Null when either URL does not parse: prefer no verdict to a guess.

function hostOf(u) {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return h ? h.replace(/^www\./, '') : null;
  } catch {
    return null;
  }
}

function sameSite(a, b) {
  if (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)) return true;
  const tail = (h) => h.split('.').slice(-2).join('.');
  return tail(a) === tail(b);
}

// { from, to, fromHost, toHost } when `finalUrl` is on a different site from
// `requestedUrl`, else null.
function forwardedOff(requestedUrl, finalUrl) {
  const fromHost = hostOf(requestedUrl);
  const toHost = hostOf(finalUrl);
  if (!fromHost || !toHost) return null;
  // about:blank / chrome-error pages have no host and never reach here; a
  // navigation that failed outright is the engine's own error, not a forward.
  if (sameSite(fromHost, toHost)) return null;
  return { from: requestedUrl, to: finalUrl, fromHost, toHost };
}

module.exports = { forwardedOff, sameSite, hostOf };
