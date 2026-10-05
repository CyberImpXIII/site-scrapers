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
const MAX_FIELDS = 40; // card anatomy parts
// Forms get their own, larger cap: a real Greenhouse application (Discord,
// 2026-10-03) has 33 fields before any company-specific questions, and a
// field past the cap is one an application packet never sees. `truncated`
// says when it bit anyway.
const MAX_FORM_FIELDS = 80;
// A field's label (and a multi-option question's text) is the QUESTION, so it
// is reported whole. It was cut at 60 characters plus "…" until 2026-10-05, and
// Posit's required "Just to ensure that you're human, on https://p3m.dev, what
// a…" (#question_32848993003) was never read past that; two long questions
// sharing a 60-character prefix were also indistinguishable by label. This cap
// is only against a hostile page (80 fields x an unbounded label is a token
// bomb), far above any real question, and when it bites it is SAID:
// `labelsTruncated` counts the fields it shortened. lib/fillForm.js uses it too.
const MAX_LABEL_CHARS = 1000;
const { formHash, CAPTCHA_FIELD_SOURCE } = require('./formHash');
const { MULTI_CONTAINER_SELECTOR, MULTI_ANCESTOR_LEVELS } = require('./multiSelect');
const MAX_MATCHES = 5;
const MAX_CARDS_SAMPLED = 8; // enough to tell "every card" from "some cards"
const PROBE_TIMEOUT_MS = 5000;

// Probe knowledge from failures.db, cached per process for the same reason the
// blocker signatures are: this runs inside a failing scrape, and re-reading the
// table per probe would add lock pressure exactly when things are already going
// wrong. Falls back to the code baseline when the DB is unavailable (a fresh
// clone, a partial copy in a test), so a probe never loses its knowledge
// entirely.
let knowledgeCache = null;
// Categories written as `<group>.<name>`, returned as [name, value] pairs.
// Used by the field_shape vocabulary, where the proposed field name is part of
// the category so the `value` column stays a plain pattern like every other
// row, and adding a shape stays a data change.
function probeKnowledgeGrouped(kind, group) {
  const prefix = `${group}.`;
  if (!knowledgeCache) probeKnowledge(kind, prefix); // prime the cache
  return knowledgeCache
    .filter(([k, c]) => k === kind && typeof c === 'string' && c.startsWith(prefix))
    .map(([, c, , value]) => [c.slice(prefix.length), value]);
}

function probeKnowledge(kind, category) {
  if (!knowledgeCache) {
    try {
      const { openFailuresDb, listProbeKnowledge } = require('../failuresDb');
      const db = openFailuresDb();
      knowledgeCache = listProbeKnowledge(db).map(r => [r.probe_kind, r.category, r.value_kind, r.value]);
      db.close();
    } catch {
      knowledgeCache = require('./probeKnowledge').PROBE_KNOWLEDGE;
    }
    if (!knowledgeCache.length) knowledgeCache = require('./probeKnowledge').PROBE_KNOWLEDGE;
  }
  return knowledgeCache.filter(([k, c]) => k === kind && c === category).map(([, , , value]) => value);
}

// Would truncate(s, MAX_LABEL_CHARS) shorten this? Same normalisation.
const overLabelCap = s => typeof s === 'string' && s.replace(/\s+/g, ' ').trim().length > MAX_LABEL_CHARS;

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
  const knownStableAttrs = probeKnowledge('forms', 'stable_attr');
  const generatedClassPatterns = probeKnowledge('repeated_structure', 'generated_class');
  const adPatterns = probeKnowledge('repeated_structure', 'ad_container');
  const found = await withTimeout(
    page.evaluate((minGroupSize, maxCandidates, maxChars, knownStableAttrs, generatedClassPatterns, adPatterns) => {
      const sig = el => `${el.tagName}.${Array.from(el.classList).sort().join('.')}`;

      // Page chrome repeats too. A <nav>'s links, a footer's link columns and a
      // sponsored rail are all groups of similar siblings, and on
      // workingnomads.com chrome was counted as cards outright. The average-
      // text-length floor catches short nav lists but not a rich footer or an
      // ad rail carrying real prose.
      //
      // DEMOTED, not dropped — the same argument as the utility_class
      // vocabulary. Some boards render their list inside an <aside>, and
      // excluding chrome would then report no candidates at all, which is a
      // wrong answer by omission rather than a visible failure. `chrome` is
      // reported so the ordering is explainable and the tail stays readable.
      const CHROME_TAGS = 'header, footer, nav, aside';
      const adRe = adPatterns.map(src => new RegExp(src, 'i'));
      const looksLikeAd = el => {
        const idents = `${el.className || ''} ${el.id || ''}`;
        return adRe.some(re => re.test(idents));
      };
      // True when the element IS chrome or sits inside it. An ad rail is
      // usually neither, so its own identifiers are checked on the way up.
      const inChrome = el => {
        for (let n = el; n && n !== document.body; n = n.parentElement) {
          if (n.matches(CHROME_TAGS) || n.getAttribute('role') === 'navigation') return true;
          if (looksLikeAd(n)) return true;
        }
        return false;
      };

      // A class name that will change the next time the site rebuilds:
      // emotion/styled-components hashes (css-1q2dra3, sc-bdVaJa), Tailwind
      // arbitrary values (w-[32px]), CSS-modules suffixes (Card_root__a1b2c),
      // and anything ending in a long hex-ish run. Proposing one of these as
      // a card_selector is worse than proposing nothing: it works today and
      // silently breaks later.
      const isGeneratedClass = c => generatedClassPatterns.some(src => new RegExp(src, 'i').test(c));

      // Stable hooks a site puts there on purpose, in descending order of
      // how deliberate they are. A Workday tenant's card wrapper carries no
      // stable class at all, but every one of them marks the title link with
      // data-automation-id — so the usable selector is structural, anchored
      // to the hook. Reported separately from the class guess so the caller
      // can prefer it.
      const STABLE_ATTRS = knownStableAttrs;
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
            // Sorted to the tail rather than removed. Read it if nothing above
            // it fits; a site whose list lives in an <aside> lands here.
            ...(inChrome(parent) ? { chrome: true } : {}),
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
      // Real content first, then deepest/richest: an outer wrapper technically
      // "repeats" too, but the tight group around the real cards is what you
      // want. Chrome sorts last so it cannot take the top slot from the actual
      // list, while still being there when the actual list IS in an aside.
      out.sort(
        (a, b) =>
          Number(!!a.chrome) - Number(!!b.chrome) ||
          b.count * b.avgTextLength - a.count * a.avgTextLength
      );
      return out.slice(0, maxCandidates);
    }, minGroup, MAX_CANDIDATES, MAX_SAMPLE_CHARS, knownStableAttrs, generatedClassPatterns, adPatterns),
    PROBE_TIMEOUT_MS,
    null
  );
  if (!found) return { kind: 'repeated_structure', error: 'timed out scanning for repeated structure' };
  if (!Array.isArray(found)) return { kind: 'repeated_structure', error: 'page returned an unexpected shape' };
  return {
    kind: 'repeated_structure',
    // Capped on this side as well as in page context: a cap that lives only in
    // the evaluated code is a cap that depends on that code being reached.
    candidates: found.slice(0, MAX_CANDIDATES).map(c => ({ ...c, sampleText: truncate(c.sampleText) })),
    hint: found.length
      ? 'Order of preference: stableHook (a data-* attribute the site set deliberately) > sharedLine as card_anchor_text > childSelector as card_selector. ' +
        'sharedLineIn shows how many cards actually contain that line — it must be nearly all of them to work as card_anchor_text. ' +
        'When selectorIsGenerated is true, childSelector rests on a build-hashed class that will break on the site\'s next deploy; use stableHook or read dom.html for a real hook instead. ' +
        'chrome:true means the candidate sits in a header/footer/nav/aside or an ad container, so it is sorted last — page chrome was once counted as cards outright. It is only an ordering: if nothing above it fits, the list really may be in an aside.'
      : 'No repeated structure found — the page may not have loaded, may be a login/blocker page, or may render cards in an iframe.',
  };
}

// --- card_anatomy ----------------------------------------------------------
// repeated_structure finds the CARD; this reads what is inside one.
//
// It exists because `child_text` — a CSS selector evaluated inside a card — is
// now the preferred way to extract a field, and there was no way to discover
// the selector to use. The alternative was counting parts in a text blob, which
// is exactly the extraction style that drifts: an optional badge or a missing
// location shifts every index after it, and four recipes here reported a wrong
// value that way rather than failing.
//
// The output is about CONSISTENCY, not one card. A selector present in every
// sampled card, once per card, holding different text each time, is a field. A
// selector present in three of eighteen is an optional badge, and hanging a
// field on it gets nulls. Both facts need several cards to be visible at all,
// which is why this samples rather than dumping one card's DOM.
async function probeCardAnatomy(page, cardSelector, maxCards) {
  const sel = String(cardSelector || '').trim();
  if (!sel) return { kind: 'card_anatomy', error: 'no card_selector given' };
  const knownStableAttrs = probeKnowledge('forms', 'stable_attr');
  const generatedClassPatterns = probeKnowledge('repeated_structure', 'generated_class');
  const n = Number(maxCards);
  const sampleSize = Number.isFinite(n) && n >= 2 ? Math.min(n, MAX_CARDS_SAMPLED) : MAX_CARDS_SAMPLED;

  const found = await withTimeout(
    page.evaluate((cardSel, sampleN, maxPerCard, maxChars, stableAttrs, generatedClassPatterns) => {
      let cards;
      try {
        cards = Array.from(document.querySelectorAll(cardSel));
      } catch (e) {
        return { error: `invalid card_selector: ${e.message}` };
      }
      if (!cards.length) return { error: 'card_selector matched nothing', cardCount: 0 };
      const isGeneratedClass = c => generatedClassPatterns.some(src => new RegExp(src, 'i').test(c));

      // Same preference order as repeated_structure: an attribute the site set
      // on purpose outlives a class name, and a build-hashed class works today
      // and breaks on the next deploy.
      const selectorFor = el => {
        const tag = el.tagName.toLowerCase();
        for (const attr of stableAttrs) {
          if (el.hasAttribute(attr)) return `${tag}[${attr}="${el.getAttribute(attr)}"]`;
        }
        const classes = Array.from(el.classList).filter(c => !isGeneratedClass(c)).slice(0, 2);
        if (classes.length) return `${tag}.${classes.join('.')}`;
        if (el.getAttribute('role')) return `${tag}[role="${el.getAttribute('role')}"]`;
        return tag;
      };

      const norm = el => (el.innerText || '').trim().replace(/\s+/g, ' ');
      const hasStableAttr = el => stableAttrs.some(a => el.hasAttribute(a));

      const perCard = [];
      for (const card of cards.slice(0, sampleN)) {
        const entries = [];
        const cardText = norm(card);
        for (const el of card.querySelectorAll('*')) {
          // Form controls are skipped outright. A card is not a login form, but
          // this output gets written to disk and read back, and the one thing a
          // probe must never emit is a field's value.
          if (/^(input|textarea|select|option)$/i.test(el.tagName)) continue;
          const text = norm(el);
          if (!text) continue;
          if (text === cardText) continue; // passthrough wrapper

          // A chain of single-child wrappers all hold the same string, and only
          // ONE of them is worth writing down. Normally that is the outermost,
          // which carries the semantic class. But if a descendant in the chain
          // has a stable data-* attribute and the outer one has only layout
          // classes, the INNER is the better hook — on ziprecruiter the outer
          // wrapper is div.flex.justify-between and the inner is
          // a[data-testid="job-card-company"], and reporting the wrapper hid the
          // one selector that will survive a redesign.
          const parent = el.parentElement;
          const parentSameText = parent && parent !== card && norm(parent) === text;
          if (parentSameText && !(hasStableAttr(el) && !hasStableAttr(parent))) continue;
          if (!parentSameText) {
            let inner = el.firstElementChild;
            let better = null;
            while (inner && norm(inner) === text) {
              if (hasStableAttr(inner)) { better = inner; break; }
              inner = inner.firstElementChild;
            }
            if (better && !hasStableAttr(el)) continue; // the descendant will report it
          }

          // The index and count child_text will ACTUALLY see. These must come
          // from querySelectorAll on the proposed selector, not from this
          // filtered walk: a segment_index read off a filtered position would
          // point at a different element at extraction time, which is a wrong
          // value rather than a failure.
          const selector = selectorFor(el);
          let matches = [];
          try {
            matches = Array.from(card.querySelectorAll(selector));
          } catch {
            continue; // a selector we cannot re-run is not one to propose
          }
          const index = matches.indexOf(el);
          if (index < 0) continue;
          entries.push({ selector, text: text.slice(0, maxChars), index, count: matches.length });
          if (entries.length >= maxPerCard) break;
        }
        perCard.push(entries);
      }
      return { cardCount: cards.length, sampled: perCard.length, perCard };
    }, sel, sampleSize, MAX_FIELDS, MAX_SAMPLE_CHARS, knownStableAttrs, generatedClassPatterns),
    PROBE_TIMEOUT_MS,
    null
  );

  if (!found) return { kind: 'card_anatomy', error: 'timed out reading card anatomy' };
  if (!found || typeof found !== 'object') return { kind: 'card_anatomy', error: 'page returned an unexpected shape' };
  if (found.error) return { kind: 'card_anatomy', error: found.error, cardCount: found.cardCount ?? 0 };

  // Aggregated on THIS side, from a flat per-card list, so the caps and the
  // shape of what gets published do not depend on the page code being reached.
  const sampled = Array.isArray(found.perCard) ? found.perCard : [];
  const agg = new Map();
  for (const entries of sampled) {
    const seenHere = new Map();
    for (const e of Array.isArray(entries) ? entries.slice(0, MAX_FIELDS) : []) {
      const key = String(e && e.selector ? e.selector : '');
      if (!key) continue;
      // The index the page reported, which is the one child_text will use.
      // Falling back to a running count would quietly reintroduce the filtered
      // position this was written to stop reporting.
      const idx = Number.isInteger(e.index) ? e.index : seenHere.get(key) || 0;
      seenHere.set(key, Math.max(seenHere.get(key) || 0, Number.isInteger(e.count) ? e.count : idx + 1));
      if (!agg.has(key)) agg.set(key, { selector: key, presentIn: 0, maxPerCard: 0, byIndex: new Map(), allTexts: [] });
      const a = agg.get(key);
      // Kept BY POSITION within the card, not flattened. A selector matching
      // four times per card is useless until you know which position holds
      // what — that is exactly the segment_index you are about to write down,
      // and a flat sample list makes it a guess again.
      if (!a.byIndex.has(idx)) a.byIndex.set(idx, []);
      const bucket = a.byIndex.get(idx);
      const text = truncate(String(e && e.text ? e.text : ''));
      if (bucket.length < MAX_MATCHES) bucket.push(text);
      // EVERY value seen, uncapped and never emitted — only the shape check
      // reads it. The displayed samples are capped at MAX_MATCHES and then
      // truncated to 3 per position, and proposing a field name from that
      // shortened list claimed "every sample matches" while having looked at
      // half the cards: div.mixed, relative-time in 3 of 6 cards and a team
      // name in the rest, was proposed as posted_ago off the first three.
      a.allTexts.push(text);
    }
    for (const [key, count] of seenHere) {
      const a = agg.get(key);
      a.presentIn += 1;
      a.maxPerCard = Math.max(a.maxPerCard, count);
    }
  }

  // Framework scaffolding is ranked to the tail, never removed. See the
  // utility_class block in lib/probeKnowledge.js for why this can only ever be
  // a ranking: on builtin.com a Bootstrap utility class is the ONLY hook for
  // four fields, and on nodesk.co the real title hook is two utility classes.
  // Filtering on this vocabulary would have left those fields unextractable.
  // Shape-based field proposals. The hard limit from docs/lessons.md: a probe
  // may recognise a shape it was TOLD about, and may never decide what a novel
  // field means — guessing field names is how a salary got reported as a
  // location. So a proposal needs the shape to hold for EVERY sample of that
  // part (one matching sample is a coincidence), it carries the evidence that
  // produced it, and nothing applies it automatically.
  const shapeVocab = probeKnowledgeGrouped('card_anatomy', 'field_shape').map(([name, src]) => {
    try {
      return [name, new RegExp(src, 'i')];
    } catch {
      return null; // a malformed row must not take the probe down
    }
  }).filter(Boolean);
  const proposeField = samples => {
    const texts = samples.filter(s => typeof s === 'string' && s.trim());
    if (!texts.length) return null;
    for (const [name, re] of shapeVocab) {
      if (texts.every(t => re.test(t))) return name;
    }
    return null;
  };

  const utilityPatterns = probeKnowledge('card_anatomy', 'utility_class');
  const classesOf = selector =>
    (selector.replace(/\[[^\]]*\]/g, '').match(/\.([^.\s]+)/g) || []).map(c => c.slice(1));
  const isUtilitySelector = selector => {
    const classes = classesOf(selector);
    // No classes at all is not "utility" — an attribute hook is the most
    // deliberate thing a site offers, and a bare tag is judged on its own
    // presentIn/varies rather than demoted.
    if (!classes.length) return false;
    return classes.every(c => utilityPatterns.some(src => new RegExp(src, 'i').test(c)));
  };

  const total = sampled.length || 1;
  const parts = [...agg.values()]
    .map(a => {
      const positions = [...a.byIndex.entries()]
        .sort((x, y) => x[0] - y[0])
        .slice(0, MAX_MATCHES)
        .map(([index, samples]) => ({ index, samples: samples.slice(0, 3), varies: new Set(samples).size > 1 }));
      return {
        selector: a.selector,
        presentIn: `${a.presentIn}/${total}`,
        _present: a.presentIn,
        // Layout scaffolding rather than a semantic hook. Reported so the
        // ordering is explainable, and so a reader can see that the only hook
        // available for a field IS a utility class when that is the case.
        ...(isUtilitySelector(a.selector) ? { utility: true } : {}),
        // Below 1 means a field hung on it will be null on some cards; above 1
        // means child_text needs a segment_index to say WHICH match it wants.
        everyCard: a.presentIn === total,
        maxPerCard: a.maxPerCard,
        // One distinct value across every card is a static label ("Apply",
        // "New"), not a field. Several is per-card data.
        varies: positions.some(p => p.varies),
        // What this part LOOKS like, when the shape is one the vocabulary
        // knows and every sample matches it. A suggestion with its evidence
        // beside it, never a decision — `samples`/`positions` below are what
        // you check it against.
        ...(() => {
          const name = proposeField(a.allTexts);
          return name ? { proposedField: name } : {};
        })(),
        ...(a.maxPerCard > 1 ? { positions } : { samples: positions[0] ? positions[0].samples : [] }),
      };
    })
    // Semantic first, then by how universal, then by whether it carries data.
    // presentIn is compared NUMERICALLY: it used to be a localeCompare on the
    // rendered "6/6" string, which happens to order single digits correctly
    // and would put "10/12" below "9/12" the moment MAX_CARDS_SAMPLED grew.
    .sort(
      (a, b) =>
        Number(!!a.utility) - Number(!!b.utility) ||
        b._present - a._present ||
        Number(b.varies) - Number(a.varies)
    )
    .slice(0, MAX_FIELDS)
    .map(({ _present, ...part }) => part);

  return {
    kind: 'card_anatomy',
    cardCount: found.cardCount ?? 0,
    cardsSampled: sampled.length,
    parts,
    hint: parts.length
      ? 'Use a part with everyCard:true and varies:true as a child_text field — regex_pattern is the selector, segment_index picks which match when maxPerCard > 1 (0 is the first, -1 the last), and `positions` shows what each index actually holds. ' +
        'A part with everyCard:false is optional: a field on it returns null on the cards that lack it, which is correct, but it must NOT be used as a positional anchor — that is the drift that made four recipes report a wrong value. ' +
        'varies:false is a static label, not data. ' +
        'utility:true is framework layout scaffolding, sorted to the end because semantic hooks are usually the answer — but it is only an ordering: a utility class is sometimes the ONLY hook a card offers, so read the tail rather than skipping it. ' +
        'proposedField is a GUESS FROM SHAPE ONLY — every sample matched a known pattern (currency, "3 days ago", a closed enum). Check it against the samples before using it; a probe cannot know what a field means, and a wrong field name is the mistake that once reported a salary as a location. ' +
        'If this recipe already returns records, use card_match instead — it finds the selector for a value you ALREADY have, which is a search rather than a judgement.'
      : 'Cards matched but held no text-bearing children — the card_selector may be matching a wrapper rather than the card, or the content may render in an iframe.',
  };
}

// --- card_match ------------------------------------------------------------
// `card_anatomy` REPORTS what is inside a card and leaves the choosing to a
// reader. For a MIGRATION that choosing is wasted work, because the answer is
// already known: the current recipe produces the values, so the question is not
// "what fields exist" but "which selector yields THIS value in every card".
//
// That is a search with a checkable answer, not a judgement, so it is done
// here. Migrating four recipes by hand meant reading 12-16 anatomy parts per
// site and deciding; the decision was mechanically derivable every time.
//
// The reason this is cheap is that the filtering happens INSIDE the page,
// against the values the caller already has. An element whose text is not one
// of those values is never emitted, so what crosses the boundary is at most
// one entry per (field x card) rather than the whole card DOM. Measured while
// writing it: `card_anatomy` on the same page is ~15KB, this is a few hundred
// bytes.
//
// It proposes and never applies. A selector that reproduces a known value is
// evidence; it is still the caller who writes the recipe.
async function probeCardMatch(page, cardSelector, expected, maxCards) {
  const sel = String(cardSelector || '').trim();
  if (!sel) return { kind: 'card_match', error: 'no card_selector given' };

  let want;
  try {
    want = typeof expected === 'string' ? JSON.parse(expected) : expected;
  } catch (e) {
    return { kind: 'card_match', error: `expected values are not valid JSON: ${e.message}` };
  }
  if (!want || typeof want !== 'object' || Array.isArray(want)) {
    return { kind: 'card_match', error: 'expected must be an object of {fieldName: [value per record]}' };
  }

  // Only string-valued fields can be matched against element text at all. A
  // null or a number in the column is not a failure of the search, so they are
  // dropped from the target set and reported separately rather than counted as
  // a miss.
  const fieldNames = Object.keys(want).filter(f => Array.isArray(want[f]));
  const norm = s => String(s).replace(/\s+/g, ' ').trim();
  const targets = new Set();
  for (const f of fieldNames) {
    for (const v of want[f]) {
      if (typeof v === 'string' && v.trim()) targets.add(norm(v));
    }
  }
  if (!targets.size) {
    return { kind: 'card_match', error: 'no non-empty string values to match against' };
  }

  const knownStableAttrs = probeKnowledge('forms', 'stable_attr');
  const generatedClassPatterns = probeKnowledge('repeated_structure', 'generated_class');
  const n = Number(maxCards);
  const sampleSize = Number.isFinite(n) && n >= 2 ? Math.min(n, MAX_CARDS_SAMPLED) : MAX_CARDS_SAMPLED;

  const found = await withTimeout(
    page.evaluate((cardSel, sampleN, targetList, maxChars, stableAttrs, generatedClassPatterns) => {
      let cards;
      try {
        cards = Array.from(document.querySelectorAll(cardSel));
      } catch (e) {
        return { error: `invalid card_selector: ${e.message}` };
      }
      if (!cards.length) return { error: 'card_selector matched nothing', cardCount: 0 };
      const wanted = new Set(targetList);
      const isGeneratedClass = c => generatedClassPatterns.some(src => new RegExp(src, 'i').test(c));

      // Deliberately the SAME preference order as card_anatomy: an attribute
      // the site set on purpose outlives a class name, and a build-hashed
      // class works today and breaks on the next deploy. A second, competing
      // notion of "the best selector" living here is exactly the near-
      // duplicate this project keeps paying for.
      const selectorFor = el => {
        const tag = el.tagName.toLowerCase();
        for (const attr of stableAttrs) {
          if (el.hasAttribute(attr)) return `${tag}[${attr}="${el.getAttribute(attr)}"]`;
        }
        const classes = Array.from(el.classList).filter(c => !isGeneratedClass(c)).slice(0, 2);
        if (classes.length) return `${tag}.${classes.join('.')}`;
        if (el.getAttribute('role')) return `${tag}[role="${el.getAttribute('role')}"]`;
        return tag;
      };
      const norm = el => (el.innerText || '').trim().replace(/\s+/g, ' ');

      const perCard = [];
      for (const card of cards.slice(0, sampleN)) {
        const hits = [];
        const cardText = norm(card);
        for (const el of card.querySelectorAll('*')) {
          // Same exclusion as every other probe: a card is not a login form,
          // but this output is written to disk and read back, and the one
          // thing a probe must never emit is a field's value.
          if (/^(input|textarea|select|option)$/i.test(el.tagName)) continue;
          const text = norm(el);
          if (!text || text === cardText) continue;
          // THE filter that makes this cheap. Everything the caller did not
          // already have a value for is dropped before it can cross out.
          if (!wanted.has(text)) continue;

          const selector = selectorFor(el);
          let matches = [];
          try {
            matches = Array.from(card.querySelectorAll(selector));
          } catch {
            continue; // a selector we cannot re-run is not one to propose
          }
          const index = matches.indexOf(el);
          if (index < 0) continue;
          hits.push({ selector, index, count: matches.length, text: text.slice(0, maxChars) });
        }
        perCard.push(hits);
      }
      return { cardCount: cards.length, perCard };
    }, sel, sampleSize, [...targets], MAX_SAMPLE_CHARS, knownStableAttrs, generatedClassPatterns),
    PROBE_TIMEOUT_MS,
    null
  );

  if (!found) return { kind: 'card_match', error: 'timed out matching card values' };
  if (typeof found !== 'object') return { kind: 'card_match', error: 'page returned an unexpected shape' };
  if (found.error) return { kind: 'card_match', error: found.error, cardCount: found.cardCount ?? 0 };

  const perCard = Array.isArray(found.perCard) ? found.perCard : [];
  const sampled = perCard.length;
  const recordCount = fieldNames.length ? Math.max(...fieldNames.map(f => want[f].length)) : 0;

  // Card N in the DOM is record N only if the page still holds what the run
  // extracted. When the counts disagree it does not, so positional comparison
  // would be comparing a card against another card's value — a wrong answer,
  // which is worse than no answer. Fall back to membership and SAY so, rather
  // than quietly producing a number that reads the same either way.
  const aligned = recordCount === found.cardCount && recordCount > 0;
  const mode = aligned ? 'aligned' : 'set';

  // A wrapper and the element inside it often hold the same string, so several
  // selectors legitimately reproduce the same value and one has to be chosen.
  // The order is deliberately the SAME as selectorFor's: an attribute the site
  // set on purpose, then a semantic class, then a role, then a bare tag.
  //
  // Sorting on length alone would inverse this — `span` is shorter than
  // `div.ti` and strictly worse, being both less specific and more likely to
  // collide as the card grows. Length only breaks ties inside a tier.
  //
  // This is a tie-break among selectors that ALL already reproduce the value,
  // so it can pick a less durable winner, never a wrong one.
  const tier = s => {
    if (/\[(data-|aria-)/.test(s)) return 0;
    if (s.includes('.')) return 1;
    if (s.includes('[role=')) return 2;
    return 3;
  };
  const rank = s => tier(s) * 1000 + s.length;

  const fields = {};
  const skipped = [];
  for (const f of fieldNames) {
    const values = want[f];
    const usable = values.filter(v => typeof v === 'string' && v.trim());
    if (!usable.length) {
      skipped.push(f);
      continue;
    }
    const distinct = new Set(usable.map(norm));
    const pool = mode === 'set' ? distinct : null;

    // A (selector, index) pair is a candidate only if it produced this field's
    // expected value in a card. Count the cards where it did.
    const tally = new Map();
    for (let i = 0; i < sampled; i++) {
      const target = aligned ? (typeof values[i] === 'string' ? norm(values[i]) : null) : null;
      const seen = new Set();
      for (const h of perCard[i] || []) {
        const ok = aligned ? target !== null && h.text === target : pool.has(h.text);
        if (!ok) continue;
        const key = `${h.selector}\u0000${h.index}`;
        if (seen.has(key)) continue; // one card votes once
        seen.add(key);
        if (!tally.has(key)) tally.set(key, { selector: h.selector, index: h.index, count: h.count, cards: 0 });
        tally.get(key).cards += 1;
      }
    }

    // How many cards COULD have matched. A field that is null on 3 of 8 cards
    // should read 5/5, not 5/8 — otherwise a correct selector for an optional
    // field looks like a partial failure.
    const eligible = aligned
      ? Array.from({ length: sampled }, (_, i) => values[i]).filter(v => typeof v === 'string' && v.trim()).length
      : sampled;

    const best = [...tally.values()].sort((a, b) => b.cards - a.cards || rank(a.selector) - rank(b.selector))[0];
    if (!best || !eligible) {
      fields[f] = {
        selector: null,
        matchedIn: `0/${eligible || sampled}`,
        note:
          'no element\'s full text equals this value in any sampled card — the value is probably DERIVED ' +
          '(a regex, a substring, or an attribute) rather than one element\'s text, so keep the current extract kind',
      };
      continue;
    }
    fields[f] = {
      selector: best.selector,
      // Only meaningful when the selector matches more than once in a card;
      // child_text needs it then and would be misled by it otherwise.
      ...(best.count > 1 ? { index: best.index } : {}),
      matchesPerCard: best.count,
      matchedIn: `${best.cards}/${eligible}`,
      everyCard: best.cards === eligible,
      // One distinct value across every card is a static label, not a field —
      // a selector "matching" it proves nothing about extraction.
      varies: distinct.size > 1,
    };
  }

  return {
    kind: 'card_match',
    mode,
    cardCount: found.cardCount ?? 0,
    cardsSampled: sampled,
    recordsGiven: recordCount,
    ...(skipped.length ? { skippedFields: skipped } : {}),
    fields,
    hint:
      (mode === 'set'
        ? `The page returned ${found.cardCount} cards but ${recordCount} records were given, so cards could not be matched to records positionally. ` +
          'Selectors below reproduce a value from the right SET, which is weaker evidence than a per-card match — re-run when the page is stable for the stronger form. '
        : '') +
      'A field with everyCard:true and varies:true is ready to become a child_text field: regex_pattern is the selector, ' +
      'segment_index is `index` when matchesPerCard > 1. selector:null means the value is not any single element\'s text — leave that field alone. ' +
      'This is a PROPOSAL validated against values you already had; it cannot tell you what a field you do not already extract would mean.',
  };
}

// --- pagination_controls ---------------------------------------------------
// How does this page give you MORE results?
//
// The companion to repeated_structure: that one proposes card_selector, this
// one proposes what pagination_method and, for `paginate`, next_selector --
// the parameter whose absence is the reason `paginate` cannot be trialled
// blind. Together they are most of what a listing recipe needs.
//
// Four mechanisms, and they are genuinely different recipes:
//   load_more       a button that appends in place  -> paginate, next_selector
//   next_link       a link to the next page         -> paginate, next_selector
//   numbered        a run of page-number links      -> paginate, next_selector
//   scroll_sentinel an element a scroll loader watches -> infinite_scroll
//
// WHAT THIS CANNOT DO, and says so: it cannot confirm infinite scroll. Whether
// scrolling appends results is only knowable by scrolling, which is what the
// `infinite_scroll` action trial does. A sentinel-looking element is a hint,
// not a finding -- so `likely` is left null rather than guessed when the
// evidence is only structural. `docs/lessons.md`: prefer null over a guess.
async function probePaginationControls(page) {
  const loadMore = probeKnowledge('pagination_controls', 'load_more_text');
  const nextText = probeKnowledge('pagination_controls', 'next_text');
  const sentinel = probeKnowledge('pagination_controls', 'sentinel_hint');
  const generatedClassPatterns = probeKnowledge('repeated_structure', 'generated_class');

  const found = await withTimeout(
    page.evaluate((loadMoreSrc, nextSrc, sentinelSrc, generatedSrc, maxChars, maxOut) => {
      const anyMatch = (srcs, s) => srcs.some(src => new RegExp(src, 'i').test(s));
      const isGenerated = c => generatedSrc.some(src => new RegExp(src, 'i').test(c));
      const selectorFor = el => {
        const tag = el.tagName.toLowerCase();
        for (const attr of ['data-testid', 'data-qa', 'data-test', 'aria-label', 'rel', 'id']) {
          if (el.hasAttribute(attr)) {
            const v = el.getAttribute(attr);
            if (v && v.length < 60) return attr === 'id' ? `#${v}` : `${tag}[${attr}="${v}"]`;
          }
        }
        const cls = Array.from(el.classList).filter(c => !isGenerated(c)).slice(0, 2);
        return cls.length ? `${tag}.${cls.join('.')}` : tag;
      };
      const norm = el => (el.textContent || '').replace(/\s+/g, ' ').trim();
      const visible = el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
      };

      const out = [];
      const push = (mechanism, el, extra = {}) =>
        out.push({
          mechanism,
          selector: selectorFor(el),
          text: norm(el).slice(0, maxChars),
          visible: visible(el),
          disabled: el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true',
          ...extra,
        });

      for (const el of document.querySelectorAll('a, button, [role="button"]')) {
        const t = norm(el);
        if (!t || t.length > 40) continue;
        if (anyMatch(loadMoreSrc, t)) push('load_more', el);
        else if (anyMatch(nextSrc, t) || el.getAttribute('rel') === 'next') push('next_link', el);
        else if (/^\d{1,3}$/.test(t)) push('numbered', el, { page: Number(t) });
      }

      // A sentinel is judged partly on WHERE it is: an element named "loader"
      // in the header is a spinner, the same element just above the fold's
      // bottom is what a scroll loader watches.
      const docH = document.documentElement.scrollHeight || 1;
      for (const el of document.querySelectorAll('div, span, section')) {
        const ident = `${el.className || ''} ${el.id || ''}`;
        if (!ident.trim() || !anyMatch(sentinelSrc, ident)) continue;
        const top = el.getBoundingClientRect().top + window.scrollY;
        push('scroll_sentinel', el, { atPageFraction: Math.round((top / docH) * 100) / 100 });
      }

      return {
        controls: out.slice(0, maxOut),
        numberedCount: out.filter(c => c.mechanism === 'numbered').length,
        // Params already in the URL that a caller could page with directly,
        // which is often simpler than clicking anything.
        urlParams: [...new URLSearchParams(location.search).keys()].filter(k =>
          /^(page|p|offset|start|from|skip|cursor|pagenum)$/i.test(k)
        ),
        scrollable: docH > window.innerHeight * 1.5,
      };
    }, loadMore, nextText, sentinel, generatedClassPatterns, MAX_SAMPLE_CHARS, MAX_CANDIDATES * 3),
    PROBE_TIMEOUT_MS,
    null
  );

  if (!found || typeof found !== 'object') {
    return { kind: 'pagination_controls', error: 'timed out looking for pagination controls' };
  }

  // Visibility and enabledness gate the CLICKABLE mechanisms: a hidden or
  // greyed-out "Show more" is not a way forward, and proposing it builds a
  // recipe that paginates into nothing. A scroll_sentinel is exempt because
  // being invisible is what a sentinel IS -- usually a zero-height div whose
  // only job is to be observed. Filtering it on visibility removed the one
  // thing it exists to find.
  const controls = (found.controls || []).filter(
    c => c.mechanism === 'scroll_sentinel' || (c.visible && !c.disabled)
  );
  const has = m => controls.some(c => c.mechanism === m);
  // Decided only where the evidence is unambiguous; null otherwise. A page
  // with a sentinel-shaped div and nothing else has a HINT, not a mechanism.
  let likely = null;
  if (has('load_more')) likely = 'load_more';
  else if (has('next_link')) likely = 'next_link';
  else if (found.numberedCount >= 2) likely = 'numbered';
  else if (!controls.length && !found.scrollable) likely = 'single_page';

  return {
    kind: 'pagination_controls',
    likely,
    controls: controls.slice(0, MAX_CANDIDATES).map(c => ({ ...c, text: truncate(c.text) })),
    urlParams: found.urlParams || [],
    scrollable: !!found.scrollable,
    hint:
      (likely === 'load_more' || likely === 'next_link' || likely === 'numbered'
        ? `Use pagination_method:"steps" with the paginate generic action and next_selector set to the ${likely} control's selector. Verify the count actually grows — a selector that matches something inert paginates into nothing.`
        : likely === 'single_page'
          ? 'No pagination control and the page does not scroll: everything is probably already here.'
          : 'No control found, but the page is scrollable — this MAY be infinite scroll. Nothing here can confirm that: run the infinite_scroll action and see whether records actually increase.') +
      ' A scroll_sentinel is a hint from an element name, never proof.',
  };
}

// --- page_signature --------------------------------------------------------
// A cheap fingerprint of the page, taken before and after an action so that
// "did this action do anything here" can be answered by measurement instead of
// by whether it threw.
//
// Every field is here because some generic action moves it:
//   dialogs, scrollLocked  a consent overlay appearing or being dismissed
//   elements, textLength   pagination or infinite scroll appending results
//   scrollHeight           content loading in below the fold
//   url                    an action that navigates
//   title                  a page that swapped underneath
//
// Deliberately NOT a hash of the DOM: that changes on every render and would
// report an effect for every action on any page with a clock. These are
// quantities, so lib/observations.js can apply a tolerance to the noisy ones.
async function probePageSignature(page) {
  const found = await withTimeout(
    page.evaluate(() => {
      const body = document.body;
      const html = document.documentElement;
      const locked = el => {
        if (!el) return false;
        const o = getComputedStyle(el).overflow;
        return o === 'hidden' || o === 'clip';
      };
      return {
        url: location.href,
        title: (document.title || '').slice(0, 120),
        elements: document.querySelectorAll('*').length,
        textLength: ((body && body.innerText) || '').length,
        scrollHeight: (html && html.scrollHeight) || 0,
        // An overlay usually announces itself as a dialog AND locks scrolling;
        // either alone is a weak signal, both together are strong.
        dialogs: document.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog[open]').length,
        scrollLocked: locked(body) || locked(html),
      };
    }),
    PROBE_TIMEOUT_MS,
    null
  );
  if (!found || typeof found !== 'object') {
    return { kind: 'page_signature', error: 'timed out reading the page signature' };
  }
  return { kind: 'page_signature', signature: found };
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
// `maxFields` defaults to MAX_FORM_FIELDS (output size for a person reading it);
// fill_form passes a larger cap because there a field missing from the
// description is a field that never gets filled.
async function probeForms(page, maxFields = MAX_FORM_FIELDS) {
  const knownStableAttrs = probeKnowledge('forms', 'stable_attr');
  const requiredMarkers = probeKnowledge('forms', 'required_marker');
  const submitText = probeKnowledge('forms', 'submit_text')[0] || 'submit|send|apply';
  const found = await withTimeout(
    page.evaluate((maxFields, requiredMarkers, submitText, captchaSource, multiContainer, multiLevels) => {
      // Takes several options: lib/multiSelect.js (the same test fill_form uses).
      const isMulti = el => {
        if (el.tagName === 'SELECT') return !!el.multiple;
        if (el.getAttribute('role') !== 'combobox') return false;
        let box = el.parentElement;
        for (let i = 0; box && i < multiLevels; i++, box = box.parentElement) {
          if (box.matches(multiContainer)) return true;
        }
        return false;
      };
      const labelFor = el => {
        if (el.id) {
          const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (l) return (l.innerText || '').trim();
        }
        return (el.closest('label')?.innerText || '').trim() || null;
      };
      // Escaped, because these selectors are USED, not just read: fill_form
      // resolves them on the live page. Unescaped, Greenhouse's EEO ids
      // (`#4033064002`, a leading digit) and its Rails-array checkbox ids
      // (`#question_19016795004[]`) were invalid CSS that threw on use.
      // A field with neither id nor name still gets the bare tag name, which is
      // non-unique by construction; fill_form refuses a selector that does not
      // resolve to exactly one element rather than filling the first match.
      // An option of a multi-option question with no id (Lever) shares its
      // name with every other option, so it is told apart by its value
      // ATTRIBUTE -- the site's own option key, never anything typed -- and
      // only when that resolves to exactly this element.
      const sel = el => {
        if (el.id) return `#${CSS.escape(el.id)}`;
        if (!el.name) return el.tagName.toLowerCase();
        const byName = `${el.tagName.toLowerCase()}[name="${CSS.escape(el.name)}"]`;
        if (el.type !== 'checkbox' && el.type !== 'radio') return byName;
        const only = s => {
          const hits = document.querySelectorAll(s);
          return hits.length === 1 && hits[0] === el;
        };
        if (only(byName)) return byName;
        if (el.hasAttribute('value')) {
          const byValue = `${byName}[value="${CSS.escape(el.getAttribute('value'))}"]`;
          if (only(byValue)) return byValue;
        }
        // No value attribute either (Lever's checkboxes): its POSITION, as an
        // nth-child path up to the nearest ancestor that tells it apart. Still
        // anchored on the name, so it can only ever resolve to an option of
        // this question; if nothing within 8 levels is unique, the shared
        // selector stands and the fill refuses it as selector_not_unique.
        const nth = n => `:nth-child(${Array.prototype.indexOf.call(n.parentElement.children, n) + 1})`;
        const parts = [byName];
        let cur = el;
        for (let i = 0; i < 8 && cur.parentElement; i++) {
          parts[0] += nth(cur);
          if (only(parts.join(' > '))) return parts.join(' > ');
          cur = cur.parentElement;
          if (!cur.parentElement) break;
          parts.unshift(cur.tagName.toLowerCase());
        }
        return byName;
      };
      // A CAPTCHA widget's response field (lib/formHash.js) is not a question
      // and arrives late, so it is left out and COUNTED, never silently lost.
      const captchaRe = new RegExp(captchaSource, 'i');
      const isCaptcha = el => captchaRe.test(el.name || '') || captchaRe.test(el.id || '');
      const candidates = Array.from(document.querySelectorAll('input, select, textarea')).filter(el => el.type !== 'hidden');
      const all = candidates.filter(el => !isCaptcha(el));
      const captchaFieldsExcluded = candidates.length - all.length;
      const totalFields = all.length;
      // A file input's own <label> on Greenhouse is the visually-hidden text of
      // its button ("Attach"), the same for resume and cover letter; the
      // question ("Resume/CV") labels the enclosing role=group through
      // aria-labelledby, and that group carries aria-required. Measured live on
      // job-boards.greenhouse.io/discord/jobs/8815116002, 2026-10-03.
      const groupOf = el => {
        if (el.type !== 'file') return null;
        const g = el.closest('[role="group"][aria-labelledby]');
        if (!g) return null;
        const text = g.getAttribute('aria-labelledby').split(/\s+/)
          .map(id => (document.getElementById(id)?.innerText || '').trim()).filter(Boolean).join(' ');
        return { label: text || null, required: g.getAttribute('aria-required') === 'true' };
      };
      // Multi-option questions: checkboxes or radios sharing a name, 2 or more.
      // Each option keeps its own text as `label`; the QUESTION and its
      // required-ness belong to the group, because one ticked option answers
      // it. Greenhouse puts `required` on every option of such a question, so
      // reading it per option demanded all of them (twitch/jobs/8623401002,
      // 2026-10-03). Where the question text lives, measured live:
      //   Greenhouse: fieldset > legend, aria-required on the fieldset;
      //   Lever: no fieldset; a sibling block above the options' list, "✱".
      // Otherwise the nearest role=group|radiogroup's accessible name.
      const isOption = el => (el.type === 'checkbox' || el.type === 'radio') && !!el.name;
      const optionsByName = new Map();
      for (const el of all) {
        if (!isOption(el)) continue;
        const key = `${el.type}\u0000${el.name}`;
        if (!optionsByName.has(key)) optionsByName.set(key, []);
        optionsByName.get(key).push(el);
      }
      const lines = t => (t || '').split('\n').map(s => s.trim()).filter(Boolean);
      const optionGroups = new Map(); // element -> group
      for (const opts of optionsByName.values()) {
        if (opts.length < 2) continue;
        const holdsAll = a => opts.every(o => a.contains(o));
        let question = null;
        let container = null;
        const fs = opts[0].closest('fieldset');
        if (fs && holdsAll(fs) && fs.querySelector('legend')) {
          container = fs;
          question = lines(fs.querySelector('legend').innerText).join(' ');
        }
        if (!question) {
          const g = opts[0].closest('[role="group"],[role="radiogroup"]');
          if (g && holdsAll(g)) {
            const ids = (g.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
            const t = ids.map(id => lines(document.getElementById(id)?.innerText).join(' ')).filter(Boolean).join(' ') || g.getAttribute('aria-label');
            if (t) {
              container = g;
              question = t.trim();
            }
          }
        }
        if (!question) {
          // Climb from the options' common ancestor until some text that is
          // not an option's own appears. Stop at an ancestor holding any other
          // field: past that, the text belongs to a different question.
          const optionText = new Set(opts.flatMap(o => lines(labelFor(o))));
          let a = opts[0].parentElement;
          while (a && !holdsAll(a)) a = a.parentElement;
          for (let i = 0; a && i < 5; i++, a = a.parentElement) {
            const others = Array.from(a.querySelectorAll('input, select, textarea')).some(x => x.type !== 'hidden' && !opts.includes(x));
            if (others) break;
            const extra = lines(a.innerText).filter(l => !optionText.has(l));
            if (extra.length) {
              container = a;
              question = extra.join(' ');
              break;
            }
          }
        }
        const containerRequired = container?.getAttribute('aria-required') === 'true';
        const optionRequired = opts.some(o => o.required || o.getAttribute('aria-required') === 'true');
        const markedInQuestion = requiredMarkers.some(src => new RegExp(src, 'i').test(question || ''));
        const group = {
          name: opts[0].name,
          // Whole: capped (and the cap counted) outside, in probeForms. A
          // slice here cut at 200 with no marker, so nothing said it was cut.
          question: question || null,
          required: containerRequired || optionRequired || markedInQuestion,
          requiredEvidence: containerRequired ? 'group aria-required' : optionRequired ? 'attribute' : markedInQuestion ? 'label marker' : null,
          size: opts.length,
        };
        for (const o of opts) optionGroups.set(o, group);
      }

      const fields = all
        .slice(0, maxFields)
        .map(el => {
          const optionGroup = optionGroups.get(el) || null;
          if (optionGroup) {
            // NEVER el.value: `checked` is whether this option is ticked.
            return {
              selector: sel(el),
              tag: el.tagName.toLowerCase(),
              type: el.type || null,
              name: el.name || null,
              label: labelFor(el),
              placeholder: null,
              required: false,
              requiredEvidence: null,
              role: el.getAttribute('role') || null,
              ariaHidden: el.getAttribute('aria-hidden') === 'true',
              hasValue: !!el.checked,
              group: optionGroup,
            };
          }
          const group = groupOf(el);
          const label = group?.label || labelFor(el);
          // Greenhouse marks required fields with a "*" in the LABEL and
          // leaves the HTML attribute off entirely, so `el.required` alone
          // reported 31 fields as optional on a form where most were not.
          // Lever uses "✱". Trusting only the attribute understates the
          // form, which is the dangerous direction for something a person
          // is about to fill in.
          const markedInLabel = requiredMarkers.some(src => new RegExp(src, 'i').test(label || ''));
          return {
            selector: sel(el),
            tag: el.tagName.toLowerCase(),
            type: el.type || null,
            name: el.name || null,
            label,
            placeholder: el.placeholder || null,
            required: !!el.required || el.getAttribute('aria-required') === 'true' || !!group?.required || markedInLabel,
            requiredEvidence: el.required ? 'attribute' : group?.required ? 'group aria-required' : markedInLabel ? 'label marker' : null,
            // role=combobox is how a custom dropdown (react-select on
            // Greenhouse) presents itself: type "text", filled by choosing an
            // option, not by typing a value.
            role: el.getAttribute('role') || null,
            // aria-hidden inputs are a widget's internals (react-select's
            // `requiredInput` mirror), not something a person fills.
            ariaHidden: el.getAttribute('aria-hidden') === 'true',
            // NEVER el.value -- may be a typed password or token. A checkbox's
            // value is its option key ("on" by default), always present, so
            // for one "has a value" means ticked.
            hasValue: el.type === 'checkbox' || el.type === 'radio' ? !!el.checked : !!el.value,
            // Answer with a LIST of option texts (fill_form); see lib/multiSelect.js.
            multiple: isMulti(el),
            group: null,
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
          const submitRe = new RegExp(submitText, 'i');
          if (t === 'button') return submitRe.test(el.textContent || '');
          return t === 'submit' || !t || submitRe.test(el.textContent || '');
        })
        .slice(0, 10)
        .map(el => ({
          selector: sel(el),
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || el.value || '').trim().slice(0, 60) || null,
        }));

      return { fields, submits, totalFields, captchaFieldsExcluded };
    }, maxFields, requiredMarkers, submitText, CAPTCHA_FIELD_SOURCE, MULTI_CONTAINER_SELECTOR, MULTI_ANCESTOR_LEVELS),
    PROBE_TIMEOUT_MS,
    null
  );
  if (!found) return { kind: 'forms', error: 'timed out describing forms' };
  if (!Array.isArray(found.fields)) return { kind: 'forms', error: 'page returned an unexpected shape' };

  // Rebuilt field by field from an ALLOWLIST rather than spread from whatever
  // the page handed back. A spread passes through any extra key, so if a `value`
  // ever appeared in that object -- through a refactor, or a page that is not
  // returning what we assume -- it would be published. The one thing this probe
  // must never emit is a field's value, so that guarantee cannot depend on the
  // shape being right. Capped here as well as in page context, for the same
  // reason: the limit should not rely on the other side cooperating.
  const fields = found.fields.slice(0, maxFields).map(f => ({
    selector: f?.selector ?? null,
    tag: f?.tag ?? null,
    type: f?.type ?? null,
    name: f?.name ?? null,
    label: truncate(f?.label, MAX_LABEL_CHARS),
    placeholder: truncate(f?.placeholder, 60),
    required: Boolean(f?.required),
    requiredEvidence: f?.requiredEvidence ?? null,
    role: typeof f?.role === 'string' ? f.role.slice(0, 30) : null,
    ariaHidden: Boolean(f?.ariaHidden),
    hasValue: Boolean(f?.hasValue),
    // Takes several options (answer with a list). Not hashed (lib/formHash.js),
    // so descriptions stored before this key existed still match.
    multiple: Boolean(f?.multiple),
    // A multi-option question this field is one option of, else null.
    group:
      f?.group && typeof f.group === 'object'
        ? {
            name: typeof f.group.name === 'string' ? f.group.name.slice(0, 200) : null,
            question: truncate(f.group.question, MAX_LABEL_CHARS),
            required: Boolean(f.group.required),
            requiredEvidence: typeof f.group.requiredEvidence === 'string' ? f.group.requiredEvidence.slice(0, 40) : null,
            size: Number.isFinite(f.group.size) ? f.group.size : null,
          }
        : null,
  }));
  // Falls back to what the page handed back BEFORE the cap, so a page that
  // omits totalFields still cannot make a capped list look complete.
  const totalFields = Number.isFinite(found.totalFields) ? found.totalFields : found.fields.length;
  return {
    kind: 'forms',
    fields,
    // Said out loud, because a capped list otherwise looks complete: a field
    // past the cap would never be filled and nothing would mention it.
    totalFields,
    truncated: totalFields > fields.length,
    // Fields whose label or group question hit MAX_LABEL_CHARS (0 on any real
    // form). Counted from what the page handed back, before the cap.
    labelsTruncated: found.fields
      .slice(0, maxFields)
      .filter(f => overLabelCap(f?.label) || overLabelCap(f?.group?.question)).length,
    // CAPTCHA response fields left out of `fields` (and of formHash).
    captchaFieldsExcluded: Number.isFinite(found.captchaFieldsExcluded) ? found.captchaFieldsExcluded : 0,
    // lib/formHash.js: the same fingerprint fill_form computes for the live
    // form, so a packet can tell when the form it was prepared against changed.
    formHash: formHash(fields),
    // Required QUESTIONS: a multi-option question counts once, via its group.
    requiredCount:
      fields.filter(f => f.required).length + new Set(fields.filter(f => f.group?.required).map(f => f.group.name)).size,
    passwordFieldPresent: fields.some(f => f.type === 'password'),
    fileUploadPresent: fields.some(f => f.type === 'file'),
    submitControls: Array.isArray(found.submits) ? found.submits.length : 0,
    // Named, so a recipe author can see what would be clicked — and so a
    // reviewer can confirm a recipe does NOT click it.
    submits: (Array.isArray(found.submits) ? found.submits : []).slice(0, 10).map(x => ({
      selector: x?.selector ?? null,
      tag: x?.tag ?? null,
      text: truncate(x?.text, 60),
    })),
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

  const extraPhrases = probeKnowledge('empty_state', 'empty_phrase');
  const found = await withTimeout(
    page.evaluate((maxChars, nounList, extraPhrases) => {
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
        ...extraPhrases.map(src => new RegExp(src, 'i')),
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
    }, MAX_SAMPLE_CHARS, list, extraPhrases),
    PROBE_TIMEOUT_MS,
    null
  );
  if (!found) return { kind: 'empty_state', error: 'timed out checking for an empty-result state' };

  // Ordered most-confident first. "The site said so" beats any inference.
  // Body length is weighted above the sibling count, because a page that has
  // barely any text cannot meaningfully "have records the selector missed" —
  // whatever repeated siblings it has are navigation and chrome. A USAJOBS
  // shell with 1607 characters and 8 repeated nav-ish siblings was being
  // called records_present_selector_wrong, sending the reader hunting for a
  // selector on a page that had simply never rendered its results.
  //
  // The 2000-character threshold is a judgement, not a measurement: a real
  // results page carries far more than that, and a shell far less. Reported
  // alongside the verdict so it can be second-guessed from the evidence.
  const SHELL_TEXT_LIMIT = 2000;
  const likelyCause = found.explicitEmptyMessage
    ? 'genuinely_empty'
    : found.bodyTextLength < 200
      ? 'page_never_rendered'
      : found.largestSiblingGroup >= 3 && found.bodyTextLength >= SHELL_TEXT_LIMIT
        ? 'records_present_selector_wrong'
        : found.bodyTextLength < SHELL_TEXT_LIMIT
          ? 'page_never_rendered'
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
  repeated_structure: (page, step) => {
    // An unsubstituted "{{min_group}}" is a string, and a truthy one, so
    // `?? 3` would pass it straight through to a numeric comparison. Coerce
    // and fall back, which is what makes the parameter genuinely optional.
    const n = Number(step.min_group);
    return probeRepeatedStructure(page, Number.isFinite(n) && n >= 2 ? n : 3);
  },
  card_anatomy: (page, step) => probeCardAnatomy(page, step.card_selector, step.max_cards),
  card_match: (page, step) => probeCardMatch(page, step.card_selector, step.expected, step.max_cards),
  page_signature: page => probePageSignature(page),
  pagination_controls: page => probePaginationControls(page),
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
// `card_anatomy` and `card_match`, which need caller-supplied input.
async function autoDiagnose(page) {
  const out = [];
  for (const kind of ['empty_state', 'antibot', 'blockers', 'repeated_structure', 'forms']) {
    out.push(await runProbe(page, { kind, label: `auto:${kind}` }));
  }
  return out;
}

module.exports = { runProbe, autoDiagnose, PROBE_KINDS, probeForms, MAX_FORM_FIELDS, MAX_LABEL_CHARS };
