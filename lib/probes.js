// Probes REPORT; they never act and never fail a run.
//
// Every other step type in the vocabulary exists to change the page. That
// left no way for a recipe to answer "what is actually here?", which is the
// question you have when a recipe you're building doesn't work — so the
// only way to find out was to re-run the whole sequence and look at a
// screenshot by hand.
//
// A probe returns a plain object and swallows its own errors into an
// `error` field. A probe that threw would defeat the purpose: diagnostics
// run when things are already broken, often against a half-dead page.
//
// SAFETY: probes never report the VALUE of any form field. A page mid-login
// can hold a typed password, and diagnostics get written to disk and read
// back into a transcript. Names, types and labels only.

// Cap everything. A probe runs against pages that may be enormous or
// hostile, and its output is read by a model — an unbounded dump is both a
// hang risk and a token bomb.
const MAX_CANDIDATES = 8;
const MAX_SAMPLE_CHARS = 120;
const MAX_FIELDS = 40;
const MAX_MATCHES = 5;
const PROBE_TIMEOUT_MS = 5000;

function truncate(s, n = MAX_SAMPLE_CHARS) {
  if (typeof s !== 'string') return null;
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length > n ? `${clean.slice(0, n)}…` : clean;
}

// page.evaluate can hang on a wedged renderer; a probe must not be the
// thing that turns a failed run into a stuck one.
function withTimeout(promise, ms, onTimeout) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(onTimeout), ms)),
  ]);
}

// --- selectors -------------------------------------------------------------
// "Do these exist, how many, and are they visible?" — the check you'd
// otherwise do by re-running with a changed selector and seeing if it times
// out. Note this runs in page context, so Puppeteer's ::-p-text() custom
// selectors are NOT available here; plain CSS only.
async function probeSelectors(page, selectors) {
  const list = (Array.isArray(selectors) ? selectors : String(selectors || '').split(','))
    .map(s => String(s).trim())
    .filter(Boolean)
    .slice(0, MAX_MATCHES * 4);
  if (!list.length) return { kind: 'selectors', error: 'no selectors given' };

  const results = await withTimeout(
    page.evaluate((sels, maxChars) => {
      const visible = el => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
      };
      return sels.map(sel => {
        try {
          const nodes = Array.from(document.querySelectorAll(sel));
          return {
            selector: sel,
            count: nodes.length,
            visible: nodes.filter(visible).length,
            sample: nodes.length ? (nodes[0].innerText || nodes[0].textContent || '').slice(0, maxChars) : null,
          };
        } catch (e) {
          return { selector: sel, error: `invalid selector: ${e.message}` };
        }
      });
    }, list, MAX_SAMPLE_CHARS),
    PROBE_TIMEOUT_MS,
    null
  );
  if (!results) return { kind: 'selectors', error: 'timed out evaluating selectors' };
  return { kind: 'selectors', matches: results.map(r => ({ ...r, sample: truncate(r.sample) })) };
}

// --- repeated_structure ----------------------------------------------------
// The card finder. Getting card_selector / card_anchor_text wrong is the
// single most common reason a new listing recipe returns zero results, and
// the usual fix is a blind guess followed by another full run. This reports
// the containers that actually hold repeated sibling structures, with the
// evidence needed to choose between card_selector and card_anchor_text.
async function probeRepeatedStructure(page, minGroup = 3) {
  const found = await withTimeout(
    page.evaluate((minGroupSize, maxCandidates, maxChars) => {
      const sig = el => `${el.tagName}.${Array.from(el.classList).sort().join('.')}`;
      // A selector a recipe could actually use. Auto-generated class names
      // (Tailwind JIT and friends) make this unreliable, which is exactly
      // why sampleText is reported alongside — card_anchor_text is often
      // the better choice and the caller needs to see both.
      const selectorFor = el => {
        if (el.id) return `#${el.id}`;
        const classes = Array.from(el.classList).filter(c => !/^[a-z]+-\[/.test(c)).slice(0, 2);
        return classes.length ? `${el.tagName.toLowerCase()}.${classes.join('.')}` : el.tagName.toLowerCase();
      };
      const out = [];
      for (const parent of document.querySelectorAll('body *')) {
        const kids = Array.from(parent.children);
        if (kids.length < minGroupSize) continue;
        const groups = new Map();
        for (const k of kids) {
          const s = sig(k);
          if (!groups.has(s)) groups.set(s, []);
          groups.get(s).push(k);
        }
        for (const [, members] of groups) {
          if (members.length < minGroupSize) continue;
          const texts = members.map(m => (m.innerText || '').trim()).filter(Boolean);
          if (texts.length < minGroupSize) continue;
          const avgLen = texts.reduce((a, t) => a + t.length, 0) / texts.length;
          if (avgLen < 20) continue; // nav lists, tag chips, pagination
          const withHref = members.filter(m => m.querySelector('a[href]') || m.matches('a[href]')).length;
          out.push({
            containerSelector: selectorFor(parent),
            childSelector: selectorFor(members[0]),
            count: members.length,
            avgTextLength: Math.round(avgLen),
            childrenWithLinks: withHref,
            sampleText: texts[0].slice(0, maxChars),
            // The most repeated literal line across members -- a strong
            // card_anchor_text candidate ("View job", "Apply").
            sharedLine: (() => {
              const counts = new Map();
              for (const t of texts) {
                for (const line of t.split('\n').map(l => l.trim()).filter(l => l && l.length < 40)) {
                  counts.set(line, (counts.get(line) || 0) + 1);
                }
              }
              let best = null;
              for (const [line, n] of counts) {
                if (n >= Math.min(members.length, minGroupSize) && (!best || n > best.n)) best = { line, n };
              }
              return best ? best.line : null;
            })(),
          });
        }
      }
      // Deepest/richest first: an outer wrapper technically "repeats" too,
      // but the tight group around the real cards is what you want.
      out.sort((a, b) => b.count * b.avgTextLength - a.count * a.avgTextLength);
      return out.slice(0, maxCandidates);
    }, minGroup, MAX_CANDIDATES, MAX_SAMPLE_CHARS),
    PROBE_TIMEOUT_MS,
    null
  );
  if (!found) return { kind: 'repeated_structure', error: 'timed out scanning for repeated structure' };
  return {
    kind: 'repeated_structure',
    candidates: found.map(c => ({ ...c, sampleText: truncate(c.sampleText) })),
    hint: found.length
      ? 'Prefer sharedLine as card_anchor_text when present; fall back to childSelector as card_selector. Auto-generated class names make selectors brittle.'
      : 'No repeated structure found — the page may not have loaded, may be a login/blocker page, or may render cards in an iframe.',
  };
}

// --- blockers --------------------------------------------------------------
// "Did I get the page I asked for, or a wall?" Distinguishes the failure
// modes that look identical in a bare timeout.
async function probeBlockers(page) {
  const found = await withTimeout(
    page.evaluate(maxChars => {
      const bodyText = (document.body?.innerText || '').slice(0, 4000);
      const frames = Array.from(document.querySelectorAll('iframe')).map(f => f.src || '');
      const has = re => re.test(bodyText);
      return {
        captcha:
          frames.some(s => /recaptcha|hcaptcha|turnstile|arkoselabs|funcaptcha/i.test(s)) ||
          has(/verify (you are|you're) (a )?human|are you a robot|complete the security check/i),
        botCheck: has(/unusual traffic|automated queries|access denied|request blocked|rate limit|too many requests/i),
        loginWall:
          !!document.querySelector('input[type="password"]') ||
          has(/sign in to continue|log in to continue|please sign in|members only/i),
        consentOverlay: Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], #cookie-banner, .cookie-banner'))
          .some(el => /cookie|consent|privacy|gdpr|accept all/i.test(el.innerText || '')),
        scrollLocked: getComputedStyle(document.body).overflow === 'hidden',
        // A near-empty body after a "successful" load usually means an SPA
        // that never hydrated, or content behind a wall.
        bodyTextLength: bodyText.length,
        title: (document.title || '').slice(0, maxChars),
        sample: bodyText.slice(0, maxChars),
      };
    }, MAX_SAMPLE_CHARS),
    PROBE_TIMEOUT_MS,
    null
  );
  if (!found) return { kind: 'blockers', error: 'timed out checking for blockers' };

  const flags = ['captcha', 'botCheck', 'loginWall', 'consentOverlay'].filter(k => found[k]);
  if (found.bodyTextLength < 200) flags.push('nearlyEmptyBody');
  return {
    kind: 'blockers',
    blocked: flags.length > 0,
    flags,
    title: truncate(found.title),
    bodyTextLength: found.bodyTextLength,
    sample: truncate(found.sample),
  };
}

// --- forms -----------------------------------------------------------------
// For action recipes: what is there to fill in, and what should the
// selectors be. Never reports a field's value.
async function probeForms(page) {
  const found = await withTimeout(
    page.evaluate(maxFields => {
      const labelFor = el => {
        if (el.id) {
          const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (l) return (l.innerText || '').trim();
        }
        return (el.closest('label')?.innerText || '').trim() || null;
      };
      const sel = el =>
        el.id ? `#${el.id}` : el.name ? `${el.tagName.toLowerCase()}[name="${el.name}"]` : el.tagName.toLowerCase();
      return Array.from(document.querySelectorAll('input, select, textarea'))
        .filter(el => el.type !== 'hidden')
        .slice(0, maxFields)
        .map(el => ({
          selector: sel(el),
          tag: el.tagName.toLowerCase(),
          type: el.type || null,
          name: el.name || null,
          label: labelFor(el),
          placeholder: el.placeholder || null,
          required: !!el.required,
          // NEVER el.value -- may be a typed password or token.
          hasValue: !!el.value,
        }));
    }, MAX_FIELDS),
    PROBE_TIMEOUT_MS,
    null
  );
  if (!found) return { kind: 'forms', error: 'timed out describing forms' };
  const submits = found.filter(f => f.type === 'submit' || f.type === 'button').length;
  return {
    kind: 'forms',
    fields: found.map(f => ({ ...f, label: truncate(f.label, 60), placeholder: truncate(f.placeholder, 60) })),
    passwordFieldPresent: found.some(f => f.type === 'password'),
    submitControls: submits,
  };
}

const PROBE_KINDS = {
  selectors: (page, step) => probeSelectors(page, step.selectors),
  repeated_structure: (page, step) => probeRepeatedStructure(page, step.min_group ?? 3),
  blockers: page => probeBlockers(page),
  forms: page => probeForms(page),
};

// Runs one probe for a `probe` step. Always resolves; never throws.
async function runProbe(page, step) {
  const kind = step.kind || 'blockers';
  const fn = PROBE_KINDS[kind];
  const label = step.label || kind;
  if (!fn) {
    return { label, kind, error: `unknown probe kind "${kind}" — known: ${Object.keys(PROBE_KINDS).join(', ')}` };
  }
  try {
    return { label, ...(await fn(page, step)) };
  } catch (e) {
    return { label, kind, error: e.message };
  }
}

// The standard sweep run automatically when a run fails, so a failure
// explains itself without a second run. Deliberately excludes `selectors`,
// which needs caller-supplied input.
async function autoDiagnose(page) {
  const out = [];
  for (const kind of ['blockers', 'repeated_structure', 'forms']) {
    out.push(await runProbe(page, { kind, label: `auto:${kind}` }));
  }
  return out;
}

module.exports = { runProbe, autoDiagnose, PROBE_KINDS };
