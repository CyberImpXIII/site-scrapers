const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

// Session cookie jars — gitignored, mode-600, one file per (hostname,
// sessionName). ON BY DEFAULT: engine.js always passes a `session` option
// unless a run explicitly opts out (params.noSession), so a successful
// login (or any cookies a site sets) survives to the next invocation
// without needing a fresh handoff every time. `sessionName` (default
// 'default') supports keeping several parallel sessions for the same
// hostname — e.g. two different accounts — never conflated.
const SESSION_DIR = path.join(__dirname, '..', 'data', '.sessions');

function sanitizeForFilename(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]/g, '_');
}

function sessionFilePath(hostname, sessionName) {
  return path.join(
    SESSION_DIR,
    `${sanitizeForFilename(hostname)}__${sanitizeForFilename(sessionName || 'default')}.json`
  );
}

async function loadSessionCookies(page, hostname, sessionName) {
  const file = sessionFilePath(hostname, sessionName);
  if (!fs.existsSync(file)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(data.cookies) && data.cookies.length) {
      await page.setCookie(...data.cookies);
      return true;
    }
  } catch {
    /* corrupt/unreadable session file — proceed without one rather than fail the run */
  }
  return false;
}

// Two domains are "the same session" if either is the other, or either is
// a subdomain of the other — covers both directions: a cookie scoped to a
// wildcard parent ('.example.com' covering 'www.example.com'), AND a cookie
// scoped MORE specifically than our hostname (e.g. a host-only cookie on
// 'www.example.com' when we key sessions by the bare 'example.com' —
// exactly the case that silently dropped LinkedIn's actual auth cookie in
// testing: the recipe navigates to www.linkedin.com, but hostname is
// normalized to the bare 'linkedin.com', and the one-directional check this
// used to be missed a host-only www.linkedin.com cookie entirely).
function domainsMatch(cookieDomain, hostname) {
  const d = cookieDomain.replace(/^\./, '');
  return hostname === d || hostname.endsWith(`.${d}`) || d.endsWith(`.${hostname}`);
}

// Reads the FULL browser cookie jar via CDP (not page.cookies(), which only
// sees cookies for the page's current URL — this also catches cookies set
// on sibling subdomains during redirects, e.g. www vs a bare apex domain),
// then keeps only the ones that actually belong to `hostname` (either
// direction — see domainsMatch).
async function saveSessionCookies(page, hostname, sessionName) {
  const client = await page.target().createCDPSession();
  let cookies;
  try {
    ({ cookies } = await client.send('Network.getAllCookies'));
  } finally {
    await client.detach();
  }
  const relevant = cookies.filter(c => domainsMatch(c.domain, hostname));
  if (!relevant.length) return;
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.writeFileSync(
    sessionFilePath(hostname, sessionName),
    JSON.stringify(
      { hostname, sessionName: sessionName || 'default', savedAt: new Date().toISOString(), cookies: relevant },
      null,
      2
    ),
    { mode: 0o600 }
  );
}

/**
 * Launches a browser, runs a site module's scrape() against a fresh page,
 * and always closes the browser afterward (even on error).
 *
 * { headed: true } launches a real, visible window instead of headless —
 * used for a ui_steps sequence containing a 'handoff' step, so the person
 * running it can see the window and complete a manual step (2FA, CAPTCHA,
 * a final purchase confirmation, etc) directly in it.
 *
 * { session: { hostname, sessionName } } loads that session's saved cookies
 * before `fn` runs and saves the (possibly updated) cookie jar back
 * afterward, regardless of success/failure of `fn` itself failing — a
 * caller that wants no persistence for one run omits `session` entirely.
 */
async function withPage(fn, { headed = false, session } = {}) {
  const browser = await puppeteer.launch({
    headless: headed ? false : 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    // Puppeteer's own CDP-call timeout defaults to 180000ms (3 min) and
    // applies independently of any timeout we pass to waitForSelector/
    // waitForFunction — a handoff step's own timeout_ms (routinely 300000+
    // for a 2FA/checkpoint flow) would get silently overridden by this
    // shorter, unrelated limit. Found live: a Facebook login handoff with
    // timeout_ms:600000 failed with a raw "Runtime.callFunctionOn timed
    // out" after ~3 minutes, not our own timeout_ms's error path. Disabled
    // (0) since our own timeout_ms/ready_timeout_ms already bound every
    // wait we actually care about — this was a redundant, shorter cap
    // working against them, not protecting anything.
    protocolTimeout: 0,
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1000 });
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
    );
    if (session) await loadSessionCookies(page, session.hostname, session.sessionName);
    try {
      return await fn(page);
    } finally {
      // Best-effort: if fn(page) already threw because the page/target is
      // gone (browser crashed, window closed), saving cookies here would
      // throw its own error and — since this is a finally block — SILENTLY
      // REPLACE fn(page)'s real error with this one. Swallow failures here
      // so whatever fn(page) actually threw is what the caller sees.
      if (session) {
        try {
          await saveSessionCookies(page, session.hostname, session.sessionName);
        } catch {
          /* best-effort persistence; never mask fn(page)'s real error */
        }
      }
    }
  } finally {
    await browser.close();
  }
}

module.exports = { withPage, sessionFilePath, SESSION_DIR };
