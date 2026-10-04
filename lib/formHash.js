// One fingerprint for "the form as described", shared by the `forms` probe
// (describe_form / describe_application_form) and the `fill_form` step.
//
// It exists for the application pipeline (PLAN-applications.md §3.1, §3.5): a
// packet stores the description it was prepared against, and anything that
// fills from that packet later must be able to tell that the live form is no
// longer the one Jacob was shown. Comparing two field lists by eye is the thing
// that goes wrong, so it is one function, used by both sides, over an explicit
// list of STRUCTURAL keys.
//
// Deliberately excluded: `hasValue` (changes as the form is filled, so a form
// would "drift" by being filled) and `placeholder` (cosmetic copy). Order is
// included: a question moving is a change to the form.
//
// A key the description lacks hashes as null, so a description produced before
// a key existed reads as CHANGED rather than silently matching. That is the
// cautious direction: a false "changed" costs a re-describe, a false "same"
// sends an application against a form nobody looked at.

const crypto = require('crypto');

const FORM_HASH_KEYS = ['selector', 'tag', 'type', 'name', 'label', 'required', 'role', 'ariaHidden'];

// Also excluded: a CAPTCHA widget's response field. reCAPTCHA injects
// `<textarea id="g-recaptcha-response-100000" name="g-recaptcha-response">`
// when its script finishes loading, which can be after the form is read, so
// the same Discord Greenhouse posting hashed differently in 1 of 3 fills
// (2026-10-03, formChanged=true with nothing changed). It is not a question
// anybody answers and nothing here fills it, so it is not part of "the form".
// Matched on name OR id (the id carries a per-widget suffix). The forms probe
// drops these fields too and counts them in `captchaFieldsExcluded`; skipping
// them here as well keeps a description stored BEFORE that change hashing the
// same as a live read after it.
const CAPTCHA_FIELD_SOURCE = '^(g-recaptcha-response|h-captcha-response|cf-turnstile-response)(-\\d+)?$';
const CAPTCHA_FIELD_RE = new RegExp(CAPTCHA_FIELD_SOURCE, 'i');

function isCaptchaField(f) {
  if (!f) return false;
  const id = typeof f.selector === 'string' && f.selector.startsWith('#') ? f.selector.slice(1) : null;
  return CAPTCHA_FIELD_RE.test(f.name || '') || (id !== null && CAPTCHA_FIELD_RE.test(id));
}

// `required` is hashed as "this field is, or is an option of, something
// required". Since 2026-10-03 an option of a multi-option question carries
// required:false and its question's required-ness in `group.required`; before,
// every option carried required:true. Hashing the OR keeps a description
// stored before that change matching a live read after it (selector, label and
// the rest are unchanged on Greenhouse), and still sees a question's
// required-ness flip. `group` itself is not hashed: hashing a key a stored
// description lacks would flag every existing packet as changed.
const hashedValue = (f, k) => {
  if (k === 'required') return Boolean(f.required) || Boolean(f.group && f.group.required);
  return f[k] !== undefined ? f[k] : null;
};

function formHash(fields) {
  if (!Array.isArray(fields)) return null;
  const rows = fields.filter(f => !isCaptchaField(f)).map(f => FORM_HASH_KEYS.map(k => (f ? hashedValue(f, k) : null)));
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 16);
}

module.exports = { formHash, FORM_HASH_KEYS, CAPTCHA_FIELD_SOURCE, isCaptchaField };
