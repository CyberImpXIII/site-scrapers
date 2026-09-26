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
// Entries carry timestamps, so a "last N seconds" view is a read-time
// filter rather than a change to how this collects.
const MAX_LOG_ENTRIES = 200;

// Rolling screenshot window: the same ring-buffer idea applied to frames,
// so a failure shows the SEQUENCE leading up to it, not just the final
// frozen state — which is what distinguishes "the page never loaded" from
// "it loaded, then something navigated away" or "a modal appeared and ate
// the click". Frames are held in memory and only written to disk if the
// run actually fails, so successful runs cost nothing but the periodic
// screenshot itself.
const DEFAULT_ROLLING_FRAMES = 6;
const DEFAULT_ROLLING_INTERVAL_MS = 2000;

function sanitizeForFilename(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]/g, '_');
}

// Periodically screenshots into a bounded in-memory ring buffer. Every
// capture is best-effort: page.screenshot() legitimately throws mid
// navigation or once the target is gone, and a dropped frame is far better
// than a diagnostic tool breaking the run it's observing. `inFlight` guards
// against piling up overlapping captures when screenshots take longer than
// the interval.
function startRollingCapture(page, { frames = DEFAULT_ROLLING_FRAMES, intervalMs = DEFAULT_ROLLING_INTERVAL_MS } = {}) {
  if (!frames || frames <= 0) return null;
  const buf = [];
  let inFlight = false;
  let stopped = false;

  const snap = async () => {
    if (inFlight || stopped) return;
    inFlight = true;
    try {
      const png = await page.screenshot({ type: 'png' });
      if (!stopped) {
        buf.push({ at: Date.now(), png });
        while (buf.length > frames) buf.shift();
      }
    } catch {
      /* navigating, detached, or closed — skip this frame */
    } finally {
      inFlight = false;
    }
  };

  // Take one immediately rather than waiting out the first interval. A run
  // that fails in under one interval would otherwise capture either nothing
  // or a single frame taken milliseconds before the failure — i.e. a
  // duplicate of screenshot.png, which is the opposite of the "what did
  // this look like BEFORE it broke" signal the window exists for.
  snap();
  const timer = setInterval(snap, intervalMs);
  // Never let the diagnostic timer be the reason the process stays alive.
  if (typeof timer.unref === 'function') timer.unref();

  return {
    intervalMs,
    frames: buf,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

function attachDiagnosticListeners(page, rollingOpts = {}) {
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
  const rolling = startRollingCapture(page, rollingOpts);
  return { consoleLog, networkFailures, rolling };
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
async function captureFailureDiagnostics(page, meta, { error, consoleLog, networkFailures, rolling } = {}) {
  try {
    const failedAt = Date.now();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dirName = `${stamp}__${sanitizeForFilename(meta.hostname)}__${sanitizeForFilename(meta.pageType)}__${sanitizeForFilename(meta.recipeName)}`;
    const dir = path.join(DEBUG_DIR, dirName);
    fs.mkdirSync(dir, { recursive: true });

    await page.screenshot({ path: path.join(dir, 'screenshot.png'), fullPage: true }).catch(() => {});
    const html = await page.content().catch(() => null);
    if (html) fs.writeFileSync(path.join(dir, 'dom.html'), html);

    fs.writeFileSync(path.join(dir, 'console.json'), JSON.stringify(consoleLog ?? [], null, 2));
    fs.writeFileSync(path.join(dir, 'network_failures.json'), JSON.stringify(networkFailures ?? [], null, 2));

    // The rolling window, oldest first. Filenames carry how long before the
    // failure each frame was taken, so the sequence reads in order without
    // opening meta — "the page was fine at t-8s, blank by t-2s" is the
    // thing a single final frame can't tell you.
    const rollingFrames = [];
    if (rolling && rolling.frames && rolling.frames.length) {
      const framesDir = path.join(dir, 'frames');
      fs.mkdirSync(framesDir, { recursive: true });
      rolling.frames.forEach((f, i) => {
        const msBefore = Math.max(0, failedAt - f.at);
        const name = `frame-${String(i + 1).padStart(2, '0')}-t-minus-${msBefore}ms.png`;
        try {
          fs.writeFileSync(path.join(framesDir, name), f.png);
          rollingFrames.push({ file: path.join('frames', name), msBeforeFailure: msBefore });
        } catch {
          /* one unwritable frame shouldn't abort the rest of the capture */
        }
      });
    }

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
          rollingIntervalMs: rolling?.intervalMs ?? null,
          rollingFrames,
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
