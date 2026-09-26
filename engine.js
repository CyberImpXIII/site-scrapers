#!/usr/bin/env node
// The ONE generic scrape engine. No per-site code — everything about how to
// reach and read a site lives as data in sites/site_fields rows (db.js).
//
// Usage:
//   node engine.js <hostname-or-url>[#page_type[:recipe_name]] '<json params>' [--raw]
//
// page_type suffix ('#listing' | '#article' | '#action') picks which recipe
// to use for a hostname. Omitting it defaults to 'listing' (back-compat). A
// 'listing' page extracts repeated cards (jobs array); 'article' and 'action'
// both extract one record (single content block) via the same code path —
// 'article' is for reading a detail/post page (e.g. a job posting) from
// `params.url`; 'action' is for a repeatable automation (login, add-to-cart,
// etc, typically nav_method: 'ui_steps') where the "content" captured
// afterward, if any, is a result/confirmation rather than the main point.
// A hostname can have more than one recipe of the same page_type — add
// ':recipe_name' to disambiguate, e.g. "example.com#action:login" vs
// "example.com#action:add_to_cart". Omitting it uses recipe_name 'default'.
//
// --raw includes each record's source innerText blob as `_raw` (useful when
// tuning a site's field extraction rules) — roughly doubles output size, so
// it's opt-in.
//
// Always prints exactly one JSON object to stdout:
//   { success, documented, ... site data or diagnostic fields ... }
//
// success:false + documented:false  -> nothing known about this site/page_type
//                                       /recipe_name yet. Fall back to
//                                       interactive tools, then call
//                                       register.js to document it.
// success:false + documented:true   -> site is documented but currently
//                                       marked broken/needs-review, or this
//                                       run hit a real failure. Check the
//                                       `notes`/`error`/`timedOut` fields.
// success:true (listing)            -> trust `jobs` and `count`.
// success:true (article/action)     -> trust `article` (single object).
//
// A ui_steps sequence containing a 'handoff' step (see register.js's header
// comment) makes this run in a real, visible browser window instead of
// headless, and blocks until either a human completes that step (detected
// via resume_selector/resume_url_includes) or its timeout_ms elapses. Run
// such a call with a generous timeout (or in the background) — it isn't
// hung, it's waiting on a person.

const fs = require('fs');
const path = require('path');
const { openDb, getSite, getFields, logRun, parseSiteArg } = require('./db');
const { withPage } = require('./lib/runner');

const CAPTURE_DIR = path.join(__dirname, 'data', '.captures');

function toStr(val) {
  return typeof val === 'object' ? JSON.stringify(val) : String(val);
}

// For ui_steps (selectors, typed text, literal goto URLs): substitute raw.
// Encoding typed-into-a-form text or a CSS selector would be wrong.
function substitute(template, params) {
  if (typeof template !== 'string') return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const val = params[key];
    return val === undefined ? '' : toStr(val);
  });
}

// For url_param nav: substitute with percent-encoding, since values are
// landing inside a URL query string (and may be whole JSON objects, e.g.
// hiring.cafe's ?searchState=<encoded JSON>).
function buildUrl(navTemplate, params) {
  return navTemplate.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const val = params[key];
    return val === undefined ? '' : encodeURIComponent(toStr(val));
  });
}

// True when a ui_steps sequence contains a 'handoff' step — such a sequence
// must run in a real (headed) browser window, not headless, since a handoff
// means a human completes something by looking at and interacting with that
// window directly (there's no other channel back to them mid-run).
function stepsNeedHeaded(stepsJson) {
  try {
    const steps = JSON.parse(stepsJson);
    return Array.isArray(steps) && steps.some(s => s.action === 'handoff');
  } catch {
    return false;
  }
}

// Reads values back out of the page right after a handoff resolves — the
// only point where the human may have typed something the recipe params
// didn't already know. mode 'flagged' reads only the selectors step.capture
// declares (named, presumed non-secret, reusable values — an email, a
// reference/confirmation number). mode 'all' reads every input/textarea/
// select on the page, which WILL include passwords and one-time codes if
// any are still in a field — the caller (see CLAUDE.md: ask the user which
// mode, before telling them about the handoff) is choosing that
// deliberately, not this code.
async function capturePageInput(page, captureConfig, mode) {
  if (mode === 'flagged') {
    const fields = (captureConfig && captureConfig.fields) || {};
    if (Object.keys(fields).length === 0) return null;
    return page.evaluate(fields => {
      const out = {};
      for (const [varName, selector] of Object.entries(fields)) {
        const el = document.querySelector(selector);
        if (el && 'value' in el && el.value !== '') out[varName] = el.value;
      }
      return out;
    }, fields);
  }
  if (mode === 'all') {
    return page.evaluate(() => {
      const out = {};
      let i = 0;
      for (const el of document.querySelectorAll('input, textarea, select')) {
        if (!('value' in el) || el.value === '') continue;
        const key = (el.id || el.name || `field_${i}`).toString();
        out[key] = el.value;
        i += 1;
      }
      return out;
    });
  }
  return null;
}

// Writes captured values to a gitignored, mode-600 temp .env file — never to
// stdout/scrape_runs, since those may end up in a chat transcript or DB.
// Returns { file, keys } (keys only, not values) so the caller can report
// what was captured without echoing the values themselves anywhere.
function writeCaptureEnv(captured, { hostname, pageType, recipeName }) {
  if (!captured || Object.keys(captured).length === 0) return null;
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(CAPTURE_DIR, `${hostname}-${pageType}-${recipeName}-${stamp}.env`);
  const lines = [
    `# Captured from a handoff step on ${hostname}#${pageType}:${recipeName} at ${new Date().toISOString()}`,
    '# TEMPORARY — may contain secrets (passwords, one-time codes). Never committed to git.',
    '# Delete once you have consumed what you need from it.',
    ...Object.entries(captured).map(
      ([k, v]) => `${k.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}=${JSON.stringify(v)}`
    ),
  ];
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
  return { file, keys: Object.keys(captured) };
}

async function runUiSteps(page, stepsJson, params, siteMeta) {
  const steps = JSON.parse(stepsJson);
  const captures = [];
  for (const step of steps) {
    const sel = step.selector ? substitute(step.selector, params) : undefined;
    switch (step.action) {
      case 'goto':
        await page.goto(substitute(step.url, params), { waitUntil: 'domcontentloaded', timeout: 30000 });
        break;
      case 'click': {
        const el = await page.waitForSelector(sel, { timeout: step.timeout ?? 10000 });
        await el.click();
        break;
      }
      case 'type': {
        const el = await page.waitForSelector(sel, { timeout: step.timeout ?? 10000 });
        await el.type(substitute(step.text, params));
        break;
      }
      case 'waitForSelector':
        await page.waitForSelector(sel, { timeout: step.timeout ?? 10000 });
        break;
      case 'wait':
        await new Promise(r => setTimeout(r, step.ms ?? 1000));
        break;
      case 'handoff': {
        // Pause the automated sequence here — the browser is real/visible
        // (see stepsNeedHeaded), so the person running this looks at that
        // window and does whatever step.reason describes by hand (entering
        // a 2FA/OTP code, solving a CAPTCHA, clicking a final "place order"
        // button — anything the recipe shouldn't do unattended). Resumption
        // is detected automatically from the page itself, never a signal
        // back through this process: give resume_selector (an element that
        // only appears once the manual step is done) and/or
        // resume_url_includes (a URL substring reached after it). With
        // neither, this just waits out timeout_ms and then continues blind
        // — only use that as a last resort.
        const timeout = step.timeout_ms ?? 300000;
        if (step.resume_selector) {
          await page.waitForSelector(substitute(step.resume_selector, params), { timeout });
        } else if (step.resume_url_includes) {
          await page.waitForFunction(
            frag => location.href.includes(frag),
            { timeout },
            substitute(step.resume_url_includes, params)
          );
        } else {
          await new Promise(r => setTimeout(r, timeout));
        }
        // captureMode is a per-run param (never stored in the recipe) — see
        // CLAUDE.md: ask the user which mode to use for THIS run before
        // telling them about the handoff. 'none'/absent captures nothing.
        if (step.capture && params.captureMode && params.captureMode !== 'none') {
          const captured = await capturePageInput(page, step.capture, params.captureMode);
          const written = writeCaptureEnv(captured, siteMeta);
          if (written) captures.push(written);
        }
        break;
      }
      default:
        throw new Error(`Unknown ui_steps action: ${step.action}`);
    }
  }
  return { captures };
}

async function extractCards(page, { cardAnchorText, cardMinTextLen, fields, includeRaw }) {
  return page.evaluate(
    (cardAnchorText, cardMinTextLen, fields, includeRaw) => {
      const anchors = Array.from(document.querySelectorAll('a, button')).filter(
        el => el.textContent.trim() === cardAnchorText
      );

      const results = [];
      const seenBlobs = new Set();

      for (const anchor of anchors) {
        // closest() with a combined selector picks the nearest matching
        // ancestor regardless of list order — tr/li cover table- and
        // list-based card layouts (e.g. remoteok.com's <table><tr class="job">),
        // div covers the more common case (e.g. hiring.cafe).
        let card = anchor.closest('tr, li, div') || anchor.parentElement;
        for (let i = 0; i < 6 && card; i++) {
          if (card.innerText && card.innerText.length > cardMinTextLen) break;
          card = card.parentElement;
        }
        if (!card) continue;

        const blob = card.innerText
          .split('\n')
          .map(s => s.trim())
          .filter(Boolean)
          .join(' | ');

        if (seenBlobs.has(blob)) continue;
        seenBlobs.add(blob);

        const segments = blob.split(' | ');
        const record = {};

        for (const f of fields) {
          if (f.extract_kind === 'positional_segment') {
            // Negative segment_index counts from the end (Python-style) —
            // useful when a variable number of tokens (e.g. a "Boosted" badge)
            // can appear earlier in the blob but a field is reliably last.
            const idx = f.segment_index < 0 ? segments.length + f.segment_index : f.segment_index;
            record[f.field_name] = segments[idx] ?? null;
          } else if (f.extract_kind === 'regex_anywhere') {
            try {
              const re = new RegExp(f.regex_pattern);
              const m = blob.match(re);
              record[f.field_name] = m ? (m[1] !== undefined ? m[1] : m[0]) : null;
            } catch {
              record[f.field_name] = null;
            }
          } else if (f.extract_kind === 'anchor_attribute') {
            // regex_pattern is repurposed here as an optional CSS selector: some
            // sites' card_anchor_text identifies the card via an element that
            // isn't the link you actually want the attribute from (e.g. a "View
            // Company Profile" link marks the card, but the job URL is a
            // different <a> inside it). Defaults to the matched anchor itself.
            let attrEl = anchor;
            if (f.regex_pattern) {
              const found = card.querySelector(f.regex_pattern);
              if (found) attrEl = found;
            }
            record[f.field_name] = attrEl.getAttribute(f.attribute_name);
          }
        }
        if (includeRaw) record._raw = blob;
        results.push(record);
      }
      return results;
    },
    cardAnchorText,
    cardMinTextLen,
    fields,
    includeRaw
  );
}

// Article pages are one record per page, not repeated cards. Pull text from
// contentSelector (default body), optionally truncate at contentStopText
// (cuts off "related content" widgets etc. that would otherwise bloat the
// blob), then run the same field-extraction kinds as extractCards, plus two
// article-only kinds: 'title_regex' (matches against document.title, which
// is often cleaner/more stable than positional blob parsing) and 'full_blob'
// (the entire post-truncation text, for a catch-all body/description field).
async function extractArticle(page, { contentSelector, contentStopText, minTextLen, fields, includeRaw }) {
  return page.evaluate(
    (contentSelector, contentStopText, minTextLen, fields, includeRaw) => {
      const container = (contentSelector && document.querySelector(contentSelector)) || document.body;
      if (!container) return { record: null, blobLen: 0 };

      let text = container.innerText || '';
      if (contentStopText) {
        const idx = text.indexOf(contentStopText);
        if (idx !== -1) text = text.slice(0, idx);
      }

      const blob = text
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean)
        .join(' | ');
      const segments = blob.split(' | ');
      const record = {};

      for (const f of fields) {
        if (f.extract_kind === 'positional_segment') {
          const idx = f.segment_index < 0 ? segments.length + f.segment_index : f.segment_index;
          record[f.field_name] = segments[idx] ?? null;
        } else if (f.extract_kind === 'regex_anywhere') {
          try {
            const re = new RegExp(f.regex_pattern);
            const m = blob.match(re);
            record[f.field_name] = m ? (m[1] !== undefined ? m[1] : m[0]) : null;
          } catch {
            record[f.field_name] = null;
          }
        } else if (f.extract_kind === 'title_regex') {
          try {
            const re = new RegExp(f.regex_pattern);
            const m = document.title.match(re);
            record[f.field_name] = m ? (m[1] !== undefined ? m[1] : m[0]) : null;
          } catch {
            record[f.field_name] = null;
          }
        } else if (f.extract_kind === 'full_blob') {
          record[f.field_name] = blob;
        } else if (f.extract_kind === 'anchor_attribute') {
          record[f.field_name] = container.getAttribute(f.attribute_name);
        }
      }
      if (includeRaw) record._raw = blob;
      return { record, blobLen: blob.length };
    },
    contentSelector,
    contentStopText,
    minTextLen,
    fields,
    includeRaw
  );
}

async function main() {
  const startedAt = Date.now();
  const [, , hostnameArg, paramsArg, ...rest] = process.argv;
  const includeRaw = rest.includes('--raw');

  if (!hostnameArg) {
    console.log(JSON.stringify({ success: false, documented: false, error: 'Usage: node engine.js <hostname> \'<json params>\'' }));
    process.exit(1);
  }

  let hostnamePart = hostnameArg;
  try {
    if (hostnameArg.startsWith('http')) hostnamePart = new URL(hostnameArg).hostname;
  } catch {
    /* leave as-is */
  }
  const { hostname, pageType, recipeName } = parseSiteArg(hostnamePart);

  let params = {};
  if (paramsArg) {
    try {
      params = JSON.parse(paramsArg);
    } catch (e) {
      console.log(JSON.stringify({ success: false, documented: false, error: `Bad JSON in params: ${e.message}` }));
      process.exit(1);
    }
  }

  const db = openDb();
  const site = getSite(db, hostname, pageType, recipeName);

  if (!site) {
    console.log(JSON.stringify({
      success: false,
      documented: false,
      error: `No site documented for "${hostname}#${pageType}:${recipeName}". Fall back to interactive browser tools, then run register.js.`,
    }));
    process.exit(1);
  }

  if (site.status !== 'working') {
    console.log(JSON.stringify({
      success: false,
      documented: true,
      status: site.status,
      notes: site.notes,
      error: `Site is documented but status="${site.status}". Fall back to interactive tools.`,
    }));
    process.exit(1);
  }

  const fields = getFields(db, site.id);
  const headed = site.nav_method === 'ui_steps' && stepsNeedHeaded(site.nav_template);
  const siteMeta = { hostname: site.hostname, pageType: site.page_type, recipeName: site.recipe_name };
  // Session persistence is ON BY DEFAULT (params.session picks which named,
  // parallel session — e.g. a second account — default 'default'); a run
  // opts out entirely with params.noSession: true.
  const sessionName = params.session || 'default';
  const sessionOpt = params.noSession ? undefined : { hostname: site.hostname, sessionName };

  if (site.page_type === 'article' || site.page_type === 'action') {
    let articleOutcome;
    try {
      articleOutcome = await withPage(async page => {
        let captures = [];
        if (site.nav_method === 'direct_url') {
          const url = substitute(site.nav_template, params);
          if (!url) throw new Error(`Missing param for nav_template "${site.nav_template}" (expected e.g. {"url": "..."})`);
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        } else if (site.nav_method === 'ui_steps') {
          ({ captures } = await runUiSteps(page, site.nav_template, params, siteMeta));
        } else {
          throw new Error(`Unsupported nav_method for page_type=${site.page_type}: ${site.nav_method}`);
        }

        let timedOut = false;
        try {
          await page.waitForFunction(
            (sel, minLen) => {
              const el = (sel && document.querySelector(sel)) || document.body;
              // `el.innerText &&` alone would short-circuit on a legitimately
              // empty string and never resolve when minLen is 0 — compare
              // length directly instead.
              return !!(el && el.innerText != null && el.innerText.trim().length >= minLen);
            },
            { timeout: site.ready_timeout_ms },
            site.content_selector,
            site.card_min_text_len
          );
        } catch {
          timedOut = true;
        }

        const { record, blobLen } = await extractArticle(page, {
          contentSelector: site.content_selector,
          contentStopText: site.content_stop_text,
          minTextLen: site.card_min_text_len,
          fields,
          includeRaw,
        });

        return { timedOut, record, blobLen, url: page.url(), captures };
      }, { headed, session: sessionOpt });
    } catch (e) {
      logRun(db, { siteId: site.id, params, success: false, error: e.message, durationMs: Date.now() - startedAt });
      console.log(JSON.stringify({ success: false, documented: true, error: `Engine threw: ${e.message}` }));
      process.exit(1);
    }

    const success = !articleOutcome.timedOut && articleOutcome.blobLen > 0;

    logRun(db, {
      siteId: site.id,
      params,
      success,
      resultCount: success ? 1 : 0,
      timedOut: articleOutcome.timedOut,
      durationMs: Date.now() - startedAt,
    });

    console.log(JSON.stringify({
      success,
      documented: true,
      timedOut: articleOutcome.timedOut,
      url: articleOutcome.url,
      article: articleOutcome.record,
      // file path + captured KEY NAMES only — never the captured values.
      handoffCaptures: articleOutcome.captures,
      sessionUsed: sessionOpt ? sessionName : null,
    }));
    process.exit(success ? 0 : 1);
  }

  let outcome;

  try {
    outcome = await withPage(async page => {
      let captures = [];
      if (site.nav_method === 'url_param') {
        const url = buildUrl(site.nav_template, params);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } else if (site.nav_method === 'ui_steps') {
        ({ captures } = await runUiSteps(page, site.nav_template, params, siteMeta));
      } else {
        throw new Error(`Unknown nav_method: ${site.nav_method}`);
      }

      let timedOut = false;
      try {
        await page.waitForFunction(
          anchorText => Array.from(document.querySelectorAll('a, button')).some(el => el.textContent.trim() === anchorText),
          { timeout: site.ready_timeout_ms },
          site.card_anchor_text
        );
      } catch {
        timedOut = true;
      }

      const jobs = await extractCards(page, {
        cardAnchorText: site.card_anchor_text,
        cardMinTextLen: site.card_min_text_len,
        fields,
        includeRaw,
      });

      let claimedCount = null;
      if (site.result_count_regex) {
        claimedCount = await page.evaluate(pattern => {
          const m = document.body.innerText.match(new RegExp(pattern));
          return m ? m[1] : null;
        }, site.result_count_regex);
      }

      return { timedOut, jobs, claimedCount, url: page.url(), captures };
    }, { headed, session: sessionOpt });
  } catch (e) {
    logRun(db, { siteId: site.id, params, success: false, error: e.message, durationMs: Date.now() - startedAt });
    console.log(JSON.stringify({ success: false, documented: true, error: `Engine threw: ${e.message}` }));
    process.exit(1);
  }

  const success = !outcome.timedOut && outcome.jobs.length > 0;

  // Self-consistency check: if the site tells us its own result count and it
  // wildly disagrees with what we scraped, don't just trust jobs.length > 0.
  let consistencyWarning = null;
  if (outcome.claimedCount !== null) {
    const claimed = parseInt(String(outcome.claimedCount).replace(/,/g, ''), 10);
    if (!Number.isNaN(claimed) && claimed === 0 && outcome.jobs.length > 0) {
      consistencyWarning = `Site claims ${claimed} results but we extracted ${outcome.jobs.length} cards — likely stale/cached DOM.`;
    }
  }

  logRun(db, {
    siteId: site.id,
    params,
    success,
    resultCount: outcome.jobs.length,
    claimedCount: outcome.claimedCount,
    timedOut: outcome.timedOut,
    durationMs: Date.now() - startedAt,
  });

  console.log(JSON.stringify({
    success,
    documented: true,
    timedOut: outcome.timedOut,
    url: outcome.url,
    claimedCount: outcome.claimedCount,
    consistencyWarning,
    count: outcome.jobs.length,
    jobs: outcome.jobs,
    handoffCaptures: outcome.captures,
    sessionUsed: sessionOpt ? sessionName : null,
  }));
  process.exit(success ? 0 : 1);
}

main();
