// The OUTPUT CONTRACT of the `fill_form` step / `fill_application_form` action.
//
// This is a seam between two repos: `applications/` (deep-work) calls the
// action through ./scrape.sh and builds packets from what comes back
// (PLAN-applications.md §3.1, §9). It is documented for that side in
// docs/fill-output.md, and test/fill.test.js holds the three in step:
//   - every reason code here is in the doc's table, and every one there is here;
//   - the doc's example output passes validateFillResult();
//   - every fixture run's output passes validateFillResult().
// Change a code here and the doc must change in the same commit, or the
// suite fails. That is deliberate: the other side reads the doc.

// /2 (2026-10-03): fields[].group and requiredGroupsNotFilled -- a required
// multi-option question is answered by ticking ANY one of its options.
// Still /2 after 2026-10-04: a LIST answer for a control described
// `multiple: true` (lib/multiSelect.js) broadens the input only, and the
// opt-in `fillScreenshot` is a sibling of `fill`, not a key inside it
// (lib/fillScreenshot.js). Neither changes a key, status or reason here.
const CONTRACT = 'fill_application_form/2';

const STATUSES = ['done', 'blocked-attn', 'error'];
const OUTCOMES = ['filled', 'failed', 'unfilled'];

// Which reason may accompany which outcome. `filled` never carries a reason.
const REASONS = {
  unfilled: ['no_answer', 'not_user_fillable', 'blocked_by_wall', 'not_attempted'],
  failed: [
    'invalid_selector',
    'not_found',
    'selector_not_unique',
    'hidden_control',
    'submit_control',
    'disabled',
    'unsupported_control',
    'answer_type_mismatch',
    'multiline_in_single_line',
    'exceeds_maxlength',
    'no_matching_option',
    'ambiguous_option',
    'cannot_uncheck_radio',
    'file_not_found',
    'value_did_not_stick',
    'error',
  ],
};

const CONTROLS = ['text', 'textarea', 'select', 'combobox', 'checkbox', 'radio', 'file', 'submit', 'other'];
const WALL_CHECKS = ['clear', 'wall', 'unknown'];

function isStr(v) {
  return typeof v === 'string';
}

// Returns a list of problems (empty = valid). When `description` (the field
// list that was passed in) is given, also checks the property the plan cares
// about most: every described field has exactly one outcome, in order, none
// missing and none invented.
function validateFillResult(r, description = null) {
  const p = [];
  if (!r || typeof r !== 'object') return ['result is not an object'];
  if (r.kind !== 'fill') p.push(`kind must be "fill", got ${JSON.stringify(r.kind)}`);
  if (r.contract !== CONTRACT) p.push(`contract must be "${CONTRACT}", got ${JSON.stringify(r.contract)}`);
  if (r.dryRun !== true) p.push('dryRun must be true (this action never submits)');
  if (!STATUSES.includes(r.status)) p.push(`status ${JSON.stringify(r.status)} not in ${STATUSES.join('|')}`);
  if (r.status === 'error' && !isStr(r.error)) p.push('status "error" requires an error string');
  if (r.status !== 'error' && r.error !== null) p.push('error must be null unless status is "error"');
  if (!WALL_CHECKS.includes(r.wallCheck)) p.push(`wallCheck ${JSON.stringify(r.wallCheck)} not in ${WALL_CHECKS.join('|')}`);
  if (r.status === 'blocked-attn') {
    if (!r.wall || !Array.isArray(r.wall.signals) || !r.wall.signals.length) p.push('blocked-attn requires wall.signals');
    if (!r.wall || !['before', 'after'].includes(r.wall.phase)) p.push('blocked-attn requires wall.phase before|after');
  } else if (r.wall !== null) {
    p.push('wall must be null unless status is "blocked-attn"');
  }
  for (const k of ['formHash', 'descriptionHash']) {
    if (r[k] !== null && !(isStr(r[k]) && /^[0-9a-f]{16}$/.test(r[k]))) p.push(`${k} must be null or 16 hex chars`);
  }
  if (r.formChanged !== null && typeof r.formChanged !== 'boolean') p.push('formChanged must be boolean or null');
  if (typeof r.navigatedDuringFill !== 'boolean') p.push('navigatedDuringFill must be boolean');
  for (const k of ['undescribedFields', 'unknownAnswerKeys', 'requiredNotFilled', 'requiredGroupsNotFilled']) {
    if (!Array.isArray(r[k])) p.push(`${k} must be an array`);
  }
  (Array.isArray(r.requiredGroupsNotFilled) ? r.requiredGroupsNotFilled : []).forEach((g, i) => {
    const at = `requiredGroupsNotFilled[${i}]`;
    if (!g || !isStr(g.name)) p.push(`${at}.name must be a string`);
    if (!(g?.question === null || isStr(g?.question))) p.push(`${at}.question must be string or null`);
    if (!Array.isArray(g?.selectors) || !g.selectors.length || !g.selectors.every(isStr)) p.push(`${at}.selectors must be a non-empty string array`);
    else if (Array.isArray(r.requiredNotFilled) && !g.selectors.every(s => r.requiredNotFilled.includes(s))) {
      p.push(`${at}: an unanswered group's options must also be in requiredNotFilled`);
    }
  });
  if (!Array.isArray(r.fields)) {
    p.push('fields must be an array');
    return p;
  }
  const counts = { filled: 0, failed: 0, unfilled: 0 };
  r.fields.forEach((f, i) => {
    const at = `fields[${i}]`;
    if (f.index !== i) p.push(`${at}.index must be ${i}`);
    if (!(f.selector === null || isStr(f.selector))) p.push(`${at}.selector must be string or null`);
    if (!(f.group === null || isStr(f.group))) p.push(`${at}.group must be string or null`);
    if (!OUTCOMES.includes(f.outcome)) {
      p.push(`${at}.outcome ${JSON.stringify(f.outcome)} not in ${OUTCOMES.join('|')}`);
      return;
    }
    counts[f.outcome] += 1;
    if (f.outcome === 'filled' && f.reason !== null) p.push(`${at}: filled carries no reason`);
    if (f.outcome !== 'filled' && !REASONS[f.outcome].includes(f.reason)) {
      p.push(`${at}: reason ${JSON.stringify(f.reason)} is not a ${f.outcome} reason`);
    }
    if (!(f.control === null || CONTROLS.includes(f.control))) p.push(`${at}.control ${JSON.stringify(f.control)} unknown`);
    if (!(f.detail === null || isStr(f.detail))) p.push(`${at}.detail must be string or null`);
    if ('value' in f) p.push(`${at} carries a "value": the output must never echo an answer`);
  });
  const c = r.counts || {};
  for (const o of OUTCOMES) if (c[o] !== counts[o]) p.push(`counts.${o} is ${c[o]}, fields say ${counts[o]}`);
  if (c.total !== r.fields.length) p.push(`counts.total is ${c.total}, fields has ${r.fields.length}`);
  if (Array.isArray(description)) {
    if (r.fields.length !== description.length) {
      p.push(`described ${description.length} fields, result has ${r.fields.length}`);
    } else {
      description.forEach((d, i) => {
        if ((d?.selector ?? null) !== r.fields[i].selector) p.push(`fields[${i}] is not the described field ${JSON.stringify(d?.selector)}`);
      });
    }
  }
  return p;
}

// What verify.js should conclude from a run that produced a fill result.
// `working` for this action means a run actually FILLED something and every
// answer it was given landed -- not merely that the page loaded, which is all
// the generic article check would have measured.
function verdictInputsFromFill(fill) {
  if (!fill || fill.kind !== 'fill') return null;
  const n = fill.counts || {};
  return {
    extracted: fill.status === 'done' && (n.filled || 0) > 0 && (n.failed || 0) === 0,
    wall: fill.status === 'blocked-attn' ? fill.wall?.signals ?? ['unknown_wall'] : null,
  };
}

// scrape_runs.params_json is long-lived telemetry, and lab.js reads it back
// (history, adopt-history) into recipe fields. An application's answers are
// Jacob's personal data, so only the KEYS are kept -- same rule as handoff
// captures. `fields` is a description (no values) but runs to kilobytes, so it
// is reduced to a count.
//
// A credential-named param (lib/credentialShapes.js: password, token, api_key,
// ...) is replaced by `{ redacted: true }` at any depth. None is stored today
// (probed 2026-10-09: of 1560 runs the only credential-named key was `answers`,
// all redacted), but nothing stopped a recipe declaring `{{password}}` and the
// run log keeping it for ever. The constraint: credential-shaped values are
// supplied at run time, never stored.
const REDACTED_PARAM_KEYS = ['answers'];
const { isCredentialKey } = require('./credentialShapes');

function redactCredentialKeys(v, depth = 0) {
  if (depth > 8 || !v || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(x => redactCredentialKeys(x, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = isCredentialKey(k) ? { redacted: true } : redactCredentialKeys(x, depth + 1);
  return out;
}

// The string values redactRunParams removes, so an error message that quotes
// one (JSON.parse's message, a selector-not-found naming the typed text) can
// have it cut out too. Answers values included: they are personal data.
function secretValuesOf(params) {
  const vals = [];
  const walk = (v, secret, depth) => {
    if (depth > 8 || v === null || v === undefined) return;
    if (typeof v === 'string' || typeof v === 'number') {
      if (secret && String(v).length >= 4) vals.push(String(v));
      return;
    }
    if (typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) walk(x, secret || isCredentialKey(k), depth + 1);
  };
  if (params && typeof params === 'object') {
    for (const [k, v] of Object.entries(params)) {
      const secret = REDACTED_PARAM_KEYS.includes(k) || isCredentialKey(k);
      // `answers` may arrive as a JSON string: its values, and the raw string.
      if (secret && typeof v === 'string') {
        try {
          walk(JSON.parse(v), true, 1);
        } catch {
          /* not JSON: the raw string below is the value */
        }
      }
      walk(v, secret, 1);
    }
  }
  return [...new Set(vals)].sort((a, b) => b.length - a.length);
}

// The `error` column, with every value redactRunParams removed cut out of it.
function redactRunError(error, params) {
  if (typeof error !== 'string' || !error) return error;
  let out = error;
  for (const v of secretValuesOf(params)) {
    out = out.split(v).join('[redacted]');
    const quoted = JSON.stringify(v).slice(1, -1);
    if (quoted !== v) out = out.split(quoted).join('[redacted]');
  }
  return out;
}

function redactRunParams(params) {
  if (!params || typeof params !== 'object') return params;
  const out = redactCredentialKeys({ ...params });
  for (const k of REDACTED_PARAM_KEYS) {
    if (!(k in out)) continue;
    const v = out[k];
    let keys = null;
    try {
      const obj = typeof v === 'string' ? JSON.parse(v) : v;
      if (obj && typeof obj === 'object') keys = Object.keys(obj);
    } catch {
      /* unparseable: keys stay unknown */
    }
    out[k] = { redacted: true, keys };
  }
  if (Array.isArray(out.fields)) out.fields = { count: out.fields.length };
  return out;
}

// The params as verify.js QUOTES them in a blocked-attn recipe's NEXT STEP note,
// which is stored for good in sites.notes. `@path` and no-secret params are
// quoted as given (the user can paste the command); params carrying a
// credential-named key or `answers` are quoted with those values replaced by
// `{"redacted":true}`, never verbatim. Returns { arg, redacted }.
// test/run-redaction.test.js.
function noteParamsArg(paramsArg, params) {
  if (!paramsArg || paramsArg.startsWith('--')) return { arg: '{}', redacted: false };
  if (paramsArg.startsWith('@') || secretValuesOf(params).length === 0) return { arg: paramsArg, redacted: false };
  const out = redactCredentialKeys({ ...params });
  for (const k of REDACTED_PARAM_KEYS) if (k in out) out[k] = { redacted: true };
  return { arg: JSON.stringify(out), redacted: true };
}

module.exports = {
  noteParamsArg,
  CONTRACT,
  STATUSES,
  OUTCOMES,
  REASONS,
  CONTROLS,
  WALL_CHECKS,
  validateFillResult,
  verdictInputsFromFill,
  redactRunParams,
  redactRunError,
  REDACTED_PARAM_KEYS,
};
