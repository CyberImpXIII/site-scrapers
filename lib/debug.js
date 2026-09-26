const fs = require('fs');
const path = require('path');

// Gitignored, like .captures/.sessions — one directory per failed run,
// holding whatever a person (or Claude) would need to actually SEE why it
// failed, instead of guessing from an error string alone.
const DEBUG_DIR = path.join(__dirname, '..', 'data', '.debug');

// Keep only this many most-recent capture directories — these are
// diagnostic/disposable, not an audit trail (scrape_runs is), so unbounded
// growth serves no purpose. Directory names are timestamp-prefixed, so a
// plain sort is chronological.
const MAX_CAPTURES = 20;

// Console/network listeners are capped ring buffers, not unbounded logs —
// a 10-minute handoff could otherwise accumulate a huge amount of noise.
// This is also the seam a future ROLLING-WINDOW view ("what led up to the
// failure", not just the failure instant) would build on: entries already
// carry timestamps and are already bounded, so a later "last N seconds"
// filter is a read-time change, not a rewrite of how this collects data.
// Not yet implemented: periodic screenshots into a similar ring buffer,
// which would extend this from "one frame at failure" to "the last K
// frames leading up to it" — deliberately deferred until the single-frame
// version proves useful enough to justify the added storage/complexity.
const MAX_LOG_ENTRIES = 200;

function sanitizeForFilename(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]/g, '_');
}

function attachDiagnosticListeners(page) {
  const consoleLog = [];
  const networkFailures = [];
  page.on('console', msg => {
    consoleLog.push({ type: msg.type(), text: msg.text(), at: Date.now() });
    if (consoleLog.length > MAX_LOG_ENTRIES) consoleLog.shift();
  });
  page.on('requestfailed', req => {
    networkFailures.push({
      url: req.url(),
      method: req.method(),
      failure: req.failure()?.errorText ?? null,
      at: Date.now(),
    });
    if (networkFailures.length > MAX_LOG_ENTRIES) networkFailures.shift();
  });
  return { consoleLog, networkFailures };
}

function pruneOldCaptures() {
  if (!fs.existsSync(DEBUG_DIR)) return;
  const dirs = fs
    .readdirSync(DEBUG_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();
  const excess = dirs.length - MAX_CAPTURES;
  for (let i = 0; i < excess; i++) {
    fs.rmSync(path.join(DEBUG_DIR, dirs[i]), { recursive: true, force: true });
  }
}

// Best-effort, always — a failure capturing diagnostics about a failure
// must never itself throw and mask the original error.
async function captureFailureDiagnostics(page, meta, { error, consoleLog, networkFailures } = {}) {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dirName = `${stamp}__${sanitizeForFilename(meta.hostname)}__${sanitizeForFilename(meta.pageType)}__${sanitizeForFilename(meta.recipeName)}`;
    const dir = path.join(DEBUG_DIR, dirName);
    fs.mkdirSync(dir, { recursive: true });

    await page.screenshot({ path: path.join(dir, 'screenshot.png'), fullPage: true }).catch(() => {});
    const html = await page.content().catch(() => null);
    if (html) fs.writeFileSync(path.join(dir, 'dom.html'), html);

    fs.writeFileSync(path.join(dir, 'console.json'), JSON.stringify(consoleLog ?? [], null, 2));
    fs.writeFileSync(path.join(dir, 'network_failures.json'), JSON.stringify(networkFailures ?? [], null, 2));

    let url = null;
    try {
      url = page.url();
    } catch {
      /* page may already be in a bad state — url stays null */
    }
    fs.writeFileSync(
      path.join(dir, 'meta.json'),
      JSON.stringify(
        {
          hostname: meta.hostname,
          pageType: meta.pageType,
          recipeName: meta.recipeName,
          error: error?.message ?? error ?? null,
          url,
          capturedAt: new Date().toISOString(),
        },
        null,
        2
      )
    );

    pruneOldCaptures();
    return dir;
  } catch {
    return null;
  }
}

function listDebugCaptures() {
  if (!fs.existsSync(DEBUG_DIR)) return [];
  return fs
    .readdirSync(DEBUG_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(DEBUG_DIR, d.name, 'meta.json'), 'utf8'));
        return { dir: path.join(DEBUG_DIR, d.name), ...meta };
      } catch {
        return { dir: path.join(DEBUG_DIR, d.name) };
      }
    })
    .sort((a, b) => (a.capturedAt ?? '').localeCompare(b.capturedAt ?? ''));
}

module.exports = { attachDiagnosticListeners, captureFailureDiagnostics, listDebugCaptures, DEBUG_DIR, MAX_LOG_ENTRIES };
