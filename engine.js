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
//
// A ui_steps sequence can also include a 'run_action' step to reuse another
// action recipe as a substep (see register.js's header comment) — e.g. a
// 'purchase_item' action composing an existing 'login' action rather than
// duplicating its steps. All run_action references are expanded to a flat
// step list up front, before the browser launches, so a dangling reference
// or a reference cycle fails fast with a clear error.
//
// Any run failure (thrown error, timeout, or zero results) captures a
// screenshot + DOM + recent console/network-failure logs to a gitignored
// data/.debug/ directory, reported as `debugDir` in the output JSON — see
// lib/debug.js. On by default; params.noDiagnostics: true skips it.

// node:sqlite emits an ExperimentalWarning on every run, which lands on
// stderr and makes this tool's output awkward to pipe into jq. Real warnings
// are not expected here and would be noise in a machine-read stream.
process.removeAllListeners('warning');


const fs = require('fs');
const path = require('path');
const { openDb, getSite, getFields, logRun: logRunRaw, parseSiteArg, getCurrentVersion } = require('./db');
const { authorize: authorizeWrite } = require('./lib/writeGuard');

// A run recording its own outcome is a sanctioned write, but a narrow one: this
// authorizes the single insert rather than the whole run, so nothing else in
// engine.js can write to the recipe DB under cover of it.
const logRun = (db, run) => authorizeWrite('engine.js run telemetry', () => logRunRaw(db, run));
const { withPage, captureFailureDiagnostics } = require('./lib/runner');
const { runProbe } = require('./lib/probes');
const { expandSteps, stepsNeedHeaded, refKey } = require('./lib/composeActions');
const { resolveUrlFields } = require('./lib/urlAttrs');

const CAPTURE_DIR = path.join(__dirname, 'data', '.captures');

function toStr(val) {
  return typeof val === 'object' ? JSON.stringify(val) : String(val);
}

// For ui_steps (selectors, typed text, literal goto URLs): substitute raw.
// Encoding typed-into-a-form text or a CSS selector would be wrong.
// Print the result, then exit only once stdout has actually flushed.
//
// `console.log(x); process.exit(code)` TRUNCATES when stdout is a pipe. Writes
// to a pipe are asynchronous, process.exit does not wait for them, and the
// write is cut at the pipe buffer. Observed on a 321-posting Lever board: the
// JSON ended mid-string at byte 65532 and every reader got "Unterminated string
// in JSON", which reads as a broken recipe rather than a lost write.
//
// It hid for so long because both conditions are needed. Writes to a TTY are
// synchronous, so it never happens interactively, and a small result fits the
// buffer, so it never happens on a normal-sized board. It needs a large result
// AND a pipe — `./scrape.sh <big board> | jq`, or verify.js/audit.js reading a
// child's stdout, which is exactly where the data matters most.
//
// The callback form is used rather than setting process.exitCode, because the
// browser may still hold handles that would keep the event loop alive and turn
// a clean exit into a hang.
function emitAndExit(payload, code) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  process.stdout.write(`${text}\n`, () => process.exit(code));
}

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
  // A missing param used to substitute to an empty string, producing a
  // valid-LOOKING but wrong URL: wellfound.com's /role/r/{{role}} became
  // /role/r/ and returned nothing, which reads as "the recipe broke" rather
  // than "you forgot an argument". That cost a wrong diagnosis twice — once by
  // hand and once inside audit.js, which reported a recipe verified at 39
  // records as a liar. Failing here names the actual problem.
  const missing = [...new Set([...navTemplate.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]))].filter(
    key => params[key] === undefined || params[key] === null
  );
  if (missing.length) {
    throw new Error(
      `Missing required param${missing.length > 1 ? 's' : ''} for nav_template: ${missing.join(', ')}. ` +
        `The template is "${navTemplate}" — check nav_params_schema (\`node query.js site <target>\`) for what each one expects. ` +
        'Pass an empty string explicitly if a blank value is genuinely intended.'
    );
  }
  return navTemplate.replace(/\{\{(\w+)\}\}/g, (_, key) => encodeURIComponent(toStr(params[key])));
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
  // Sanitized like the session/debug writers do — these come from DB rows,
  // and a hostname containing a path separator would otherwise write
  // outside CAPTURE_DIR.
  const safe = s => String(s).replace(/[^a-zA-Z0-9._-]/g, '_');
  const file = path.join(CAPTURE_DIR, `${safe(hostname)}-${safe(pageType)}-${safe(recipeName)}-${stamp}.env`);
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

// Hard ceiling on a `repeat` step's iteration count, whatever a caller's
// params ask for, so a typo like extra_pages: 1000 can't run away.
const MAX_REPEAT = 50;

// Thrown by a `click` step marked stop_if_missing when its element is absent
// or disabled (e.g. the "Next" button on the last page). Ends the innermost
// enclosing `repeat` early; at the top level it just ends the step list.
class StopRepeat extends Error {}

// A step field that may be a number or a "{{param}}" template. Blank/invalid
// resolves to `fallback`.
function numericParam(value, params, fallback) {
  if (value === undefined || value === null) return fallback;
  const str = substitute(String(value), params).trim();
  if (str === '') return fallback;
  const n = Number(str);
  return Number.isFinite(n) ? n : fallback;
}

// `steps` is already fully expanded — any run_action/run_generic_action
// references were resolved by expandSteps() before this runs (including
// inside `repeat` blocks). `hooks.collect`, when present (listing recipes),
// extracts the current page's cards into the run's accumulator.
async function runUiSteps(page, steps, params, siteMeta, hooks = {}, depth = 0) {
  const captures = [];
  const diagnostics = [];
  // The breadcrumb is a single module-level slot, which is correct only
  // while one sequence runs at a time. Nested `repeat` recursion is still
  // sequential and fine; two OVERLAPPING sequences would interleave their
  // writes and the survivor would name a step that didn't fail. Counted
  // here at the entry point rather than in runStepList, which recurses.
  // A wrong answer stated confidently is worse than an admitted unknown,
  // so this reports the doubt instead of hiding it.
  progress.activeRuns += 1;
  if (progress.activeRuns > 1) progress.concurrentDetected = true;
  try {
    await runStepList(page, steps, params, siteMeta, hooks, depth, captures, diagnostics);
  } catch (e) {
    if (!(e instanceof StopRepeat) || depth > 0) {
      // Attach where we got to, so the failure travels with its location
      // instead of arriving as a bare selector timeout. Read back by
      // lib/debug.js (into meta.json) and by the output JSON below.
      if (progress.current && !e.failedStep) {
        e.failedStep = progress.concurrentDetected
          ? {
              ...progress.current,
              breadcrumbUnreliable: true,
              note:
                'Overlapping step sequences ran in this process, so this may name a step from another branch. ' +
                'Run one sequence per process (parallelise across processes, not inside one) to get a trustworthy position.',
            }
          : progress.current;
      }
      throw e;
    }
  } finally {
    progress.activeRuns -= 1;
  }
  return { captures, diagnostics };
}

// Describes a step precisely enough to act on without dumping the whole
// recipe: which position, what it was trying to do, and (for a step pulled
// in from a reusable action) where it came from.
// A url_param or direct_url recipe has no ui_steps, so a failure has no
// step to point at and `failedStep` is null. Two independent troubleshooting
// runs recorded exactly that as a dead end ("failedStep null -- url_param
// nav has no ui_steps to blame"). What was actually in flight is the wait
// for cards/content, so say so: which matcher was being waited on, and for
// how long. That is the equivalent information, and without it the operator
// is left re-reading the recipe to work out what the timeout even meant.
function navFailureContext(site, { phase }) {
  return {
    phase,
    nav_method: site.nav_method,
    matcher: site.card_selector
      ? { kind: 'card_selector', value: site.card_selector }
      : site.card_anchor_text
        ? { kind: 'card_anchor_text', value: site.card_anchor_text, match: 'exact text, not substring' }
        : site.content_selector
          ? { kind: 'content_selector', value: site.content_selector }
          : null,
    ready_timeout_ms: site.ready_timeout_ms,
    note:
      'This recipe has no ui_steps, so there is no failing step — the wait above is what expired. ' +
      'diagnostics.json in debugDir reports what the page actually contained.',
  };
}

// Whether a failed run nevertheless carries usable output. Extracted as a
// function so the decision is testable: the race that produces it (content
// rendering microseconds past the wait deadline) cannot be reproduced
// deterministically through the CLI, but the RULE can be pinned -- in
// particular that `success` stays false, so no existing caller silently
// changes behaviour.
function isPartial(timedOut, extractedCount) {
  return Boolean(timedOut) && extractedCount > 0;
}

// Module-level because a step list is run from several places (main steps,
// pagination steps, nested repeats) and the failure path needs the last
// step attempted regardless of which one was running.
const progress = { current: null, activeRuns: 0, concurrentDetected: false };

// How long page.goto is allowed, derived from the recipe's own ready_timeout_ms.
//
// Puppeteer's 30s default was hardcoded at every navigation, which silently
// contradicted the one knob a recipe has for saying "this site is slow": a
// recipe could declare ready_timeout_ms 60000 and still die at 30 seconds while
// navigating, reported as "Navigation timeout of 30000 ms exceeded" with
// failedStep null — an error naming neither the recipe nor a step.
//
// Floored at 30s so this can only ever LENGTHEN a navigation. A recipe with a
// short ready_timeout_ms is saying its content appears quickly, not that the
// page must arrive quickly, and shortening navigation on that basis would break
// working recipes to fix none.
const DEFAULT_NAV_TIMEOUT_MS = 30000;
function navTimeoutFor(readyTimeoutMs) {
  return Math.max(DEFAULT_NAV_TIMEOUT_MS, Number(readyTimeoutMs) || 0);
}

function describeStep(step, index, total, path) {
  return {
    index,
    of: total,
    path,
    action: step.action,
    selector: step.selector ?? null,
    // Text is part of "what it was doing" but may be a substituted
    // credential, so only the fact that text was supplied is reported.
    hasText: step.text !== undefined,
    from: step._from ?? null,
  };
}

async function runStepList(page, steps, params, siteMeta, hooks, depth, captures, diagnostics, trail = []) {
  for (const [index, step] of steps.entries()) {
    // Recorded BEFORE the step runs, so whatever throws leaves the position
    // behind. Without this a failure is just "selector timeout" and the
    // whole sequence has to be replayed to work out where it happened —
    // which is the expensive part of building a recipe.
    const path = [...trail, index];
    progress.current = describeStep(step, index, steps.length, path);
    // A selector that is still "{{param}}" after substitution means the
    // caller supplied nothing, so fall back to default_selector when the step
    // offers one. This is what lets a generic action parameterise its
    // vocabulary without forcing every caller to restate it — the default
    // stays overridable instead of being baked in.
    let sel = step.selector ? substitute(step.selector, params) : undefined;
    if (sel !== undefined && /^\s*\{\{[^}]*\}\}\s*$/.test(sel)) {
      // Still a placeholder, so the caller supplied nothing. Either fall back
      // to the step's default, or treat the step as not asked for and skip
      // it. Both let a generic action offer an OPTIONAL selector parameter —
      // the way a site adds its own unrecognised consent banner without
      // forking the whole action. Erroring on the literal "{{param}}" instead
      // would make every such parameter mandatory.
      if (step.default_selector) {
        sel = step.default_selector;
      } else if (step.optional_selector) {
        continue;
      }
    }
    switch (step.action) {
      case 'goto': {
        const targetUrl = substitute(step.url, params);
        try {
          // siteMeta may be absent in a bare step-list test, hence the fallback.
          await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: siteMeta?.navTimeoutMs ?? 30000 });
        } catch (e) {
          // A server-side redirect (e.g. an already-authenticated session
          // redirecting straight past a login page) can race Puppeteer's
          // navigation-lifecycle detection and throw even though the
          // browser actually lands somewhere real — observed live on
          // facebook.com#action:login: a valid saved session skipped the
          // login prompt (confirmed by the person running it), but goto()
          // still reported "Navigation timeout of 30000 ms exceeded".
          // Only swallow the error if we verifiably ended up on the same
          // hostname we were headed to — a strong signal this is that
          // lifecycle-event race, not a genuine failure (network down,
          // wrong URL, actually stuck).
          let landedHostname = null;
          let targetHostname = null;
          try {
            landedHostname = new URL(page.url()).hostname;
          } catch {
            /* page.url() unavailable/invalid — landedHostname stays null, falls through to rethrow below */
          }
          try {
            targetHostname = new URL(targetUrl).hostname;
          } catch {
            /* malformed targetUrl — falls through to rethrow below */
          }
          if (!landedHostname || !targetHostname || landedHostname !== targetHostname) throw e;
        }
        break;
      }
      case 'click': {
        if (step.stop_if_missing) {
          // Missing or disabled (last page) ends the enclosing repeat instead
          // of failing the run.
          let el;
          try {
            el = await page.waitForSelector(sel, { timeout: step.timeout ?? 5000 });
          } catch {
            throw new StopRepeat();
          }
          const disabled = await el.evaluate(
            e => !!(e.disabled || e.getAttribute('aria-disabled') === 'true' || e.classList.contains('disabled'))
          );
          if (disabled) throw new StopRepeat();
          // A real link means a full page load: wait for it, or the next
          // step can run against the old page (or interrupt the load).
          const isLink = await el.evaluate(e => e.tagName === 'A' && !!e.href && !/#$/.test(e.href));
          const nav = isLink
            ? page
                .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: siteMeta?.navTimeoutMs ?? 30000 })
                .catch(() => null)
            : null;
          // Present but hidden (e.g. LinkedIn's "See more jobs" before it's
          // revealed): click it directly. A mouse click would first scroll
          // it into view, which can undo the scroll that loads more results.
          const hidden = await el.evaluate(e => e.offsetParent === null && getComputedStyle(e).position !== 'fixed');
          if (hidden) {
            await el.evaluate(e => e.click());
          } else {
            try {
              await el.click();
            } catch {
              await el.evaluate(e => e.click());
            }
          }
          if (nav) await nav;
          break;
        }
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
        await new Promise(r => setTimeout(r, numericParam(step.ms, params, step.default_ms ?? 1000)));
        break;
      case 'scroll_bottom':
        // Brings lazy-loaded content and below-the-fold "Next"/"Show more"
        // buttons into existence/view.
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await new Promise(r => setTimeout(r, step.ms ?? 500));
        break;
      case 'collect':
        if (!hooks.collect) throw new Error('"collect" step only works in listing recipes');
        await hooks.collect();
        break;
      case 'remove_element': {
        // Delete matching nodes outright instead of interacting with them.
        // For a consent/cookie overlay this is the option that sends NO
        // signal either way — you neither accept nor reject, you just stop
        // it covering the page. Uses page.$$ (not querySelectorAll inside
        // evaluate) so Puppeteer's ::-p-text()/::-p-aria() selectors still
        // work here; a plain evaluate would only understand native CSS.
        // Never fails when nothing matches — removing nothing is a fine
        // outcome, so there's no stop_if_missing to think about.
        const handles = sel ? await page.$$(sel).catch(() => []) : [];
        for (const h of handles) {
          await h.evaluate(e => e.remove()).catch(() => {});
        }
        if (step.restore_scroll) {
          // Overlays typically lock scrolling on body/html while open;
          // removing the node alone leaves the page unscrollable, which
          // silently breaks scroll_bottom and infinite_scroll afterward.
          await page
            .evaluate(() => {
              for (const el of [document.documentElement, document.body]) {
                if (!el) continue;
                el.style.setProperty('overflow', 'auto', 'important');
                el.style.setProperty('position', 'static', 'important');
              }
            })
            .catch(() => {});
        }
        break;
      }
      case 'probe': {
        // Reports, never acts. runProbe never throws, so a probe can't be
        // the reason a run fails -- diagnostics exist for when things are
        // already broken.
        // Substitute params like every other step type does. Without this a
        // probe could not be parameterised at all -- `with: {selectors:
        // "{{sel}}"}` arrived at the probe as the literal string "{{sel}}"
        // and came back as "invalid selector".
        //
        // EVERY string field, not a named list of them. The list was
        // `selectors, label, record_nouns`, and it silently went stale twice:
        // `min_group` was documented as a parameter of probe_card_candidates
        // while never being substituted (it only worked because the probe
        // coerces a NaN back to its default), and card_anatomy's card_selector
        // arrived as the literal "{{card_selector}}". A probe field that has to
        // be added to a list somewhere else is a field that will be forgotten.
        // Non-strings pass through untouched, so a numeric field stays numeric.
        diagnostics.push(
          await runProbe(
            page,
            Object.fromEntries(
              Object.entries(step).map(([k, v]) => [k, typeof v === 'string' ? substitute(v, params) : v])
            )
          )
        );
        break;
      }
      case 'repeat': {
        const times = Math.min(Math.max(Math.floor(numericParam(step.times, params, 0)), 0), MAX_REPEAT);
        for (let i = 0; i < times; i++) {
          try {
            await runStepList(page, step.steps || [], params, siteMeta, hooks, depth + 1, captures, diagnostics, [...path, `repeat#${i}`]);
          } catch (e) {
            if (e instanceof StopRepeat) break;
            throw e;
          }
        }
        break;
      }
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
        // `only_if_selector` makes the pause CONDITIONAL, which is what a
        // captcha handoff needs: an unconditional one would stop every run
        // to wait for a person who has nothing to do. Parallels
        // stop_if_missing on click — if the guard selector isn't on the
        // page, the whole step is skipped.
        if (step.only_if_selector) {
          const guard = substitute(step.only_if_selector, params);
          const present = (await page.$$(guard)).length > 0;
          if (!present) break;
        }
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
}

// Read once per extraction so URL attributes can be resolved against what the
// browser itself would resolve them against — which is baseURI, not the page
// URL, on a page carrying a <base> tag.
async function baseUriOf(page) {
  try {
    return await page.evaluate(() => document.baseURI);
  } catch {
    return null; // a wedged page just means hrefs stay as written
  }
}

async function extractCards(page, { cardAnchorText, cardSelector, cardMinTextLen, fields, includeRaw }) {
  const records = await page.evaluate(
    (cardAnchorText, cardSelector, cardMinTextLen, fields, includeRaw) => {
      // Two ways to find cards. card_selector (when set) matches each card
      // container directly — for sites with no literal text shared by every
      // card (e.g. linkedin.com's public search, builtin.com, dice.com). The
      // card's first <a> then stands in as "the anchor" for anchor_attribute
      // fields. Otherwise, card_anchor_text finds a per-card element and
      // walks up from it to the card.
      const pairs = [];
      if (cardSelector) {
        for (const card of document.querySelectorAll(cardSelector)) {
          pairs.push({ anchor: card.querySelector('a') || card, card });
        }
      } else {
        const anchors = Array.from(document.querySelectorAll('a, button')).filter(
          el => el.textContent.trim() === cardAnchorText
        );
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
          if (card) pairs.push({ anchor, card });
        }
      }

      const results = [];
      const seenBlobs = new Set();

      for (const { anchor, card } of pairs) {

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
          } else if (f.extract_kind === 'child_text') {
            // The text of a named element INSIDE the card. regex_pattern is a
            // CSS selector, same repurposing as anchor_attribute, and
            // segment_index optionally picks the nth match (default 0).
            //
            // This exists because positional_segment assumes every card has the
            // same shape, and cards routinely do not: an optional company
            // rating, a sponsored badge, a missing location. Every field after
            // the variable part shifts by one, silently, and the record looks
            // plausible while being wrong — a job's location reported as "2 Days
            // Ago", or a salary string reported as a location. That has happened
            // on four sites (builtin.com, nodesk.co, wellfound.com,
            // ziprecruiter.com), and a regex workaround only ever patched the
            // symptom on one field at a time.
            //
            // Addressing an element directly is immune to the whole class: a
            // missing element yields null rather than shifting its neighbours.
            try {
              const matches = card.querySelectorAll(f.regex_pattern);
              const idx = f.segment_index == null ? 0 : f.segment_index < 0 ? matches.length + f.segment_index : f.segment_index;
              const el = matches[idx];
              record[f.field_name] = el ? el.innerText.trim().replace(/\s+/g, ' ') || null : null;
            } catch {
              // A malformed selector yields null like any other miss, rather
              // than taking down every remaining field on the card.
              record[f.field_name] = null;
            }
          } else if (f.extract_kind === 'ancestor_first_line') {
            // For sites that group several job cards under one header (e.g.
            // wellfound.com lists each company once, with its jobs beneath):
            // regex_pattern is a CSS selector for that group container, and
            // the field is the first line of its text — the header.
            const group = card.closest(f.regex_pattern);
            const line = group && group.innerText.split('\n').map(t => t.trim()).find(Boolean);
            record[f.field_name] = line || null;
          }
        }
        if (includeRaw) record._raw = blob;
        results.push(record);
      }
      return results;
    },
    cardAnchorText,
    cardSelector,
    cardMinTextLen,
    fields,
    includeRaw
  );
  return resolveUrlFields(records, fields, await baseUriOf(page));
}

// Article pages are one record per page, not repeated cards. Pull text from
// contentSelector (default body), optionally truncate at contentStopText
// (cuts off "related content" widgets etc. that would otherwise bloat the
// blob), then run the same field-extraction kinds as extractCards, plus two
// article-only kinds: 'title_regex' (matches against document.title, which
// is often cleaner/more stable than positional blob parsing) and 'full_blob'
// (the entire post-truncation text, for a catch-all body/description field).
async function extractArticle(page, { contentSelector, contentStopText, minTextLen, fields, includeRaw }) {
  const result = await page.evaluate(
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
  if (result && result.record) resolveUrlFields([result.record], fields, await baseUriOf(page));
  return result;
}

async function main() {
  const startedAt = Date.now();
  const [, , hostnameArg, paramsArg, ...rest] = process.argv;
  const includeRaw = rest.includes('--raw');

  if (!hostnameArg) {
    emitAndExit(JSON.stringify({ success: false, documented: false, error: 'Usage: node engine.js <hostname> \'<json params>\'' }), 1);
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
      emitAndExit(JSON.stringify({ success: false, documented: false, error: `Bad JSON in params: ${e.message}` }), 1);
    }
  }

  const db = openDb();
  const site = getSite(db, hostname, pageType, recipeName);

  if (!site) {
    emitAndExit({
      success: false,
      documented: false,
      error: `No site documented for "${hostname}#${pageType}:${recipeName}". Fall back to interactive browser tools, then run register.js.`,
    }, 1);
  }

  // Refusing to run a recipe that isn't blessed is the useful default: it
  // stops a caller silently depending on something known broken. But it
  // cannot be absolute, or a recipe could never be verified in the first
  // place — the status gate would reject every run that might earn the
  // status. `allowUnverified` is that escape hatch, and it is how verify.js
  // exercises a candidate. Deliberate per call, never a recipe setting.
  if (site.status !== 'working' && !params.allowUnverified) {
    emitAndExit({
      success: false,
      documented: true,
      status: site.status,
      notes: site.notes,
      error:
        site.status === 'blocked'
          ? `Site is documented and the recipe is believed correct, but status="blocked": this site requires a person ` +
            'every run (CAPTCHA, login wall or 2FA). There is nothing to fix here — do not re-derive the recipe. ' +
            'Either run it attended with a handoff step (see the captcha_handoff generic action), or tell the user ' +
            'it needs them. Pass {"allowUnverified": true} to attempt it anyway.'
          : site.status === 'blocked-attn'
            ? `status="blocked-attn": troubleshooting this recipe is STALLED pending the user. Whoever set this ` +
              'concluded the next step cannot be determined without them — read `notes` above for what they need to ' +
              'supply or decide. Do NOT retry, re-derive, or iterate on it: that was already tried and is what ' +
              'produced this state. Surface it to the user and move on to other work.'
            : `Site is documented but status="${site.status}". Fall back to interactive tools, ` +
              'or pass {"allowUnverified": true} to run it anyway while iterating (see verify.js).',
    }, 1);
  }

  const fields = getFields(db, site.id);
  // Tag every run with the recipe definition that produced it, so a failure
  // can later be diffed against the last version that worked.
  const currentVersion = getCurrentVersion(db, site.id);
  const versionId = currentVersion ? currentVersion.id : null;
  const versionLabel = currentVersion ? `v${currentVersion.major}.${currentVersion.minor}` : null;
  // A recipe that sets ready_timeout_ms is SAYING this site is slow, and it was
  // being contradicted one line later: every page.goto had a hardcoded 30s cap,
  // so builtin.com could declare 60000 and still die at 30 seconds during
  // navigation — reported as "Navigation timeout of 30000 ms exceeded" with
  // failedStep null, which names neither the recipe nor a step and reads like
  // the site is down. There was no knob to raise, so the advice "raise the goto
  // timeout" could not be acted on at all.
  //
  // Derived rather than a new column: one timeout per recipe is one thing to get
  // right, and a second would mostly be forgotten. The floor means this can only
  // ever lengthen a navigation, never shorten one, so no existing recipe changes
  // behaviour.
  const navTimeoutMs = navTimeoutFor(site.ready_timeout_ms);
  const siteMeta = { hostname: site.hostname, pageType: site.page_type, recipeName: site.recipe_name, navTimeoutMs };

  // run_action references are expanded to a flat step list up front, before
  // any browser launches, so a dangling reference or a reference cycle
  // fails fast with a clear error instead of mid-run.
  let expandedSteps = null;
  if (site.nav_method === 'ui_steps') {
    try {
      expandedSteps = expandSteps(db, JSON.parse(site.nav_template), site.hostname, new Set([refKey(siteMeta)]));
    } catch (e) {
      emitAndExit(JSON.stringify({ success: false, documented: true, error: e.message }), 1);
    }
  }
  // pagination_method 'steps': pagination_config is a ui_steps array (usually
  // just a run_generic_action of 'paginate') run after the first page's cards
  // are ready, before the final extraction. Expanded up front like nav steps.
  let paginationSteps = null;
  if (site.page_type === 'listing' && site.pagination_method === 'steps' && site.pagination_config) {
    try {
      paginationSteps = expandSteps(db, JSON.parse(site.pagination_config), site.hostname, new Set([refKey(siteMeta)]));
    } catch (e) {
      emitAndExit(JSON.stringify({ success: false, documented: true, error: `pagination_config: ${e.message}` }), 1);
    }
  }
  // `attended` forces a visible window and gives the person time to clear
  // whatever is in the way, regardless of nav_method — a url_param recipe has
  // no steps to hang a handoff on, and a blocked-attn recipe may have no
  // handoff at all. It exists so the question "is a HUMAN alone enough here,
  // or is more automation work needed?" can be answered by a run rather than
  // by an agent's opinion. See verify.js --attended.
  const attended = Boolean(params.attended);
  const headed = attended || [expandedSteps, paginationSteps].some(st => st && stepsNeedHeaded(st));
  // Session persistence is ON BY DEFAULT (params.session picks which named,
  // parallel session — e.g. a second account — default 'default'); a run
  // opts out entirely with params.noSession: true.
  const sessionName = params.session || 'default';
  // session_mode:'none' is the RECIPE declaring it must run logged out
  // (its logged-in DOM differs, so a persisted session silently yields 0
  // results). Honoring it here means such a recipe is correct by
  // construction instead of depending on every caller remembering to pass
  // noSession — a footgun whose failure mode looks like "the site changed".
  const sessionDisabled = params.noSession || site.session_mode === 'none';
  const sessionOpt = sessionDisabled ? undefined : { hostname: site.hostname, sessionName };
  // Failure-diagnostics capture (screenshot/DOM/console/network) is ON BY
  // DEFAULT too; params.noDiagnostics: true skips it for one call.
  const debugOpt = params.noDiagnostics ? undefined : siteMeta;
  // Rolling screenshot window, so a failure shows the run's last few
  // seconds rather than only its final frame. Off by default on a HEADED
  // run: those are handoffs, where a person is already watching the screen,
  // the run can sit idle for ten minutes, and the frames would capture
  // whatever they're doing in that window. params.rollingFrames overrides
  // either way (0 disables).
  const rollingOpt = {
    frames: numericParam(params.rollingFrames, params, headed ? 0 : 6),
    intervalMs: numericParam(params.rollingIntervalMs, params, 2000),
  };

  if (site.page_type === 'article' || site.page_type === 'action') {
    let articleOutcome;
    try {
      articleOutcome = await withPage(async (page, diagnostics) => {
        let captures = [];
        let probeResults = [];
        if (site.nav_method === 'direct_url') {
          const url = substitute(site.nav_template, params);
          if (!url) throw new Error(`Missing param for nav_template "${site.nav_template}" (expected e.g. {"url": "..."})`);
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs });
        } else if (site.nav_method === 'ui_steps') {
          ({ captures, diagnostics: probeResults } = await runUiSteps(page, expandedSteps, params, siteMeta));
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

        let debugDir = null;
        if ((timedOut || blobLen === 0) && diagnostics) {
          debugDir = await captureFailureDiagnostics(page, siteMeta, { error: null, ...diagnostics });
        }

        return { timedOut, record, blobLen, url: page.url(), captures, probeResults, debugDir };
      }, { headed, session: sessionOpt, debugMeta: debugOpt, rolling: rollingOpt });
    } catch (e) {
      logRun(db, { siteId: site.id, params, success: false, error: e.message, durationMs: Date.now() - startedAt, versionId, versionLabel });
      emitAndExit(JSON.stringify({ success: false, documented: true, error: `Engine threw: ${e.message}`, failedStep: e.failedStep ?? null, debugDir: e.debugDir ?? null }), 1);
    }

    const success = !articleOutcome.timedOut && articleOutcome.blobLen > 0;
    // Same just-past-the-deadline case as the listing flow below.
    const partialResults = isPartial(articleOutcome.timedOut, articleOutcome.blobLen);

    const output = {
      success,
      documented: true,
      timedOut: articleOutcome.timedOut,
      url: articleOutcome.url,
      ...(!success && site.nav_method !== 'ui_steps'
        ? { failureContext: navFailureContext(site, { phase: 'waiting for content' }) }
        : {}),
      ...(partialResults
        ? {
            partialResults: true,
            partialNote:
              'The wait deadline passed, but content was still extracted and is present in "article". ' +
              'It is usable; it may also be truncated. Consider raising ready_timeout_ms.',
          }
        : {}),
      article: articleOutcome.record,
      // file path + captured KEY NAMES only — never the captured values.
      handoffCaptures: articleOutcome.captures,
      // Only present when the recipe actually ran probe steps.
      diagnostics: articleOutcome.probeResults?.length ? articleOutcome.probeResults : undefined,
      sessionUsed: sessionOpt ? sessionName : null,
      recipeVersion: versionLabel,
      debugDir: articleOutcome.debugDir ?? null,
    };
    const outputJson = JSON.stringify(output);

    logRun(db, {
      siteId: site.id,
      params,
      success,
      resultCount: success ? 1 : 0,
      timedOut: articleOutcome.timedOut,
      durationMs: Date.now() - startedAt,
      versionId, versionLabel,
      outputChars: outputJson.length,
    });

    emitAndExit(outputJson, success ? 0 : 1);
  }

  let outcome;

  try {
    outcome = await withPage(async (page, diagnostics) => {
      const extractOpts = {
        cardAnchorText: site.card_anchor_text,
        cardSelector: site.card_selector,
        cardMinTextLen: site.card_min_text_len,
        fields,
        includeRaw,
      };
      const waitForCards = timeout =>
        page.waitForFunction(
          (anchorText, cardSelector) =>
            cardSelector
              ? !!document.querySelector(cardSelector)
              : Array.from(document.querySelectorAll('a, button')).some(el => el.textContent.trim() === anchorText),
          { timeout },
          site.card_anchor_text,
          site.card_selector
        );

      // Pages saved by `collect` steps (e.g. inside the 'paginate' generic
      // action) before moving on; merged with the final page below.
      const collected = [];
      let pagesCollected = 0;
      const hooks = {
        collect: async () => {
          try {
            await waitForCards(site.ready_timeout_ms);
          } catch {
            /* extract whatever is there */
          }
          collected.push(...(await extractCards(page, extractOpts)));
          pagesCollected += 1;
        },
      };

      let captures = [];
      let probeResults = [];
      if (site.nav_method === 'url_param') {
        const url = buildUrl(site.nav_template, params);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs });
      } else if (site.nav_method === 'ui_steps') {
        ({ captures, diagnostics: probeResults } = await runUiSteps(page, expandedSteps, params, siteMeta, hooks));
      } else {
        throw new Error(`Unknown nav_method: ${site.nav_method}`);
      }

      let timedOut = false;
      try {
        // An attended run waits much longer, because it is waiting on a
        // PERSON clearing a wall rather than on a page rendering. It still
        // resolves the instant the cards appear, so solving the challenge
        // continues the run immediately instead of burning the whole window.
        await waitForCards(attended ? numericParam(params.attendedTimeoutMs, params, 240000) : site.ready_timeout_ms);
      } catch {
        timedOut = true;
      }

      if (paginationSteps && !timedOut) {
        const more = await runUiSteps(page, paginationSteps, params, siteMeta, hooks);
        captures = captures.concat(more.captures);
        probeResults = probeResults.concat(more.diagnostics);
      }

      // Final page, then de-duplicate across pages (by href when the recipe
      // has one, else the whole record) — "load more" pages keep earlier
      // cards in the DOM, so the same card can be collected more than once.
      const finalPage = await extractCards(page, extractOpts);
      const seen = new Set();
      const jobs = [];
      for (const rec of collected.concat(finalPage)) {
        const { _raw, ...rest } = rec;
        const key = rec.href || JSON.stringify(rest);
        if (seen.has(key)) continue;
        seen.add(key);
        jobs.push(rec);
      }

      let claimedCount = null;
      if (site.result_count_regex) {
        claimedCount = await page.evaluate(pattern => {
          const m = document.body.innerText.match(new RegExp(pattern));
          return m ? m[1] : null;
        }, site.result_count_regex);
      }

      let debugDir = null;
      if ((timedOut || jobs.length === 0) && diagnostics) {
        debugDir = await captureFailureDiagnostics(page, siteMeta, { error: null, ...diagnostics });
      }

      return { timedOut, jobs, claimedCount, url: page.url(), captures, probeResults, pagesVisited: pagesCollected + 1, debugDir };
    }, { headed, session: sessionOpt, debugMeta: debugOpt, rolling: rollingOpt });
  } catch (e) {
    logRun(db, { siteId: site.id, params, success: false, error: e.message, durationMs: Date.now() - startedAt, versionId, versionLabel });
    emitAndExit(JSON.stringify({ success: false, documented: true, error: `Engine threw: ${e.message}`, failedStep: e.failedStep ?? null, debugDir: e.debugDir ?? null }), 1);
  }

  const success = !outcome.timedOut && outcome.jobs.length > 0;

  // A timed-out run can still have extracted everything: extraction runs
  // unconditionally after the wait, so content that finished rendering just
  // past the deadline is present and correct in `jobs` while `success` is
  // false. A caller following the documented "check the success field" rule
  // would throw that away — observed on a Workday tenant returning a
  // complete, correct 20-job array with timedOut:true.
  //
  // `success` is deliberately NOT redefined to jobs.length > 0: a wait that
  // expired early may have caught 3 of 100 cards, and silently calling that
  // a success is the worse error. This flags the case explicitly instead and
  // leaves the judgement to the caller, who can see `count`.
  const partialResults = isPartial(outcome.timedOut, outcome.jobs.length);

  // Self-consistency check: if the site tells us its own result count and it
  // wildly disagrees with what we scraped, don't just trust jobs.length > 0.
  let consistencyWarning = null;
  if (outcome.claimedCount !== null) {
    const claimed = parseInt(String(outcome.claimedCount).replace(/,/g, ''), 10);
    if (!Number.isNaN(claimed) && claimed === 0 && outcome.jobs.length > 0) {
      consistencyWarning = `Site claims ${claimed} results but we extracted ${outcome.jobs.length} cards — likely stale/cached DOM.`;
    }
  }

  const output = {
    success,
    documented: true,
    timedOut: outcome.timedOut,
    ...(!success && site.nav_method !== 'ui_steps'
      ? { failureContext: navFailureContext(site, { phase: 'waiting for cards' }) }
      : {}),
    ...(partialResults
      ? {
          partialResults: true,
          partialNote:
            `The wait deadline passed, but ${outcome.jobs.length} records were still extracted and are present in "records". ` +
            'They are usable; they may also be incomplete. Check count before discarding them, and consider raising ready_timeout_ms.',
        }
      : {}),
    url: outcome.url,
    claimedCount: outcome.claimedCount,
    consistencyWarning,
    count: outcome.jobs.length,
    pagesVisited: outcome.pagesVisited,
    // `records`, not `jobs`: the engine is generic, so naming its output after
    // job boards meant a product catalogue came back under `jobs` too.
    //
    // Renamed outright rather than dual-emitted through a deprecation window,
    // which is what TODO 2 originally planned. Two findings killed the window.
    // Nothing outside this repo reads the key — the script the TODO named as
    // the external consumer (../scripts/dedupe_import_jobs.py) parses
    // job-apply's markdown and has never read engine output. And emitting both
    // serialises the whole array twice: test/efficiency.test.js failed with
    // structured output at 1961 chars against a 1423-char raw fixture page,
    // i.e. the transitional state broke the size guarantee this engine exists
    // to provide. A deprecation alias nobody needs is not worth that.
    //
    // lib/outputShape.js still reads a legacy `jobs` key, so an OLD saved run
    // JSON stays readable; nothing emits one any more.
    records: outcome.jobs,
    handoffCaptures: outcome.captures,
    diagnostics: outcome.probeResults?.length ? outcome.probeResults : undefined,
    sessionUsed: sessionOpt ? sessionName : null,
    recipeVersion: versionLabel,
    debugDir: outcome.debugDir ?? null,
  };
  const outputJson = JSON.stringify(output);

  logRun(db, {
    siteId: site.id,
    params,
    success,
    resultCount: outcome.jobs.length,
    claimedCount: outcome.claimedCount,
    timedOut: outcome.timedOut,
    durationMs: Date.now() - startedAt,
    versionId, versionLabel,
    outputChars: outputJson.length,
  });

  emitAndExit(outputJson, success ? 0 : 1);
}

// Only run when invoked as a CLI. Requiring this file used to execute the
// whole thing, which meant the internals below could never be unit-tested —
// including the concurrency guard, whose entire job is to fire in a
// situation the CLI can't produce on its own.
if (require.main === module) main();

module.exports = { runUiSteps, progress, describeStep, isPartial, navTimeoutFor, DEFAULT_NAV_TIMEOUT_MS };
