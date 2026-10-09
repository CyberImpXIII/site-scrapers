// The `submit_form` step: PLAN-applications.md §3.5, the ONE place in this repo
// meant to click an application's submit control. Contract: lib/submitContract.js,
// docs/submit-output.md.
//
// It refuses by default. Every gate below runs before the click, in order, and
// any gate that cannot decide refuses:
//   1. approval: present, well formed, unexpired (<= 24h), names this packet,
//      and binds exactly this submission (lib/submitContract.js checkApproval);
//   2. the ledger: this (batch, packet) was never clicked before (lib/submitLedger.js);
//   3. LIVE DISARM: the page's host is loopback or listed in LIVE_SUBMIT_HOSTS,
//      which is EMPTY. Arming a real host is a reviewed code change by Jacob,
//      and test/submit.test.js fails until that test is changed with it;
//   4. the page is at the approved URL;
//   5. no wall (a probe that cannot run is not "clear");
//   6. the live form is the described one (formHash), BEFORE anything is filled;
//   7. the fill: done, every answer landed, nothing required open, no unknown
//      key, no navigation, wall check clear;
//   8. the form is still the described one AFTER the fill;
//   9. exactly one form holds the described fields, and it owns exactly one
//      visible, enabled submit control;
//  10. neither the confirmation nor the error signal is already on the page.
// Then the ledger is claimed, ONE DOM click, and what the page then shows is
// classified -- wall, error, confirmation, or unknown. Never the HTTP status,
// never the exit code. Never retried: `unknown` goes to a person.

const { fillForm, checkWall } = require('./fillForm');
const { probeForms } = require('./probes');
const { formHash } = require('./formHash');
const { CONTRACT, submissionHash, checkApproval } = require('./submitContract');
const ledger = require('./submitLedger');

// Hosts a submit may click on besides loopback. EMPTY on purpose (PLAN §12.2
// step 3: nothing may submit a real application yet). test/submit.test.js
// asserts it is empty; adding a host is Jacob's decision and changes both.
const LIVE_SUBMIT_HOSTS = Object.freeze([]);
const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', 'localhost', '[::1]']);

const LIVE_FIELD_CAP = 400;
const DEFAULT_OUTCOME_TIMEOUT_MS = 20000;
const POLL_MS = 250;

function isSubmitHostArmed(hostname) {
  return typeof hostname === 'string' && (LOOPBACK_HOSTS.includes(hostname) || LIVE_SUBMIT_HOSTS.includes(hostname));
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

// origin + path only: a query string can carry anything.
function bareUrl(url) {
  try {
    const u = new URL(url);
    return u.origin === 'null' ? `${u.protocol}` : `${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
}

function sameUrl(a, b) {
  try {
    const x = new URL(a);
    const y = new URL(b);
    x.hash = '';
    y.hash = '';
    return x.href === y.href;
  } catch {
    return false;
  }
}

function emptyResult() {
  return {
    kind: 'submit',
    contract: CONTRACT,
    status: 'refused',
    reason: 'no_approval',
    error: null,
    clicked: false,
    submitClicks: 0,
    packetId: null,
    batchId: null,
    submissionHash: null,
    descriptionHash: null,
    formHash: null,
    formChanged: null,
    pageHost: null,
    fill: null,
    wall: null,
    observed: null,
    finalUrl: null,
  };
}

// The described selectors a person fills: what locates "the form".
function describedSelectors(fields) {
  return fields.filter(f => f && typeof f.selector === 'string' && !f.ariaHidden).map(f => f.selector);
}

// In the page: the one form holding the described fields, and its one
// visible, enabled submit control (form.elements includes a form= control
// outside the <form>). Returns { error } or { handle-bearing JSHandle }.
async function findSubmitControl(page, selectors) {
  const handle = await page.evaluateHandle(sels => {
    const forms = new Set();
    for (const s of sels) {
      let el = null;
      try {
        el = document.querySelector(s);
      } catch {
        el = null;
      }
      const f = el && (el.form || el.closest('form'));
      if (f) forms.add(f);
    }
    if (forms.size === 0) return { error: 'form_not_found' };
    if (forms.size > 1) return { error: 'form_not_unique' };
    const form = [...forms][0];
    const isSubmit = n => {
      const tag = n.tagName.toLowerCase();
      const type = (n.getAttribute('type') || '').toLowerCase();
      if (tag === 'input') return type === 'submit' || type === 'image';
      if (tag === 'button') return type === 'submit' || !type;
      return false;
    };
    const visible = n => (typeof n.checkVisibility === 'function' ? n.checkVisibility({ visibilityProperty: true }) : n.offsetParent !== null);
    const live = Array.from(form.elements).filter(n => isSubmit(n) && visible(n) && !n.disabled && n.getAttribute('aria-disabled') !== 'true');
    if (live.length === 0) return { error: 'no_submit_control' };
    if (live.length > 1) return { error: 'submit_control_not_unique' };
    return { control: live[0] };
  }, selectors);
  const props = await handle.getProperties();
  const err = props.get('error');
  if (err) {
    const error = await err.jsonValue();
    await handle.dispose();
    return { error };
  }
  const control = props.get('control').asElement();
  await handle.dispose();
  return { control };
}

// What the page shows now. Text match is case- and whitespace-insensitive.
async function readSignals(page, signals, selectors) {
  return page.evaluate(
    (sig, sels) => {
      const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const text = norm(document.body ? document.body.innerText : '');
      const visible = n => (typeof n.checkVisibility === 'function' ? n.checkVisibility({ visibilityProperty: true }) : n.offsetParent !== null);
      let errorSel = false;
      if (sig.errorSelector) {
        try {
          errorSel = Array.from(document.querySelectorAll(sig.errorSelector)).some(visible);
        } catch {
          errorSel = false;
        }
      }
      const confirmation =
        (sig.confirmText ? text.includes(norm(sig.confirmText)) : false) ||
        (sig.confirmUrlIncludes ? location.href.includes(sig.confirmUrlIncludes) : false);
      const error = errorSel || (sig.errorText ? text.includes(norm(sig.errorText)) : false);
      const formPresent = sels.some(s => {
        try {
          return !!document.querySelector(s);
        } catch {
          return false;
        }
      });
      return { confirmation, error, formPresent, url: location.href };
    },
    signals,
    selectors
  );
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// After the click: wait for a confirmation or an error to appear (a navigation
// destroys the context mid-read; that read is simply retried), then settle and
// read once more, so a page that shows a confirmation and then an error is
// read as what it ends on.
async function observe(page, signals, selectors, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await readSignals(page, signals, selectors);
      if (last.confirmation || last.error) break;
    } catch {
      /* navigating: read again */
    }
    await sleep(POLL_MS);
  }
  await sleep(500);
  try {
    last = await readSignals(page, signals, selectors);
  } catch {
    /* keep the last good read, or null */
  }
  return last;
}

// The fill result is accepted for submitting only if everything approved
// landed and nothing is open. Returns null (accepted) or a reason.
function fillVerdict(fill, answers) {
  if (fill.status === 'blocked-attn') return { status: 'blocked-attn', reason: 'wall_during_fill' };
  if (fill.navigatedDuringFill) return { status: 'needs-review', reason: 'navigated_during_fill' };
  if (fill.formChanged !== false) return { status: 'needs-review', reason: 'form_changed' };
  if (fill.wallCheck !== 'clear') return { status: 'needs-review', reason: 'wall_unknown' };
  if (fill.status !== 'done') return { status: 'needs-review', reason: 'fill_incomplete' };
  const answered = new Set(Object.entries(answers).filter(([, v]) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)).map(([k]) => k));
  const notLanded = fill.fields.filter(f => answered.has(f.selector) && f.outcome !== 'filled');
  if (
    fill.counts.failed > 0 ||
    notLanded.length ||
    fill.requiredNotFilled.length ||
    fill.requiredGroupsNotFilled.length ||
    fill.unknownAnswerKeys.length ||
    fill.undescribedFields.length
  ) {
    return { status: 'needs-review', reason: 'fill_incomplete' };
  }
  return null;
}

async function submitForm(page, { url, fields, answers, packetId, approval, signals = {}, outcomeTimeoutMs }) {
  const r = emptyResult();
  const done = (status, reason, error = null) => Object.assign(r, { status, reason, error });
  r.packetId = typeof packetId === 'string' ? packetId : null;
  if (approval && typeof approval === 'object' && typeof approval.batchId === 'string' && /^b-[0-9a-f]{16}$/.test(approval.batchId)) r.batchId = approval.batchId;
  if (fields && !Array.isArray(fields) && Array.isArray(fields.fields)) fields = fields.fields;

  try {
    // 1. The approval, and the submission it binds. No approval is checked
    // before anything else, so the default is a refusal whatever else is wrong.
    if (approval === undefined || approval === null || approval === '') return done('refused', 'no_approval', 'no approval was passed: nothing is submitted without one');
    const h = submissionHash({ url, fields, answers });
    if (h.error) {
      const pre = checkApproval(approval, { packetId, computedHash: null });
      if (!pre.ok && pre.reason !== 'packet_changed') return done(pre.status, pre.reason, pre.error);
      return done('refused', 'bad_params', h.error);
    }
    r.submissionHash = h.hash;
    r.descriptionHash = h.descriptionHash;
    const a = checkApproval(approval, { packetId, computedHash: h.hash });
    if (!a.ok) return done(a.status, a.reason, a.error);
    const confirmText = typeof signals.confirmText === 'string' ? signals.confirmText.trim() : '';
    const confirmUrlIncludes = typeof signals.confirmUrlIncludes === 'string' ? signals.confirmUrlIncludes.trim() : '';
    if (!confirmText && !confirmUrlIncludes) {
      return done('refused', 'bad_params', 'the recipe gives no confirmation signal (confirm_text / confirm_url_includes): an outcome could not be read');
    }
    const sig = {
      confirmText,
      confirmUrlIncludes,
      errorSelector: typeof signals.errorSelector === 'string' ? signals.errorSelector.trim() : '',
      errorText: typeof signals.errorText === 'string' ? signals.errorText.trim() : '',
    };

    // 2. Never twice.
    const seen = ledger.attempted(approval.batchId, packetId);
    if (seen === null) return done('refused', 'ledger_unavailable', 'the submit ledger cannot be read, so a second click cannot be ruled out');
    if (seen) return done('refused', 'already_attempted', `packet ${packetId} was already submitted once under batch ${approval.batchId}: a resend needs a new batch`);

    // 3. Live disarm.
    r.pageHost = hostOf(page.url());
    if (!isSubmitHostArmed(r.pageHost)) {
      return done('refused', 'live_submit_disarmed', `submitting on ${r.pageHost || 'this page'} is not armed: LIVE_SUBMIT_HOSTS in lib/submitForm.js is Jacob's decision`);
    }

    // 4. The approved URL.
    if (!sameUrl(page.url(), url)) return done('needs-review', 'url_changed', 'the page is not at the approved URL (a redirect?)');

    // 5. A wall, before anything is touched.
    const wall = await checkWall(page);
    if (wall.state === 'wall') {
      r.wall = { phase: 'before', signals: wall.signals, advice: wall.advice };
      return done('blocked-attn', 'wall_before_fill');
    }
    if (wall.state !== 'clear') return done('needs-review', 'wall_unknown', 'the wall probes could not run: not proof of no wall');

    // 6. The form as approved, before filling.
    const live = await probeForms(page, LIVE_FIELD_CAP);
    if (live.error || typeof live.formHash !== 'string') return done('needs-review', 'form_not_found', 'the live form could not be read');
    r.formHash = live.formHash;
    r.formChanged = live.formHash !== h.descriptionHash;
    if (r.formChanged) return done('needs-review', 'form_changed', 'the live form is not the one described and approved');

    // 7. Fill.
    r.fill = await fillForm(page, { fields, answers });
    const fv = fillVerdict(r.fill, answers);
    if (fv) {
      if (fv.status === 'blocked-attn') r.wall = { phase: r.fill.wall?.phase || 'after', signals: r.fill.wall?.signals || ['unknown_wall'], advice: r.fill.wall?.advice || null };
      return done(fv.status, fv.reason);
    }

    // 8. Still the same form after filling (a conditional question appearing
    // is a question nobody approved an answer to).
    const after = await probeForms(page, LIVE_FIELD_CAP);
    if (after.error || after.formHash !== h.descriptionHash) {
      return done('needs-review', 'form_changed_during_fill', 'the form changed while it was filled');
    }
    if (!isSubmitHostArmed(hostOf(page.url())) || !sameUrl(page.url(), url)) return done('needs-review', 'url_changed', 'the page moved during the fill');

    // 9. The one control.
    const selectors = describedSelectors(fields);
    const found = await findSubmitControl(page, selectors);
    if (found.error) return done('needs-review', found.error);

    // 10. A baseline: a signal already showing would make the outcome unreadable.
    const before = await readSignals(page, sig, selectors);
    if (before.confirmation || before.error) {
      await found.control.dispose();
      return done('needs-review', 'signals_present_before_submit', 'a confirmation or error signal is on the form page before submitting');
    }

    // The claim, then the click. Nothing between them can refuse.
    const c = ledger.claim(approval.batchId, packetId, h.hash);
    if (!c.ok) {
      await found.control.dispose();
      return done('refused', c.reason);
    }
    let dialogs = 0;
    const onDialog = d => {
      dialogs += 1;
      d.dismiss().catch(() => {});
    };
    page.on('dialog', onDialog);
    try {
      r.clicked = true;
      r.submitClicks = 1;
      await found.control.evaluate(e => e.click());
      found.control.dispose().catch(() => {});

      const timeout = Number.isFinite(Number(outcomeTimeoutMs)) && Number(outcomeTimeoutMs) > 0 ? Math.min(Number(outcomeTimeoutMs), 120000) : DEFAULT_OUTCOME_TIMEOUT_MS;
      const seenAfter = await observe(page, sig, selectors, timeout);
      r.finalUrl = bareUrl(page.url());
      if (!seenAfter) {
        done('unknown', 'observation_error', 'the page could not be read after the click: check by hand whether it was sent');
      } else {
        r.observed = { confirmation: seenAfter.confirmation, error: seenAfter.error, formPresent: seenAfter.formPresent, dialogs };
        const wallAfter = await checkWall(page).catch(() => ({ state: 'unknown', signals: [] }));
        if (wallAfter.state === 'wall') {
          r.wall = { phase: 'after_submit', signals: wallAfter.signals, advice: wallAfter.advice };
          done('blocked-attn', 'wall_after_submit');
        } else if (seenAfter.confirmation && seenAfter.error) done('unknown', 'signals_conflict');
        else if (seenAfter.error) done('failed', 'error_page');
        else if (seenAfter.confirmation && seenAfter.formPresent) done('unknown', 'form_still_present');
        else if (seenAfter.confirmation) done('submitted', 'confirmation_seen');
        else done('unknown', 'no_signal');
      }
    } finally {
      page.off('dialog', onDialog);
    }
    ledger.record(approval.batchId, packetId, r.status, r.reason);
    return r;
  } catch (e) {
    // After the click nothing is an `error`: the application may have gone.
    if (r.clicked) {
      r.wall = null;
      done('unknown', 'observation_error', `after the click: ${String(e.message).slice(0, 160)} -- check by hand whether it was sent`);
      if (r.batchId && r.packetId) ledger.record(r.batchId, r.packetId, r.status, r.reason);
      return r;
    }
    r.wall = null;
    r.observed = null;
    return done('error', 'internal_error', String(e.message).slice(0, 200));
  }
}

// Structural rule, checked by engine.js before any browser launches: a
// submit_form step appears only in an `action` recipe's own steps, at most
// once, never inside a repeat, and as the LAST step (nothing after it can
// throw away its result). Returns an error string or null.
function submitStepProblem(steps, { pageType, where = 'steps' } = {}) {
  const top = Array.isArray(steps) ? steps : [];
  const nested = [];
  const walk = (list, inRepeat) => {
    for (const s of Array.isArray(list) ? list : []) {
      if (s && s.action === 'submit_form' && inRepeat) nested.push(s);
      if (s && Array.isArray(s.steps)) walk(s.steps, true);
    }
  };
  walk(top, false);
  const count = top.filter(s => s && s.action === 'submit_form').length + nested.length;
  if (!count) return null;
  if (where !== 'steps') return `submit_form is not allowed in ${where}`;
  if (pageType !== 'action') return 'submit_form runs only in an action recipe';
  if (nested.length) return 'submit_form may not run inside a repeat';
  if (count > 1) return `submit_form appears ${count} times: one recipe run submits at most once`;
  if (top[top.length - 1].action !== 'submit_form') return 'submit_form must be the last step';
  return null;
}

// Does this (expanded) step list contain a submit? One definition, in
// lib/submitGuard.js, shared with the unattended tools that refuse it.
const { stepsSubmit } = require('./submitGuard');

module.exports = {
  submitForm,
  submitStepProblem,
  stepsSubmit,
  isSubmitHostArmed,
  fillVerdict,
  LIVE_SUBMIT_HOSTS,
  LOOPBACK_HOSTS,
};
