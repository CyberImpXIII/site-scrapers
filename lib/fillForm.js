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
const { MULTI_CONTAINER_SELECTOR, MULTI_CHIP_SELECTOR, MULTI_ANCESTOR_LEVELS } = require('./multiSelect');

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
  return el.evaluate((e, multiContainer, multiLevels) => {
    const tag = e.tagName.toLowerCase();
    // Takes several options: lib/multiSelect.js, the same test the forms probe
    // uses for a description's `multiple`.
    let multiple = !!e.multiple;
    if (!multiple && e.getAttribute('role') === 'combobox') {
      let box = e.parentElement;
      for (let i = 0; box && i < multiLevels && !multiple; i++, box = box.parentElement) multiple = box.matches(multiContainer);
    }
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
      multiple,
      visible,
      labelVisible,
      checked: !!e.checked,
    };
  }, MULTI_CONTAINER_SELECTOR, MULTI_ANCESTOR_LEVELS);
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

// An option answer for a select/combobox: a string, or a LIST of option texts.
// A list is accepted only by a control that takes several options; a
// one-element list on a single-option control is just that option. Returns
// the option texts, deduplicated by their normalized form (choosing the same
// option twice is one choice), never empty -- an empty list is `no_answer`,
// caught before this.
function asOptionList(answer, multiple) {
  const list = Array.isArray(answer) ? answer : [answer];
  if (!multiple && list.length > 1) {
    throw new FieldFailure('answer_type_mismatch', `a list of ${list.length} options for a control that takes one`);
  }
  const out = [];
  const seen = new Set();
  for (const a of list) {
    if (typeof a !== 'string' && !(typeof a === 'number' && Number.isFinite(a))) {
      throw new FieldFailure('answer_type_mismatch', `each option must be text, got ${Array.isArray(a) ? 'array' : typeof a}`);
    }
    const t = String(a);
    if (!norm(t)) throw new FieldFailure('answer_type_mismatch', 'empty option text');
    if (seen.has(norm(t))) continue;
    seen.add(norm(t));
    out.push(t);
  }
  return out;
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

// Which option each answer names, as indexes into e.options: by `value`
// first, else by visible text (exact, normalized). One entry per answer:
// {count, index} -- count 0 / >1 is a failure for that answer.
async function matchSelectOptions(el, wants) {
  return el.evaluate((e, wants) => {
    const n = s => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    const opts = Array.from(e.options).map((o, index) => ({ o, index })).filter(x => !x.o.disabled);
    const picks = wants.map(want => {
      const byValue = opts.filter(x => x.o.value !== '' && x.o.value === want);
      const matches = byValue.length ? byValue : opts.filter(x => n(x.o.textContent) === n(want) && n(want) !== '');
      return { count: matches.length, index: matches.length === 1 ? matches[0].index : null };
    });
    return { total: opts.length, picks };
  }, wants);
}

async function fillSelect(el, info, answer) {
  const wants = asOptionList(answer, info.multiple);
  const { total, picks } = await matchSelectOptions(el, wants);
  // Every answer is checked before anything is set: a list with one bad
  // entry changes nothing, rather than leaving half of it chosen.
  const none = picks.filter(p => p.count === 0).length;
  if (none) throw new FieldFailure('no_matching_option', `${wants.length > 1 ? `${none} of ${wants.length} answers match` : 'the answer matches'} none of ${total} options exactly`);
  const many = picks.find(p => p.count > 1);
  if (many) throw new FieldFailure('ambiguous_option', `${many.count} options match`);
  const chosen = picks.map(p => p.index);
  if (!info.multiple) {
    const value = await el.evaluate((e, i) => e.options[i].value, chosen[0]);
    await nativeSet(el, value);
    const ok = await el.evaluate((e, v) => e.value === v, value);
    if (!ok) throw new FieldFailure('value_did_not_stick', 'the selection did not hold');
    return null;
  }
  // <select multiple>: EXACTLY the answered options end up selected (options
  // selected before the fill and not in the answer are deselected -- the
  // answer is the whole set), then the change is announced as a person's
  // ctrl-click would be.
  await el.evaluate((e, idx) => {
    const want = new Set(idx);
    Array.from(e.options).forEach((o, i) => {
      o.selected = want.has(i);
    });
    e.dispatchEvent(new Event('input', { bubbles: true }));
    e.dispatchEvent(new Event('change', { bubbles: true }));
  }, chosen);
  const got = await el.evaluate(e => Array.from(e.options).flatMap((o, i) => (o.selected ? [i] : [])));
  const same = got.length === chosen.length && chosen.every(i => got.includes(i));
  if (!same) throw new FieldFailure('value_did_not_stick', `${got.length} options selected after choosing ${chosen.length}`);
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

async function fillCombobox(page, el, info, answer) {
  const wants = asOptionList(answer, info.multiple);
  if (!info.multiple) return fillComboboxOne(page, el, wants[0]);
  return fillComboboxMulti(page, el, wants);
}

// A combobox that takes several options (react-select isMulti): each answer
// is chosen in turn, the same way as a single one, and the result is read
// back from the chips. The answer is the WHOLE set: an option already chosen
// before the fill that is not in the answer would have to be removed, which is
// not supported -- refused before anything is touched rather than left in.
async function fillComboboxMulti(page, el, wants) {
  const before = (await chips(el)) || [];
  const wanted = new Set(wants.map(norm));
  const extra = before.filter(v => !wanted.has(v));
  if (extra.length) {
    throw new FieldFailure('unsupported_control', `${extra.length} option(s) were already chosen and are not in the answer; removing an option is not supported`);
  }
  let chosen = 0;
  for (const text of wants) {
    if (before.includes(norm(text))) continue; // already chosen: picking again would not add it
    try {
      await pickOption(page, el, text);
    } catch (e) {
      if (e instanceof FieldFailure && chosen > 0) {
        e.detail = `${e.detail}; ${chosen} option(s) chosen before this one stay chosen`;
      }
      throw e;
    }
    chosen += 1;
    await new Promise(r => setTimeout(r, 100));
  }
  await blur(el);
  const after = (await chips(el)) || [];
  const missing = [...wanted].filter(w => !after.includes(w)).length;
  const unexpected = after.filter(v => !wanted.has(v)).length;
  if (missing || unexpected) {
    throw new FieldFailure('value_did_not_stick', `${missing} of ${wanted.size} answered options not shown, ${unexpected} other(s) shown`);
  }
  return null;
}

// The normalized chip labels of a multi-option combobox, from the nearest
// ancestor of the input that is the multi value container; null when none is.
async function chips(el) {
  return el.evaluate(
    (e, container, chip, levels) => {
      const n = s => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
      let box = e.parentElement;
      for (let i = 0; box && i < levels; i++, box = box.parentElement) {
        if (box.matches(container)) return Array.from(box.querySelectorAll(chip)).map(c => n(c.textContent));
      }
      return null;
    },
    MULTI_CONTAINER_SELECTOR,
    MULTI_CHIP_SELECTOR,
    MULTI_ANCESTOR_LEVELS
  );
}

async function fillComboboxOne(page, el, text) {
  const want = norm(text);
  const before = await shownValues(el);
  await pickOption(page, el, text);
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

// Type the option's text, wait for the control's OWN listbox to offer it,
// and click the one exact match. Throws FieldFailure (closing the menu
// first) when there is no list, no exact match, or more than one.
async function pickOption(page, el, text) {
  const want = norm(text);
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
  if (options.length === 0) {
    await close();
    // The list opened but holds no option: the control's own filter (or
    // remote search) found nothing for the typed text -- react-select shows
    // "No options". That is about the ANSWER, not about reading the list, and
    // must not read as "options offered": on 2026-10-05 "0 options offered"
    // on every combobox of a made-up-answer dry fill was taken for a
    // regression in option reading (TODO.md). No list at all is the case above.
    throw new FieldFailure('no_matching_option', 'the control offered no options for the typed answer (its own filter or search found none)');
  }
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

// Missing, null, "" and an empty option list ([]) all mean "not answered".
const isNoAnswer = a => a === undefined || a === null || a === '' || (Array.isArray(a) && a.length === 0);

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
    return isNoAnswer(answer)
      ? { control: null, outcome: 'unfilled', reason: 'no_answer', detail: 'not on the live page either' }
      : { control: null, outcome: 'failed', reason: 'not_found', detail: 'no element matches on the live page' };
  }
  const info = await inspect(handles[0]);
  const control = classify(info);
  if (info.ariaHidden || d.ariaHidden) {
    return { control, outcome: 'unfilled', reason: 'not_user_fillable', detail: 'aria-hidden: part of a widget, not a question' };
  }
  if (isNoAnswer(answer)) {
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
    else if (control === 'combobox') detail = await fillCombobox(page, el, info, answer);
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
    requiredGroupsNotFilled: [],
    undescribedFields: [],
    unknownAnswerKeys: [],
  };
}

// Required multi-option questions in a description: name -> {name, question,
// selectors}. An option the description marks ariaHidden is not offered.
function requiredGroups(description) {
  const groups = new Map();
  for (const d of description) {
    const g = d?.group;
    if (!g || !g.required || typeof g.name !== 'string' || typeof d.selector !== 'string' || d.ariaHidden) continue;
    if (!groups.has(g.name)) groups.set(g.name, { name: g.name, question: typeof g.question === 'string' ? g.question : null, selectors: [] });
    groups.get(g.name).selectors.push(d.selector);
  }
  return groups;
}

// Which of these option selectors are ticked on the live page, read AFTER the
// fill. Read from the page rather than inferred from outcomes: `false` is a
// filled answer that unticks, and an option can be ticked before the fill.
// A selector that does not resolve reads as not ticked. A wedged renderer
// (no answer in 5s) returns null: no group counts as answered.
async function tickedOptions(page, selectors) {
  if (!selectors.length) return new Set();
  const read = page.evaluate(
    sels =>
      sels.filter(s => {
        try {
          return document.querySelector(s)?.checked === true;
        } catch {
          return false;
        }
      }),
    selectors,
  );
  const ticked = await Promise.race([read, new Promise(resolve => setTimeout(() => resolve(null), 5000))]);
  return Array.isArray(ticked) ? new Set(ticked) : null;
}

// `ticked`: the option selectors ticked on the page after the fill, or null
// when the fill did not get that far -- then no group counts as answered,
// which is the cautious direction.
function finish(r, description, ticked = null) {
  r.counts = { filled: 0, failed: 0, unfilled: 0, total: r.fields.length };
  for (const f of r.fields) r.counts[f.outcome] += 1;
  // A required question with options is answered when ANY option is ticked.
  // While it is not, it is listed once in requiredGroupsNotFilled AND each of
  // its options stays in requiredNotFilled, so a caller that only tests
  // requiredNotFilled for emptiness still cannot read it as ready.
  const groups = [...requiredGroups(description).values()].filter(g => !g.selectors.some(s => ticked?.has(s)));
  const openOption = new Set(groups.flatMap(g => g.selectors));
  r.requiredGroupsNotFilled = groups.slice(0, MAX_LISTED);
  r.requiredNotFilled = r.fields
    .filter((f, i) => {
      if (openOption.has(f.selector)) return true;
      return f.outcome !== 'filled' && description[i]?.required && !description[i]?.ariaHidden && f.reason !== 'not_user_fillable';
    })
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
    // The multi-option question this field is an option of, by name, else null.
    group: typeof d?.group?.name === 'string' ? d.group.name : null,
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
  let ticked = null;
  const groupOptions = [...requiredGroups(fields).values()].flatMap(g => g.selectors);
  if (groupOptions.length) {
    try {
      ticked = await tickedOptions(page, groupOptions);
    } catch {
      ticked = null; // unreadable: every required group stays unanswered
    }
  }
  return finish(r, fields, ticked);
}

module.exports = { fillForm, safeClick, classify, checkWall };
