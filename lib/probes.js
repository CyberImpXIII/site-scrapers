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

      // A class name that will change the next time the site rebuilds:
      // emotion/styled-components hashes (css-1q2dra3, sc-bdVaJa), Tailwind
      // arbitrary values (w-[32px]), CSS-modules suffixes (Card_root__a1b2c),
      // and anything ending in a long hex-ish run. Proposing one of these as
      // a card_selector is worse than proposing nothing: it works today and
      // silently breaks later.
      const isGeneratedClass = c =>
        /^[a-z]+-\[/.test(c) ||
        /^(css|sc|emotion|jsx)-[a-z0-9]{4,}$/i.test(c) ||
        /__[A-Za-z0-9]{5,}$/.test(c) ||
        /-[a-f0-9]{6,}$/i.test(c) ||
        /^[a-z]{1,3}[0-9]{4,}$/i.test(c);

      // Stable hooks a site puts there on purpose, in descending order of
      // how deliberate they are. A Workday tenant's card wrapper carries no
      // stable class at all, but every one of them marks the title link with
      // data-automation-id — so the usable selector is structural, anchored
      // to the hook. Reported separately from the class guess so the caller
      // can prefer it.
      const STABLE_ATTRS = ['data-testid', 'data-test-id', 'data-qa', 'data-automation-id', 'data-cy', 'data-test', 'itemtype'];
      const stableHookFor = el => {
        for (const attr of STABLE_ATTRS) {
          if (el.hasAttribute(attr)) return `${el.tagName.toLowerCase()}[${attr}="${el.getAttribute(attr)}"]`;
        }
        // Not on the container itself — find one on a descendant and express
        // the card structurally through it.
        for (const attr of STABLE_ATTRS) {
          const inner = el.querySelector(`[${attr}]`);
          if (inner) {
            return `${el.tagName.toLowerCase()}:has(${inner.tagName.toLowerCase()}[${attr}="${inner.getAttribute(attr)}"])`;
          }
        }
        if (el.getAttribute('role')) return `${el.tagName.toLowerCase()}[role="${el.getAttribute('role')}"]`;
        return null;
      };

      const selectorFor = el => {
        if (el.id && !isGeneratedClass(el.id)) return `#${el.id}`;
        const classes = Array.from(el.classList).filter(c => !isGeneratedClass(c)).slice(0, 2);
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
            stableHook: stableHookFor(members[0]),
            selectorIsGenerated: Array.from(members[0].classList).some(isGeneratedClass),
            // The most repeated literal line across members -- a strong
            // card_anchor_text candidate ("View job", "Apply").
            //
            // Requires a near-universal majority, not just minGroupSize.
            // A looser threshold proposed "7wFeatured" on a real site: a
            // per-card relative-age string concatenated to a Featured badge
            // with no separating whitespace. It appeared in the handful of
            // cards that happened to be 7 weeks old, cleared a 3-of-6 bar,
            // and would have matched almost nothing in practice. Since
            // card_anchor_text must match EVERY card to be useful, demanding
            // it actually appear in nearly every card is the honest test.
            ...(() => {
              const counts = new Map();
              for (const m of members) {
                // Drawn from <a>/<button> text ONLY, because that is exactly
                // what card_anchor_text is matched against at extraction
                // time (exact textContent of an a/button). Scanning all
                // innerText lines instead produced candidates that could
                // never match: "7wFeatured" (a per-card age glued to a
                // badge) and "·" (a separator character).
                const seen = new Set(
                  Array.from(m.querySelectorAll('a, button'))
                    .map(el => el.textContent.trim())
                    .filter(txt => txt && txt.length >= 3 && txt.length < 40 && /[a-z]/i.test(txt))
                );
                for (const line of seen) counts.set(line, (counts.get(line) || 0) + 1);
              }
              const required = Math.max(minGroupSize, Math.ceil(members.length * 0.8));
              let best = null;
              for (const [line, n] of counts) {
                if (n >= required && (!best || n > best.n)) best = { line, n };
              }
              return {
                sharedLine: best ? best.line : null,
                sharedLineIn: best ? `${best.n}/${members.length}` : null,
              };
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
      ? 'Order of preference: stableHook (a data-* attribute the site set deliberately) > sharedLine as card_anchor_text > childSelector as card_selector. ' +
        'sharedLineIn shows how many cards actually contain that line — it must be nearly all of them to work as card_anchor_text. ' +
        'When selectorIsGenerated is true, childSelector rests on a build-hashed class that will break on the site\'s next deploy; use stableHook or read dom.html for a real hook instead.'
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
        // A challenge FRAME existing is not a wall — a site can embed
        // reCAPTCHA on a form while serving its content perfectly, and
        // jobspresso.co does exactly that. So a frame only counts when the
        // page is otherwise empty; challenge TEXT is trusted on its own. For
        // anything more detailed, the `antibot` probe reports which service it
        // is, where it was seen, and whether it dominates the page.
        captcha:
          has(/verify (you are|you're) (a )?human|are you a robot|complete the security check/i) ||
          (frames.some(s => /recaptcha|hcaptcha|turnstile|arkoselabs|funcaptcha/i.test(s)) && bodyText.length < 500),
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
      const fields = Array.from(document.querySelectorAll('input, select, textarea'))
        .filter(el => el.type !== 'hidden')
        .slice(0, maxFields)
        .map(el => {
          const label = labelFor(el);
          // Greenhouse marks required fields with a "*" in the LABEL and
          // leaves the HTML attribute off entirely, so `el.required` alone
          // reported 31 fields as optional on a form where most were not.
          // Lever uses "✱". Trusting only the attribute understates the
          // form, which is the dangerous direction for something a person
          // is about to fill in.
          const markedInLabel = /[*✱]|\(required\)|\brequired\b/i.test(label || '');
          return {
            selector: sel(el),
            tag: el.tagName.toLowerCase(),
            type: el.type || null,
            name: el.name || null,
            label,
            placeholder: el.placeholder || null,
            required: !!el.required || el.getAttribute('aria-required') === 'true' || markedInLabel,
            requiredEvidence: el.required ? 'attribute' : markedInLabel ? 'label marker' : null,
            // NEVER el.value -- may be a typed password or token.
            hasValue: !!el.value,
          };
        });

      // Counted separately: a modern form's submit is a <button>, which is
      // not matched by the input/select/textarea query above, so this read 0
      // submit controls on all three real ATS forms tested.
      const submits = Array.from(
        document.querySelectorAll('button, input[type="submit"], input[type="button"]')
      )
        .filter(el => {
          const t = (el.getAttribute('type') || '').toLowerCase();
          if (el.tagName === 'INPUT') return true;
          if (t === 'button') return /submit|apply|send/i.test(el.textContent || '');
          return t === 'submit' || !t || /submit|apply|send/i.test(el.textContent || '');
        })
        .slice(0, 10)
        .map(el => ({
          selector: sel(el),
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || el.value || '').trim().slice(0, 60) || null,
        }));

      return { fields, submits };
    }, MAX_FIELDS),
    PROBE_TIMEOUT_MS,
    null
  );
  if (!found) return { kind: 'forms', error: 'timed out describing forms' };
  const fields = found.fields.map(f => ({ ...f, label: truncate(f.label, 60), placeholder: truncate(f.placeholder, 60) }));
  return {
    kind: 'forms',
    fields,
    requiredCount: fields.filter(f => f.required).length,
    passwordFieldPresent: fields.some(f => f.type === 'password'),
    fileUploadPresent: fields.some(f => f.type === 'file'),
    submitControls: found.submits.length,
    // Named, so a recipe author can see what would be clicked — and so a
    // reviewer can confirm a recipe does NOT click it.
    submits: found.submits,
  };
}

// --- empty_state -----------------------------------------------------------
// "Nothing came back" has three completely different causes and they need
// different responses: the site legitimately has no matches, a wall is in the
// way, or the selector is wrong. Guessing wrong is expensive — a recipe gets
// re-derived when the real answer was "that keyword has no jobs today".
//
// This is a heuristic about RECORD LOOKUPS in general, not about any one
// site, which is why it belongs here (and as a generic action) rather than
// baked into a recipe: any listing on any site can come back empty.
// `recordNouns` is a PARAMETER, not a constant. An earlier version baked
// "jobs, openings, positions, vacancies" into the pattern list, which quietly
// made this a job-board probe pretending to be a generic one — the noun for
// whatever a page lists is a property of the site, so it belongs in the
// calling recipe's `with:` clause. The defaults are domain-neutral.
const DEFAULT_RECORD_NOUNS = ['results', 'matches', 'items', 'records'];
async function probeEmptyState(page, recordNouns) {
  // An unsubstituted "{{param}}" means the caller passed nothing, so fall
  // back rather than searching the page for a literal placeholder.
  const nouns = (Array.isArray(recordNouns) ? recordNouns : String(recordNouns ?? '').split(','))
    .map(n => n.trim())
    .filter(n => n && !/^\{\{.*\}\}$/.test(n));
  const list = (nouns.length ? nouns : DEFAULT_RECORD_NOUNS).slice(0, 12);

  const found = await withTimeout(
    page.evaluate((maxChars, nounList) => {
      const text = (document.body?.innerText || '').slice(0, 6000);
      const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const alt = nounList.map(esc).join('|');
      // Phrases a site uses when it means "your query matched nothing".
      // Deliberately narrow: a false positive here tells you to stop looking
      // for a bug that is real.
      const patterns = [
        new RegExp(`\\bno (?:${alt})\\b`, 'i'),
        new RegExp(`\\b0 (?:${alt})\\b`, 'i'),
        new RegExp(`\\bfound no (?:${alt})\\b`, 'i'),
        /\bnothing (?:found|matched)\b/i,
        /\bwe (?:could ?n'?t|did ?n'?t) find\b/i,
        /\btry (?:a )?(?:different|another|broadening|adjusting)\b/i,
        /\bbroaden your search\b/i,
      ];
      const hits = patterns.map(re => (text.match(re) || [null])[0]).filter(Boolean);
      // How much repeated structure exists at all. A page with genuinely no
      // records looks different from one where cards are present but the
      // selector missed them.
      // Only VISIBLE siblings carrying real text count. Counting every
      // sibling group called a USAJOBS shell "records_present_selector_wrong"
      // on the strength of an 817-item hidden agency filter list, when the
      // page had 1.6KB of text and simply had not rendered its results.
      const isRecordish = el => {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') return false;
        return (el.innerText || '').trim().length >= 20;
      };
      let maxSiblingGroup = 0;
      for (const parent of document.querySelectorAll('body *')) {
        const kids = Array.from(parent.children).filter(isRecordish);
        if (kids.length < 3) continue;
        const counts = new Map();
        for (const k of kids) {
          const sig = `${k.tagName}.${Array.from(k.classList).sort().join('.')}`;
          counts.set(sig, (counts.get(sig) || 0) + 1);
        }
        for (const [, n] of counts) if (n > maxSiblingGroup) maxSiblingGroup = n;
      }
      return {
        explicitEmptyMessage: hits[0] ? hits[0].slice(0, maxChars) : null,
        matchedPhrases: hits.length,
        largestSiblingGroup: maxSiblingGroup,
        bodyTextLength: text.length,
      };
    }, MAX_SAMPLE_CHARS, list),
    PROBE_TIMEOUT_MS,
    null
  );
  if (!found) return { kind: 'empty_state', error: 'timed out checking for an empty-result state' };

  // Ordered most-confident first. "The site said so" beats any inference.
  const likelyCause = found.explicitEmptyMessage
    ? 'genuinely_empty'
    : found.bodyTextLength < 200
      ? 'page_never_rendered'
      : found.largestSiblingGroup >= 3
        ? 'records_present_selector_wrong'
        : 'no_records_and_no_message';

  return {
    kind: 'empty_state',
    likelyCause,
    explicitEmptyMessage: truncate(found.explicitEmptyMessage),
    largestSiblingGroup: found.largestSiblingGroup,
    bodyTextLength: found.bodyTextLength,
    advice: {
      genuinely_empty:
        'The page itself says there are no matches. The recipe is probably fine — re-check with a query known to return results before changing anything.',
      page_never_rendered:
        'Almost no text on the page: it never rendered (raise ready_timeout_ms), or the content is behind a wall — check the blockers probe.',
      records_present_selector_wrong:
        'Repeated structure IS on the page, so records exist and the card matcher missed them. See the repeated_structure candidates.',
      no_records_and_no_message:
        'No records, no repeated structure and no "no results" message. Most often a wall or a redirect — check the blockers probe and the final URL.',
    }[likelyCause],
  };
}

// --- antibot ---------------------------------------------------------------
// Anti-bot services are their own problem and the generic `blockers` probe
// handles them badly. Two reasons:
//
//   1. They do not appear in one consistent place. Cloudflare can show as a
//      title ("Just a moment..."), a #cf-wrapper element, a
//      /cdn-cgi/challenge-platform/ script, a Turnstile iframe, or just a
//      "Ray ID" in the body — and which one depends on the challenge type and
//      how far it got. Matching a single location misses most of them.
//   2. "A challenge widget exists on this page" is not "a challenge is
//      blocking this page". jobspresso.co embeds a reCAPTCHA for its
//      job-posting form, and `blockers` called a perfectly loaded page
//      captcha-walled because of it.
//
// So this reports WHICH service, WHERE each signal was found, and separately
// whether the challenge is actually the page's content. It diagnoses only —
// nothing here attempts to solve, defeat or evade a challenge.
// Signatures come from failures.db's blocker_signatures table, so a
// discovery made while troubleshooting is usable immediately and permanently
// without a code change. The code baseline is only the seed.
//
// Cached per process: this runs inside a failing scrape, and re-reading the
// table for every probe would add writes and lock pressure to exactly the
// moment things are already going wrong.
let signatureCache = null;
function loadSignatures() {
  if (signatureCache) return signatureCache;
  try {
    const { openFailuresDb, listBlockerSignatures } = require('../failuresDb');
    const db = openFailuresDb();
    const rows = listBlockerSignatures(db);
    db.close();
    if (rows.length) {
      signatureCache = rows.map(r => ({
        service: r.service,
        where_seen: r.where_seen,
        pattern: r.pattern,
        flags: r.flags,
        blocking_weight: r.blocking_weight,
      }));
      return signatureCache;
    }
  } catch {
    /* DB unavailable (fresh clone, permissions, a copied-out probes.js in a
       test) — fall through to the code baseline rather than losing the probe */
  }
  const { BLOCKER_SIGNATURES } = require('./blockerSignatures');
  signatureCache = BLOCKER_SIGNATURES.map(([service, where_seen, pattern, flags, blocking_weight]) => ({
    service,
    where_seen,
    pattern,
    flags,
    blocking_weight,
  }));
  return signatureCache;
}


async function probeAntibot(page) {
  const sigs = loadSignatures();
  const found = await withTimeout(
    page.evaluate((rows, maxChars) => {
      const title = document.title || '';
      const body = (document.body?.innerText || '').slice(0, 6000);
      const resources = [
        ...Array.from(document.querySelectorAll('script[src]')).map(s => s.src),
        ...Array.from(document.querySelectorAll('iframe[src]')).map(f => f.src),
        ...Array.from(document.querySelectorAll('link[href]')).map(l => l.href),
      ];
      const visibleArea = el => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') return 0;
        return Math.max(0, r.width) * Math.max(0, r.height);
      };

      const byService = new Map();
      for (const row of rows) {
        let hit = null;
        let area = 0;
        try {
          if (row.where_seen === 'dom') {
            const els = Array.from(document.querySelectorAll(row.pattern));
            if (els.length) {
              area = Math.max(...els.map(visibleArea));
              hit = row.pattern.split(',')[0].trim();
            }
          } else {
            const re = new RegExp(row.pattern, row.flags || '');
            const haystack =
              row.where_seen === 'title' ? title : row.where_seen === 'body' ? body : resources.join('\n');
            const m = haystack.match(re);
            if (m) hit = (m[0] || '').slice(0, maxChars);
          }
        } catch {
          // A malformed pattern in one row must not take the probe down: the
          // table is editable at runtime, so bad input is expected input.
          continue;
        }
        if (hit === null) continue;
        if (!byService.has(row.service)) byService.set(row.service, { service: row.service, evidence: [], maxWeight: 0, challengeArea: 0 });
        const entry = byService.get(row.service);
        entry.evidence.push({ where: row.where_seen, value: hit, weight: row.blocking_weight });
        entry.maxWeight = Math.max(entry.maxWeight, row.blocking_weight);
        entry.challengeArea = Math.max(entry.challengeArea, Math.round(area));
      }

      return {
        results: [...byService.values()],
        title: title.slice(0, maxChars),
        bodyTextLength: body.length,
        viewportArea: Math.round(window.innerWidth * window.innerHeight),
        // Automation signals a service can read. Reported so a block can be
        // attributed: being refused for looking automated is a different
        // situation from being refused on reputation or rate.
        automationSignals: {
          navigatorWebdriver: navigator.webdriver === true,
          headlessInUserAgent: /headless/i.test(navigator.userAgent),
          zeroPlugins: (navigator.plugins?.length ?? 0) === 0,
          noLanguages: !(navigator.languages && navigator.languages.length),
          chromeRuntimeMissing: typeof window.chrome === 'undefined' || !window.chrome.runtime,
        },
      };
    }, sigs, MAX_SAMPLE_CHARS),
    PROBE_TIMEOUT_MS,
    null
  );
  if (!found) return { kind: 'antibot', error: 'timed out checking for anti-bot services' };

  // Present is not the same as blocking. Decided from the signature weights in
  // the table rather than a hardcoded phrase list: weight 2 means the signal
  // alone establishes a wall, weight 1 is corroborating only and on its own is
  // most likely a widget on a page that works.
  const strongest = found.results.reduce(
    (best, r) => (best === null || r.maxWeight > best.maxWeight || (r.maxWeight === best.maxWeight && r.evidence.length > best.evidence.length) ? r : best),
    null
  );
  const dominatesViewport = strongest ? strongest.challengeArea > found.viewportArea * 0.15 : false;
  const blocking = Boolean(
    strongest && (strongest.maxWeight >= 2 || found.bodyTextLength < 500 || dominatesViewport)
  );

  return {
    kind: 'antibot',
    detected: found.results.map(r => r.service),
    blocking,
    // Named separately so a false positive is recognisable rather than
    // silently escalated into "this site blocks us".
    presentButNotBlocking: found.results.length > 0 && !blocking,
    services: found.results.map(r => ({ service: r.service, evidence: r.evidence, maxWeight: r.maxWeight })),
    signaturesLoaded: sigs.length,
    title: truncate(found.title),
    bodyTextLength: found.bodyTextLength,
    automationSignals: found.automationSignals,
    advice: blocking
      ? 'A challenge is serving as the page. Do NOT attempt to solve or evade it — an unattended run can only conclude "blocked-attn"; only verify.js --attended can establish that a person alone is sufficient ("blocked"). If automationSignals are mostly true, the refusal may be about how the browser presents itself rather than the site refusing automation outright; that is a configuration decision for the user, not something to work around unasked.'
      : found.results.length
        ? 'An anti-bot resource is present but is not the page content — most likely a widget on a form. This is NOT a block, and treating it as one would wrongly condemn a working recipe.'
        : 'No anti-bot service detected.',
  };
}

const PROBE_KINDS = {
  selectors: (page, step) => probeSelectors(page, step.selectors),
  repeated_structure: (page, step) => probeRepeatedStructure(page, step.min_group ?? 3),
  blockers: page => probeBlockers(page),
  empty_state: (page, step) => probeEmptyState(page, step.record_nouns),
  antibot: page => probeAntibot(page),
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
  for (const kind of ['empty_state', 'antibot', 'blockers', 'repeated_structure', 'forms']) {
    out.push(await runProbe(page, { kind, label: `auto:${kind}` }));
  }
  return out;
}

module.exports = { runProbe, autoDiagnose, PROBE_KINDS };
