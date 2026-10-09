// The CONTRACT of the `submit_form` step / `submit_application_form` action
// (PLAN-applications.md §3.5, §4): what a caller must pass, and what comes back.
//
// A seam between two repos, like lib/fillContract.js: `applications/` builds
// approve and submit on top of this action (PLAN §12.2 step 7). It is
// documented for that side in docs/submit-output.md, and test/submit.test.js
// holds the three in step:
//   - every status:reason here is in the doc's table, and every one there is here;
//   - every JSON example in the doc passes validateSubmitResult();
//   - every fixture run's output passes validateSubmitResult().
//
// The approval is checked for CONSISTENCY here, not authenticity: that it
// names this packet, is unexpired, and binds exactly this submission (url,
// form, answers, file bytes). That the approval came from Jacob is the
// harness `!` guard's job and applications' approve step (PLAN §3.4).

const crypto = require('crypto');
const fs = require('fs');
const { formHash } = require('./formHash');

const CONTRACT = 'submit_application_form/1';

// PLAN-applications §8 decision 3: an approval lives at most 24 hours.
const APPROVAL_MAX_MS = 24 * 60 * 60 * 1000;
// An approval stamped this far in the future is malformed, not early.
const APPROVAL_CLOCK_SKEW_MS = 5 * 60 * 1000;

// status -> the reasons that may accompany it. Every status carries a reason.
// `clicked` is true exactly for the statuses in CLICKED_STATUSES, plus
// blocked-attn with reason wall_after_submit.
const REASONS = {
  submitted: ['confirmation_seen'],
  failed: ['error_page'],
  unknown: ['no_signal', 'signals_conflict', 'form_still_present', 'observation_error'],
  'blocked-attn': ['wall_before_fill', 'wall_during_fill', 'wall_after_submit'],
  'needs-review': [
    'url_changed',
    'form_changed',
    'form_changed_during_fill',
    'fill_incomplete',
    'navigated_during_fill',
    'wall_unknown',
    'form_not_found',
    'form_not_unique',
    'no_submit_control',
    'submit_control_not_unique',
    'signals_present_before_submit',
  ],
  refused: [
    'no_approval',
    'approval_invalid',
    'approval_expired',
    'bad_params',
    'packet_not_in_batch',
    'packet_changed',
    'live_submit_disarmed',
    'already_attempted',
    'ledger_unavailable',
  ],
  error: ['internal_error'],
};
const STATUSES = Object.keys(REASONS);
const CLICKED_STATUSES = ['submitted', 'failed', 'unknown'];

const BATCH_ID_RE = /^b-[0-9a-f]{16}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const HASH16_RE = /^[0-9a-f]{16}$/;

// --- the submission hash ----------------------------------------------------

// Sorted keys, no whitespace, recursively. One definition, used by the step and
// by `node submit.js hash`, so the approve side never re-implements it.
function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .map(k => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// The fingerprint an approval binds: the posting URL, the form as described
// (formHash), every answer, and the BYTES of every file answer (so swapping a
// resume's contents behind the same path is a different submission).
// Returns { hash, descriptionHash, files } or { error }. Never returns a value.
function submissionHash({ url, fields, answers }) {
  if (typeof url !== 'string' || !url) return { error: '`url` must be the posting URL' };
  if (fields && !Array.isArray(fields) && Array.isArray(fields.fields)) fields = fields.fields;
  if (!Array.isArray(fields) || !fields.length) return { error: '`fields` must be the described field list' };
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return { error: '`answers` must be an object keyed by selector' };
  const fileSelectors = new Set(fields.filter(f => f && f.type === 'file' && typeof f.selector === 'string').map(f => f.selector));
  const files = {};
  for (const [sel, v] of Object.entries(answers)) {
    if (!fileSelectors.has(sel) || v === null || v === undefined || v === '') continue;
    if (typeof v !== 'string') return { error: `the answer for file field ${sel} is not a path` };
    try {
      files[sel] = sha256(fs.readFileSync(v));
    } catch {
      return { error: `the file answer for ${sel} cannot be read` };
    }
  }
  const descriptionHash = formHash(fields);
  const payload = { contract: CONTRACT, url, descriptionHash, answers, files };
  return { hash: sha256(canonicalJson(payload)), descriptionHash, files: Object.keys(files).length };
}

// --- the approval ------------------------------------------------------------

// Pure: the approval gates, in order, before anything touches a page.
// Returns { ok: true, entry } or { ok: false, status, reason, error }.
function checkApproval(approval, { packetId, computedHash, now = Date.now() }) {
  const refuse = (reason, error) => ({ ok: false, status: 'refused', reason, error });
  if (approval === undefined || approval === null || approval === '') return refuse('no_approval', 'no approval was passed: nothing is submitted without one');
  if (typeof approval !== 'object' || Array.isArray(approval)) return refuse('approval_invalid', '`approval` must be an object');
  const { batchId, approvedAt, expiresAt, submissions } = approval;
  if (typeof batchId !== 'string' || !BATCH_ID_RE.test(batchId)) return refuse('approval_invalid', '`approval.batchId` must be "b-" + 16 hex');
  const at = typeof approvedAt === 'string' ? Date.parse(approvedAt) : NaN;
  const exp = typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN;
  if (!Number.isFinite(at) || !Number.isFinite(exp)) return refuse('approval_invalid', '`approval.approvedAt` and `approval.expiresAt` must be ISO 8601 times');
  if (exp <= at) return refuse('approval_invalid', 'the approval expires before it was given');
  if (exp - at > APPROVAL_MAX_MS) return refuse('approval_invalid', 'an approval lives at most 24 hours (PLAN-applications §8 decision 3)');
  if (at > now + APPROVAL_CLOCK_SKEW_MS) return refuse('approval_invalid', 'the approval is dated in the future');
  if (exp <= now) return refuse('approval_expired', 'the approval has expired: a new batch needs a new yes');
  if (!Array.isArray(submissions) || !submissions.length) return refuse('approval_invalid', '`approval.submissions` must list each approved packet');
  const seen = new Set();
  for (const s of submissions) {
    if (!s || typeof s.packetId !== 'string' || !s.packetId || typeof s.submissionHash !== 'string' || !SHA256_RE.test(s.submissionHash)) {
      return refuse('approval_invalid', 'each `approval.submissions` entry is {packetId, submissionHash (64 hex)}');
    }
    if (seen.has(s.packetId)) return refuse('approval_invalid', `packet ${s.packetId} is listed twice in the approval`);
    seen.add(s.packetId);
  }
  if (typeof packetId !== 'string' || !packetId) return refuse('bad_params', '`packetId` is required');
  const entry = submissions.find(s => s.packetId === packetId);
  if (!entry) return refuse('packet_not_in_batch', `packet ${packetId} is not in approved batch ${batchId}`);
  if (typeof computedHash !== 'string' || entry.submissionHash !== computedHash) {
    return refuse('packet_changed', 'this submission (url, form, answers or file bytes) is not the one approved: it needs a new batch');
  }
  return { ok: true, entry };
}

// --- the result ----------------------------------------------------------------

function isStr(v) {
  return typeof v === 'string';
}

// Returns a list of problems (empty = valid).
function validateSubmitResult(r) {
  const p = [];
  if (!r || typeof r !== 'object') return ['result is not an object'];
  if (r.kind !== 'submit') p.push(`kind must be "submit", got ${JSON.stringify(r.kind)}`);
  if (r.contract !== CONTRACT) p.push(`contract must be "${CONTRACT}", got ${JSON.stringify(r.contract)}`);
  if (!STATUSES.includes(r.status)) {
    p.push(`status ${JSON.stringify(r.status)} not in ${STATUSES.join('|')}`);
    return p;
  }
  if (!REASONS[r.status].includes(r.reason)) p.push(`reason ${JSON.stringify(r.reason)} is not a ${r.status} reason`);
  if (typeof r.clicked !== 'boolean') p.push('clicked must be boolean');
  const mustClick = CLICKED_STATUSES.includes(r.status) || (r.status === 'blocked-attn' && r.reason === 'wall_after_submit');
  if (typeof r.clicked === 'boolean' && r.clicked !== mustClick) p.push(`clicked must be ${mustClick} for ${r.status}/${r.reason}`);
  if (r.submitClicks !== (mustClick ? 1 : 0)) p.push(`submitClicks must be ${mustClick ? 1 : 0}`);
  if (r.status === 'error' && !isStr(r.error)) p.push('status "error" requires an error string');
  if (!(r.error === null || isStr(r.error))) p.push('error must be string or null');
  if (!(r.packetId === null || isStr(r.packetId))) p.push('packetId must be string or null');
  if (!(r.batchId === null || (isStr(r.batchId) && BATCH_ID_RE.test(r.batchId)))) p.push('batchId must be null or "b-" + 16 hex');
  if (!(r.submissionHash === null || (isStr(r.submissionHash) && SHA256_RE.test(r.submissionHash)))) p.push('submissionHash must be null or 64 hex');
  for (const k of ['descriptionHash', 'formHash']) {
    if (!(r[k] === null || (isStr(r[k]) && HASH16_RE.test(r[k])))) p.push(`${k} must be null or 16 hex`);
  }
  if (!(r.formChanged === null || typeof r.formChanged === 'boolean')) p.push('formChanged must be boolean or null');
  if (!(r.pageHost === null || isStr(r.pageHost))) p.push('pageHost must be string or null');
  if (!(r.finalUrl === null || isStr(r.finalUrl))) p.push('finalUrl must be string or null');
  if (r.finalUrl && /[?#]/.test(r.finalUrl)) p.push('finalUrl carries no query or fragment');
  if (!(r.fill === null || (r.fill && r.fill.kind === 'fill'))) p.push('fill must be null or a fill result');
  if (r.status === 'blocked-attn') {
    if (!r.wall || !Array.isArray(r.wall.signals) || !r.wall.signals.length) p.push('blocked-attn requires wall.signals');
  } else if (r.wall !== null) {
    p.push('wall must be null unless status is "blocked-attn"');
  }
  if (mustClick) {
    const o = r.observed;
    // observation_error: the page could not be read after the click, so there
    // may be nothing observed to report.
    if (o === null && r.reason === 'observation_error') {
      /* allowed */
    } else if (!o || typeof o !== 'object') p.push('a clicked result carries `observed`');
    else for (const k of ['confirmation', 'error', 'formPresent']) if (typeof o[k] !== 'boolean') p.push(`observed.${k} must be boolean`);
  } else if (r.observed !== null) {
    p.push('observed must be null when nothing was clicked');
  }
  if (r.status === 'submitted' && r.observed && (!r.observed.confirmation || r.observed.error || r.observed.formPresent)) {
    p.push('submitted requires a confirmation, no error, and the form gone');
  }
  if ('answers' in r || 'value' in r) p.push('the result must never carry answers or a value');
  return p;
}

module.exports = {
  CONTRACT,
  STATUSES,
  REASONS,
  CLICKED_STATUSES,
  APPROVAL_MAX_MS,
  APPROVAL_CLOCK_SKEW_MS,
  canonicalJson,
  submissionHash,
  checkApproval,
  validateSubmitResult,
};
