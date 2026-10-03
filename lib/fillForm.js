// The `fill_form` step: a DRY FILL of an application form.
//
// Takes the field list `describe_application_form` returned (the `forms`
// probe's `fields`) and an answer map keyed by each field's `selector`, fills
// what it can, and returns one outcome per described field -- filled, failed
// with a reason, or unfilled with a reason. The output contract is
// lib/fillContract.js, documented for the applications repo in
// docs/fill-output.md.
//
// THE ONE PROPERTY THAT MATTERS: this never submits. Jacob's rule is
// prepare-then-confirm (CLAUDE.md, absolute constraints); submitting is a
// separate, consented step that does not exist yet. So, structurally:
//   - no Enter key is ever pressed, anywhere in this file;
//   - text is typed one character at a time, each only after checking the
//     field still has focus -- a stray Space on a focused submit button IS a
//     click, and a widget that steals focus mid-typing would otherwise aim the
//     rest of the answer at whatever it focused;
//   - textareas are set through the native value setter, never the keyboard,
//     because their answers legitimately contain newlines (= Enter);
//   - a newline in a single-line input FAILS the field instead of being typed,
//     because Enter in a text input is implicit form submission;
//   - every click goes through safeClick(), which refuses a submit control
//     (and anything inside one) and is the only click in this file.
// test/fill.test.js counts submit clicks on the fixture form and requires zero.
//
// A wall (login, CAPTCHA, bot check) stops it before anything is touched and
// reports blocked-attn. Nothing here tries to get past one.

const fs = require('fs');
const path = require('path');
const { runProbe, probeForms } = require('./probes');
const { formHash } = require('./formHash');
const { CONTRACT } = require('./fillContract');

// Generous: a field past this cap would be undescribed, and an undescribed
// field is reported, never silently ignored.
const LIVE_FIELD_CAP = 300;
const OPTION_WAIT_MS = 4000;
const MAX_LISTED = 50;

const TEXT_TYPES = new Set(['text', 'email', 'tel', 'url', 'search', 'number']);
// Typed character-by-character these mis-parse (a date input takes keys per
// segment, in a locale order), so they are set through the native setter.
const SETTER_TYPES = new Set(['date', 'month', 'week', 'time', 'datetime-local']);
const SUBMIT_TYPES = new Set(['submit', 'image', 'reset', 'button']);

class FieldFailure extends Error {
  constructor(reason, detail = null) {
    super(reason);
    this.reason = reason;
    this.detail = detail;
  }
}

const norm = s =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

function truncate(s, n = 200) {
  if (s === null || s === undefined) return null;
  const str = String(s);
  return str.length > n ? `${str.slice(0, n)}...` : str;
}

// --- walls -----------------------------------------------------------------

// Returns { state: 'clear'|'wall'|'unknown', signals, advice }. Built on the
// same probes autoDiagnose and verify.js use, so "wall" means the same thing
// here as everywhere else in this repo.
async function checkWall(page) {
  const [antibot, blockers] = await Promise.all([
    runProbe(page, { kind: 'antibot' }),
    runProbe(page, { kind: 'blockers' }),
  ]);
  const signals = [];
  if (antibot && !antibot.error && antibot.blocking) {
    signals.push(...(antibot.detected?.length ? antibot.detected.map(s => `antibot:${s}`) : ['antibot']));
  }
  if (blockers && !blockers.error) {
    for (const f of ['captcha', 'botCheck', 'loginWall']) if ((blockers.flags || []).includes(f)) signals.push(f);
  }
  if (signals.length) {
    return {
      state: 'wall',
      signals,
      advice:
        'A login, CAPTCHA or bot wall is on the page. Nothing was (further) filled and nothing was attempted against it. ' +
        'This needs Jacob: an attended run, or his decision about an account. Do not retry unattended.',
    };
  }
  // A probe that could not run is not evidence of no wall. Reported, not
  // promoted to a block, because the probes time out on heavy pages.
  const unknown = Boolean(antibot?.error || blockers?.error);
  return { state: unknown ? 'unknown' : 'clear', signals: [], advice: null };
}

// --- element inspection ----------------------------------------------------

async function inspect(el) {
  return el.evaluate(e => {
    const tag = e.tagName.toLowerCase();
    const type = (e.getAttribute('type') || (tag === 'input' ? 'text' : '')).toLowerCase();
    const visible =
      typeof e.checkVisibility === 'function'
        ? e.checkVisibility({ visibilityProperty: true })
        : e.offsetParent !== null || getComputedStyle(e).position === 'fixed';
    const labelVisible = Array.from(e.labels || []).some(l =>
      typeof l.checkVisibility === 'function' ? l.checkVisibility({ visibilityProperty: true }) : l.offsetParent !== null
    );
    return {
      tag,
      type,
      role: e.getAttribute('role'),
      ariaHidden: e.getAttribute('aria-hidden') === 'true',
      disabled: !!(e.disabled || e.readOnly || e.getAttribute('aria-disabled') === 'true'),
      maxLength: typeof e.maxLength === 'number' && e.maxLength > 0 ? e.maxLength : null,
      multiple: !!e.multiple,
      visible,
      labelVisible,
      checked: !!e.checked,
    };
  });
}

function classify(info) {
  if (info.tag === 'textarea') return 'textarea';
  if (info.tag === 'select') return 'select';
  if (info.tag !== 'input') return 'other';
  if (SUBMIT_TYPES.has(info.type)) return 'submit';
  if (info.type === 'file') return 'file';
  if (info.type === 'checkbox') return 'checkbox';
  if (info.type === 'radio') return 'radio';
  if (info.role === 'combobox') return 'combobox';
  if (TEXT_TYPES.has(info.type) || SETTER_TYPES.has(info.type)) return 'text';
  return 'other';
}

// --- the guarded interactions ----------------------------------------------

// The ONLY click in this file. Refuses a submit control and anything inside
// one: <input type=submit|image>, <button type=submit>, and a <button> with no
// type inside a form (which the browser treats as submit).
async function safeClick(el) {
  const submitish = await el.evaluate(e => {
    const isSubmit = n => {
      if (!n || n.nodeType !== 1) return false;
      const tag = n.tagName.toLowerCase();
      const type = (n.getAttribute('type') || '').toLowerCase();
      if (tag === 'input') return type === 'submit' || type === 'image';
      if (tag === 'button') return type === 'submit' || (!type && !!n.form);
      return false;
    };
    for (let n = e; n; n = n.parentElement) if (isSubmit(n)) return true;
    return false;
  });
  if (submitish) throw new FieldFailure('submit_control', 'refused to click a submit control');
  // A DOM click: no pointer travel across the page, so nothing else on the
  // way gets hovered, focused or clicked.
  await el.evaluate(e => e.click());
}

// Set a value through the prototype's native setter, then announce it the way
// a person typing would. The prototype setter is what React's value tracker
// watches; assigning `e.value` directly is swallowed by a controlled input.
async function nativeSet(el, value) {
  await el.evaluate((e, v) => {
    const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : e.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(e, v);
    e.dispatchEvent(new Event('input', { bubbles: true }));
    e.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function hasFocus(el) {
  return el.evaluate(e => document.activeElement === e);
}

// Character-by-character, re-checking focus before each one. See the header:
// a key aimed at the wrong element is how a dry fill becomes a submission.
async function safeType(page, el, text) {
  if (/[\r\n]/.test(text)) throw new FieldFailure('multiline_in_single_line', 'the answer contains a newline; typed into a single-line field that is Enter, which submits the form');
  await el.evaluate(e => e.focus());
  for (const ch of text) {
    if (!(await hasFocus(el))) throw new FieldFailure('value_did_not_stick', 'the field lost focus while typing; stopped rather than type into whatever took it');
    await page.keyboard.type(ch);
  }
}

async function blur(el) {
  await el.evaluate(e => e.blur()).catch(() => {});
}

// --- per-control fillers ----------------------------------------------------
// Each throws FieldFailure, or returns a detail string (or null) on success.
// No detail ever contains the answer: the output is read back into a
// transcript and stored by the applications repo.

function asText(answer) {
  if (typeof answer === 'number' && Number.isFinite(answer)) return String(answer);
  if (typeof answer === 'string') return answer;
  throw new FieldFailure('answer_type_mismatch', `expected text, got ${Array.isArray(answer) ? 'array' : typeof answer}`);
}

async function fillText(page, el, info, answer) {
  const text = asText(answer);
  if (info.maxLength !== null && text.length > info.maxLength) {
    throw new FieldFailure('exceeds_maxlength', `answer is ${text.length} chars, field allows ${info.maxLength}`);
  }
  if (SETTER_TYPES.has(info.type)) {
    await nativeSet(el, text);
  } else {
    if (/[\r\n]/.test(text)) throw new FieldFailure('multiline_in_single_line', 'the answer contains a newline; typed into a single-line field that is Enter, which submits the form');
    await nativeSet(el, '');
    await safeType(page, el, text);
  }
  await blur(el);
  const got = await el.evaluate(e => e.value);
  // A phone widget (intl-tel-input on Greenhouse) reformats as you type, so a
  // tel field is compared on its digits.
  const same = info.type === 'tel' ? got.replace(/\D/g, '') === text.replace(/\D/g, '') : got === text;
  if (!same) throw new FieldFailure('value_did_not_stick', `read back ${got.length} chars after filling ${text.length}`);
  return null;
}

async function fillTextarea(el, info, answer) {
  const text = asText(answer);
  if (info.maxLength !== null && text.length > info.maxLength) {
    throw new FieldFailure('exceeds_maxlength', `answer is ${text.length} chars, field allows ${info.maxLength}`);
  }
  await nativeSet(el, text);
  await blur(el);
  const got = await el.evaluate(e => e.value);
  if (got.replace(/\r\n/g, '\n') !== text.replace(/\r\n/g, '\n')) {
    throw new FieldFailure('value_did_not_stick', `read back ${got.length} chars after filling ${text.length}`);
  }
  return null;
}

async function fillSelect(el, info, answer) {
  if (info.multiple) throw new FieldFailure('unsupported_control', 'multi-select <select> is not supported yet');
  const text = asText(answer);
  const pick = await el.evaluate(
    (e, want) => {
      const n = s => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
      const opts = Array.from(e.options).filter(o => !o.disabled);
      const byValue = opts.filter(o => o.value !== '' && o.value === want);
      const matches = byValue.length ? byValue : opts.filter(o => n(o.textContent) === n(want) && n(want) !== '');
      return { count: matches.length, total: opts.length, value: matches.length === 1 ? matches[0].value : null };
    },
    text
  );
  if (pick.count === 0) throw new FieldFailure('no_matching_option', `none of ${pick.total} options matches exactly`);
  if (pick.count > 1) throw new FieldFailure('ambiguous_option', `${pick.count} options match`);
  await nativeSet(el, pick.value);
  const ok = await el.evaluate((e, v) => e.value === v, pick.value);
  if (!ok) throw new FieldFailure('value_did_not_stick', 'the selection did not hold');
  return null;
}

// The open option list for a combobox: the element its aria-controls (or
// aria-owns) names. NOT a page-wide [role=listbox] -- on Greenhouse the phone
// field's country picker is also a listbox, and picking from it would answer
// the wrong question.
async function comboOptions(el) {
  return el.evaluate(e => {
    const id = e.getAttribute('aria-controls') || e.getAttribute('aria-owns');
    const lb = id ? document.getElementById(id) : null;
    if (!lb) return null;
    return Array.from(lb.querySelectorAll('[role="option"]')).map(o => ({
      id: o.id || null,
      text: (o.textContent || '').replace(/\s+/g, ' ').trim(),
      disabled: o.getAttribute('aria-disabled') === 'true',
    }));
  });
}

async function fillCombobox(page, el, answer) {
  const text = asText(answer);
  const want = norm(text);
  if (!want) throw new FieldFailure('answer_type_mismatch', 'empty option text');
  const before = await shownValues(el);
  await nativeSet(el, '');
  await safeType(page, el, text);
  let options = null;
  const deadline = Date.now() + OPTION_WAIT_MS;
  // Options can arrive asynchronously (a remote lookup); wait for a list that
  // contains an exact match, or give up and report what was offered.
  while (Date.now() < deadline) {
    options = await comboOptions(el);
    if (options && options.some(o => norm(o.text) === want)) break;
    await new Promise(r => setTimeout(r, 150));
  }
  const close = async () => {
    // Escape closes the menu and never submits. The typed filter text is
    // cleared so a half-typed answer is not left looking like a value.
    await nativeSet(el, '').catch(() => {});
    if (await hasFocus(el).catch(() => false)) await page.keyboard.press('Escape');
  };
  if (!options) {
    await close();
    throw new FieldFailure('no_matching_option', 'no option list appeared after typing');
  }
  const exact = options.filter(o => !o.disabled && norm(o.text) === want);
  if (exact.length === 0) {
    await close();
    // The offered texts are the SITE's vocabulary, not the answer, and they
    // are what the caller needs to correct it (live Greenhouse offers
    // "United States +1", not "United States"). Capped.
    const offered = options.slice(0, 8).map(o => o.text.slice(0, 40)).join(' | ');
    throw new FieldFailure('no_matching_option', `${options.length} options offered, none matches exactly${offered ? `: ${offered}` : ''}`);
  }
  if (exact.length > 1) {
    await close();
    throw new FieldFailure('ambiguous_option', `${exact.length} options match exactly`);
  }
  const listboxId = await el.evaluate(e => e.getAttribute('aria-controls') || e.getAttribute('aria-owns'));
  // The option is found again inside the SAME listbox, by position among
  // exact matches (ids are optional in ARIA).
  const handles = await page.$$(`[id="${listboxId.replace(/"/g, '\\"')}"] [role="option"]`);
  let target = null;
  for (const h of handles) {
    const t = await h.evaluate(o => (o.textContent || '').replace(/\s+/g, ' ').trim());
    if (norm(t) === want) {
      target = h;
      break;
    }
  }
  if (!target) {
    await close();
    throw new FieldFailure('no_matching_option', 'the matching option vanished before it could be chosen');
  }
  await safeClick(target);
  await new Promise(r => setTimeout(r, 100));
  await blur(el);
  // Read back: the chosen text is now shown as the control's value element
  // (react-select's `*single-value` / `*multi-value`, rendered beside the
  // input, which itself empties). Found by walking up from the input to the
  // nearest ancestor that holds one -- NOT the nearest "*container": live
  // Greenhouse wraps the input alone in `.select__input-container`, which
  // made a value that had landed read as not stuck.
  //
  // Accepted: the value element shows the option text exactly, OR it shows
  // an ABBREVIATION of it -- a non-empty part of the option text that was
  // not already shown before the choice. Live Greenhouse's phone-country
  // picker (labelled "Country") offers "United States +1" and then displays
  // just "+1". The "not shown before" condition is what keeps this from
  // passing a click that did nothing: a stale "No" left in place is a part
  // of "Not applicable", but it was there before, so it proves nothing.
  const after = await shownValues(el);
  if (after === null) throw new FieldFailure('value_did_not_stick', 'no value element found to confirm the choice (not a react-select style control?)');
  if (after.includes(want)) return null;
  const abbreviated = after.filter(v => v && want.includes(v) && !(before || []).includes(v));
  if (abbreviated.length) return 'the control shows an abbreviation of the chosen option';
  throw new FieldFailure('value_did_not_stick', 'the control shows a different value than the chosen option');
}

// The normalized texts of a react-select style control's value element(s),
// found from the nearest ancestor of the input that holds one; null when no
// ancestor within 6 levels does.
async function shownValues(el) {
  return el.evaluate(e => {
    const n = s => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    let box = e.parentElement;
    for (let i = 0; box && i < 6; i++, box = box.parentElement) {
      const vals = box.querySelectorAll('[class*="single-value"], [class*="singleValue"], [class*="multi-value__label"], [class*="multiValue"]');
      if (vals.length) return Array.from(vals).map(v => n(v.textContent));
    }
    return null;
  });
}

async function fillCheck(el, info, control, answer) {
  if (typeof answer !== 'boolean') throw new FieldFailure('answer_type_mismatch', `expected true/false, got ${typeof answer}`);
  if (info.checked === answer) return 'already in that state';
  if (control === 'radio' && answer === false) {
    throw new FieldFailure('cannot_uncheck_radio', 'a radio is cleared by choosing another one; answer that one true instead');
  }
  await safeClick(el);
  const now = await el.evaluate(e => e.checked);
  if (now !== answer) throw new FieldFailure('value_did_not_stick', 'the checked state did not change');
  return null;
}

async function fillFile(el, answer) {
  if (typeof answer !== 'string') throw new FieldFailure('answer_type_mismatch', `expected a file path, got ${typeof answer}`);
  if (!path.isAbsolute(answer)) throw new FieldFailure('answer_type_mismatch', 'file answers must be absolute paths');
  let st = null;
  try {
    st = fs.statSync(answer);
  } catch {
    st = null;
  }
  if (!st || !st.isFile()) throw new FieldFailure('file_not_found', 'no file at the given path');
  await el.uploadFile(answer);
  const name = path.basename(answer);
  const ok = await el.evaluate((e, n) => e.files && e.files.length === 1 && e.files[0].name === n, name);
  if (!ok) throw new FieldFailure('value_did_not_stick', 'the input does not hold the file after upload');
  return null;
}

// --- one field ---------------------------------------------------------------

async function fillOne(page, d, answer) {
  const selector = typeof d?.selector === 'string' && d.selector ? d.selector : null;
  if (!selector) return { control: null, outcome: 'failed', reason: 'invalid_selector', detail: 'the description has no selector for this field' };

  let handles;
  try {
    handles = await page.$$(selector);
  } catch (e) {
    return { control: null, outcome: 'failed', reason: 'invalid_selector', detail: truncate(e.message, 120) };
  }
  if (handles.length === 0) {
    // Nothing to fill and nothing asked of it is still "unfilled", not a
    // fault; a field we were asked to fill and cannot find is a failure.
    return answer === undefined || answer === null || answer === ''
      ? { control: null, outcome: 'unfilled', reason: 'no_answer', detail: 'not on the live page either' }
      : { control: null, outcome: 'failed', reason: 'not_found', detail: 'no element matches on the live page' };
  }
  const info = await inspect(handles[0]);
  const control = classify(info);
  if (info.ariaHidden || d.ariaHidden) {
    return { control, outcome: 'unfilled', reason: 'not_user_fillable', detail: 'aria-hidden: part of a widget, not a question' };
  }
  if (answer === undefined || answer === null || answer === '') {
    return { control, outcome: 'unfilled', reason: 'no_answer', detail: null };
  }
  if (handles.length > 1) {
    return { control, outcome: 'failed', reason: 'selector_not_unique', detail: `${handles.length} elements match; refusing to guess which` };
  }
  const el = handles[0];
  if (control === 'submit') return { control, outcome: 'failed', reason: 'submit_control', detail: 'this is a button, not a question' };
  if (control === 'other') {
    const why = info.type === 'password' ? 'password fields mean an account; that needs Jacob' : `unsupported control ${info.tag}/${info.type}`;
    return { control, outcome: 'failed', reason: 'unsupported_control', detail: why };
  }
  if (info.disabled) return { control, outcome: 'failed', reason: 'disabled', detail: 'disabled or read-only' };
  // An invisible text field is a honeypot as often as it is anything else;
  // filling one tells the site a bot is here. File inputs are routinely
  // hidden behind a styled button, and a checkbox behind a styled label.
  const hiddenOk = control === 'file' || ((control === 'checkbox' || control === 'radio') && info.labelVisible);
  if (!info.visible && !hiddenOk) return { control, outcome: 'failed', reason: 'hidden_control', detail: 'not visible to a person' };

  try {
    let detail = null;
    if (control === 'text') detail = await fillText(page, el, info, answer);
    else if (control === 'textarea') detail = await fillTextarea(el, info, answer);
    else if (control === 'select') detail = await fillSelect(el, info, answer);
    else if (control === 'combobox') detail = await fillCombobox(page, el, answer);
    else if (control === 'checkbox' || control === 'radio') detail = await fillCheck(el, info, control, answer);
    else if (control === 'file') detail = await fillFile(el, answer);
    return { control, outcome: 'filled', reason: null, detail };
  } catch (e) {
    if (e instanceof FieldFailure) return { control, outcome: 'failed', reason: e.reason, detail: e.detail };
    return { control, outcome: 'failed', reason: 'error', detail: truncate(e.message, 160) };
  }
}

// --- the step -----------------------------------------------------------------

function emptyResult() {
  return {
    kind: 'fill',
    contract: CONTRACT,
    status: 'done',
    error: null,
    dryRun: true,
    wallCheck: 'unknown',
    wall: null,
    formHash: null,
    descriptionHash: null,
    formChanged: null,
    navigatedDuringFill: false,
    fields: [],
    counts: { filled: 0, failed: 0, unfilled: 0, total: 0 },
    requiredNotFilled: [],
    undescribedFields: [],
    unknownAnswerKeys: [],
  };
}

function finish(r, description) {
  r.counts = { filled: 0, failed: 0, unfilled: 0, total: r.fields.length };
  for (const f of r.fields) r.counts[f.outcome] += 1;
  r.requiredNotFilled = r.fields
    .filter((f, i) => f.outcome !== 'filled' && description[i]?.required && !description[i]?.ariaHidden && f.reason !== 'not_user_fillable')
    .map(f => f.selector)
    .slice(0, MAX_LISTED);
  return r;
}

function row(d, i, outcome) {
  return {
    index: i,
    selector: typeof d?.selector === 'string' ? d.selector : null,
    label: truncate(d?.label ?? null, 60),
    required: Boolean(d?.required),
    control: outcome.control ?? null,
    outcome: outcome.outcome,
    reason: outcome.reason ?? null,
    detail: outcome.detail ?? null,
  };
}

async function fillForm(page, { fields, answers }) {
  const r = emptyResult();
  if (!Array.isArray(fields)) {
    r.status = 'error';
    r.error = 'no field description: pass `fields`, the field list describe_application_form returned';
    return finish(r, []);
  }
  r.descriptionHash = formHash(fields);
  const answersOk = answers && typeof answers === 'object' && !Array.isArray(answers);
  if (!answersOk) {
    r.status = 'error';
    r.error = '`answers` must be an object keyed by field selector';
    r.fields = fields.map((d, i) => row(d, i, { outcome: 'unfilled', reason: 'not_attempted', detail: null }));
    return finish(r, fields);
  }
  const described = new Set(fields.map(d => d?.selector).filter(Boolean));
  r.unknownAnswerKeys = Object.keys(answers).filter(k => !described.has(k)).slice(0, MAX_LISTED);

  // 1. Wall first. Nothing is touched on a walled page.
  const before = await checkWall(page);
  r.wallCheck = before.state;
  if (before.state === 'wall') {
    r.status = 'blocked-attn';
    r.wall = { phase: 'before', signals: before.signals, advice: before.advice };
    r.fields = fields.map((d, i) => row(d, i, { outcome: 'unfilled', reason: 'blocked_by_wall', detail: null }));
    return finish(r, fields);
  }

  // 2. Is this still the form that was described?
  const live = await probeForms(page, LIVE_FIELD_CAP);
  if (!live.error) {
    r.formHash = live.formHash;
    r.formChanged = live.formHash !== r.descriptionHash;
    r.undescribedFields = live.fields
      .filter(f => f.selector && !described.has(f.selector) && !f.ariaHidden)
      .map(f => f.selector)
      .slice(0, MAX_LISTED);
  }

  // 3. Fill. A navigation of the main frame during the fill means something
  // submitted or redirected; it is watched for, never expected.
  const startUrl = page.url();
  let navigated = false;
  const onNav = frame => {
    if (frame === page.mainFrame()) navigated = true;
  };
  page.on('framenavigated', onNav);
  try {
    for (const [i, d] of fields.entries()) {
      if (navigated) {
        r.fields.push(row(d, i, { outcome: 'unfilled', reason: 'not_attempted', detail: 'the page navigated away mid-fill' }));
        continue;
      }
      const answer = typeof d?.selector === 'string' ? answers[d.selector] : undefined;
      let outcome;
      try {
        outcome = await fillOne(page, d, answer);
      } catch (e) {
        outcome = { control: null, outcome: 'failed', reason: 'error', detail: truncate(e.message, 160) };
      }
      r.fields.push(row(d, i, outcome));
    }
  } finally {
    page.off('framenavigated', onNav);
  }
  r.navigatedDuringFill = navigated || page.url() !== startUrl;
  if (r.navigatedDuringFill) {
    r.status = 'error';
    r.error = 'the page navigated during the fill. That should never happen on a dry fill: check by hand whether anything was submitted.';
    return finish(r, fields);
  }

  // 4. Wall again: filling can provoke a challenge.
  const after = await checkWall(page);
  if (after.state === 'wall') {
    r.status = 'blocked-attn';
    r.wall = { phase: 'after', signals: after.signals, advice: after.advice };
  } else if (after.state === 'unknown') {
    r.wallCheck = 'unknown';
  }
  return finish(r, fields);
}

module.exports = { fillForm, safeClick, classify, checkWall };
