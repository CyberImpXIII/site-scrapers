// An OPT-IN screenshot of the form after a dry fill (2026-10-04), asked for by
// the applications side (applications/docs/FILL-CONTRACT.md "## Screenshot":
// a packet's `screenshot` stayed null because the fill returned none).
//
// It is not part of the `fill` object -- applications' port of the contract
// rejects unknown keys there -- but a sibling top-level key, `fillScreenshot`,
// documented in docs/fill-output.md "## Screenshot" and gated by
// test/fill-screenshot.test.js:
//
//   absent              no fill_form ran
//   null                the caller did not ask (params.fillScreenshot not true)
//   {path, error:null}  taken: an absolute .png path, mode 0600
//   {path:null, error}  asked for, not taken; `error` says why
//
// THE IMAGE HOLDS THE FILLED ANSWERS -- the one place this action's output
// leads to an answer. Hence: never by default, never a value in the output
// (only the path), mode 0600 in a 0700 gitignored directory, pruned to the
// newest MAX_FILL_SHOTS. A caller that keeps it copies it into its own
// private store; the path here is not permanent.
//
// Taking it is a screenshot and nothing else: no click, no key, no scroll
// by script (puppeteer's fullPage resizes the viewport, it does not scroll
// the document). It can never submit.

const fs = require('fs');
const path = require('path');

const FILL_SHOT_DIR = path.join(__dirname, '..', 'data', '.fills');
const MAX_FILL_SHOTS = 50;
const SHOT_KEYS = ['path', 'error'];

function sanitize(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]/g, '_');
}

function prune(dir, keep) {
  const pngs = fs
    .readdirSync(dir)
    .filter(n => n.endsWith('.png'))
    .sort();
  for (const n of pngs.slice(0, Math.max(0, pngs.length - keep))) fs.rmSync(path.join(dir, n), { force: true });
}

// `requested` is params.fillScreenshot as the caller sent it. Never throws: a
// screenshot that fails must not turn a finished fill into an engine error.
async function takeFillScreenshot(page, requested, meta, { dir = FILL_SHOT_DIR, keep = MAX_FILL_SHOTS } = {}) {
  if (requested === undefined || requested === null || requested === false) return null;
  if (requested !== true) return { path: null, error: 'fillScreenshot must be true or false' };
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `${stamp}__${sanitize(meta?.hostname || 'unknown')}__${process.pid}.png`);
    const png = await page.screenshot({ type: 'png', fullPage: true });
    fs.writeFileSync(file, png, { mode: 0o600, flag: 'wx' });
    try {
      prune(dir, keep);
    } catch {
      /* a prune failure leaves an extra file, not a wrong answer */
    }
    return { path: file, error: null };
  } catch (e) {
    return { path: null, error: `screenshot not taken: ${String(e && e.message).slice(0, 200)}` };
  }
}

// Problems with one `fillScreenshot` value (empty = valid). `requested` is
// what the caller sent, so "asked and got null" is a violation too.
function validateFillScreenshot(v, requested) {
  if (requested !== true && requested !== undefined && requested !== null && requested !== false) {
    return v && v.path === null && typeof v.error === 'string' ? [] : ['a malformed fillScreenshot param must come back as {path:null, error}'];
  }
  if (requested !== true) return v === null ? [] : ['fillScreenshot must be null when not asked for'];
  if (!v || typeof v !== 'object') return ['fillScreenshot was asked for and is not an object'];
  const p = [];
  const extra = Object.keys(v).filter(k => !SHOT_KEYS.includes(k));
  if (extra.length) p.push(`unexpected keys in fillScreenshot: ${extra.join(', ')}`);
  if (v.path === null) {
    if (typeof v.error !== 'string' || !v.error) p.push('fillScreenshot without a path must say why in error');
  } else if (typeof v.path !== 'string' || !path.isAbsolute(v.path) || !v.path.endsWith('.png')) {
    p.push('fillScreenshot.path must be an absolute .png path or null');
  } else if (v.error !== null) {
    p.push('fillScreenshot.error must be null when a path is given');
  }
  return p;
}

module.exports = { takeFillScreenshot, validateFillScreenshot, FILL_SHOT_DIR, MAX_FILL_SHOTS, SHOT_KEYS };
