#!/usr/bin/env node
// The ONE generic scrape engine. No per-site code — everything about how to
// reach and read a site lives as data in sites/site_fields rows (db.js).
//
// Usage:
//   node engine.js <hostname-or-url>[#page_type] '<json params>' [--raw]
//
// page_type suffix ('#listing' | '#article') picks which recipe to use for a
// hostname. Omitting it defaults to 'listing' (back-compat). A 'listing' page
// extracts repeated cards (jobs array); an 'article' page extracts one record
// (single content block, e.g. a job detail page) from `params.url`.
//
// --raw includes each record's source innerText blob as `_raw` (useful when
// tuning a site's field extraction rules) — roughly doubles output size, so
// it's opt-in.
//
// Always prints exactly one JSON object to stdout:
//   { success, documented, ... site data or diagnostic fields ... }
//
// success:false + documented:false  -> nothing known about this site/page_type
//                                       yet. Fall back to interactive tools,
//                                       then call register.js to document it.
// success:false + documented:true   -> site is documented but currently
//                                       marked broken/needs-review, or this
//                                       run hit a real failure. Check the
//                                       `notes`/`error`/`timedOut` fields.
// success:true (listing)            -> trust `jobs` and `count`.
// success:true (article)            -> trust `article` (single object).

const { openDb, getSite, getFields, logRun, parseSiteArg } = require('./db');
const { withPage } = require('./lib/runner');

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

async function runUiSteps(page, stepsJson, params) {
  const steps = JSON.parse(stepsJson);
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
      default:
        throw new Error(`Unknown ui_steps action: ${step.action}`);
    }
  }
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
        let card = anchor.closest('div') || anchor.parentElement;
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
            record[f.field_name] = segments[f.segment_index] ?? null;
          } else if (f.extract_kind === 'regex_anywhere') {
            try {
              const re = new RegExp(f.regex_pattern);
              const m = blob.match(re);
              record[f.field_name] = m ? (m[1] !== undefined ? m[1] : m[0]) : null;
            } catch {
              record[f.field_name] = null;
            }
          } else if (f.extract_kind === 'anchor_attribute') {
            record[f.field_name] = anchor.getAttribute(f.attribute_name);
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
          record[f.field_name] = segments[f.segment_index] ?? null;
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
  const { hostname, pageType } = parseSiteArg(hostnamePart);

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
  const site = getSite(db, hostname, pageType);

  if (!site) {
    console.log(JSON.stringify({
      success: false,
      documented: false,
      error: `No site documented for "${hostname}#${pageType}". Fall back to interactive browser tools, then run register.js.`,
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

  if (site.page_type === 'article') {
    let articleOutcome;
    try {
      articleOutcome = await withPage(async page => {
        if (site.nav_method === 'direct_url') {
          const url = substitute(site.nav_template, params);
          if (!url) throw new Error(`Missing param for nav_template "${site.nav_template}" (expected e.g. {"url": "..."})`);
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        } else if (site.nav_method === 'ui_steps') {
          await runUiSteps(page, site.nav_template, params);
        } else {
          throw new Error(`Unsupported nav_method for page_type=article: ${site.nav_method}`);
        }

        let timedOut = false;
        try {
          await page.waitForFunction(
            (sel, minLen) => {
              const el = (sel && document.querySelector(sel)) || document.body;
              return !!(el && el.innerText && el.innerText.trim().length >= minLen);
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

        return { timedOut, record, blobLen, url: page.url() };
      });
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
    }));
    process.exit(success ? 0 : 1);
  }

  let outcome;

  try {
    outcome = await withPage(async page => {
      if (site.nav_method === 'url_param') {
        const url = buildUrl(site.nav_template, params);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } else if (site.nav_method === 'ui_steps') {
        await runUiSteps(page, site.nav_template, params);
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

      return { timedOut, jobs, claimedCount, url: page.url() };
    });
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
  }));
  process.exit(success ? 0 : 1);
}

main();
