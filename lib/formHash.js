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

function formHash(fields) {
  if (!Array.isArray(fields)) return null;
  const rows = fields.map(f => FORM_HASH_KEYS.map(k => (f && f[k] !== undefined ? f[k] : null)));
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 16);
}

module.exports = { formHash, FORM_HASH_KEYS };
