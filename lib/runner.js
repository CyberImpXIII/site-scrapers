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

// Reads the FULL browser cookie jar via CDP (not page.cookies(), which only
// sees cookies for the page's current URL — this also catches cookies set
// on sibling subdomains during redirects, e.g. www vs a bare apex domain),
// then keeps only the ones that actually belong to `hostname` (exact match,
// or a domain-scoped cookie like '.example.com' that covers it).
async function saveSessionCookies(page, hostname, sessionName) {
  const client = await page.target().createCDPSession();
  let cookies;
  try {
    ({ cookies } = await client.send('Network.getAllCookies'));
  } finally {
    await client.detach();
  }
  const relevant = cookies.filter(c => {
    const d = c.domain.replace(/^\./, '');
    return hostname === d || hostname.endsWith(`.${d}`);
  });
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
      if (session) await saveSessionCookies(page, session.hostname, session.sessionName);
    }
  } finally {
    await browser.close();
  }
}

module.exports = { withPage, sessionFilePath, SESSION_DIR };
