// What a describe_form recipe has to show to count as "extracted".
//
// A describe recipe runs open_apply_form then the `forms` probe, and its only
// product is the field list in `diagnostics`. The generic article check judged
// it on the page having TEXT, so a run that never reached the form -- it read
// the posting page instead, 0 fields -- still logged result_count 1 and
// verify.js called it `working`. That is how open_apply_form's dead
// default_selector hid until 2026-10-03: Lever and Ashby
// #action:describe_application_form stayed `working` while describing nothing.
//
// So for a recipe whose action_type is describe_form, a "record" is a
// described field, and zero fields is not extracted. Used by BOTH places that
// decide this, so they cannot disagree: engine.js (the result_count it logs,
// which definitionHasPassingRun reads) and verify.js (the verdict).
//
// Keyed on the recipe's DECLARED purpose, not on a forms probe being present:
// diagnose_page also runs a forms probe, and an article recipe that ran it to
// look at a page has not promised a form. The engine's output is unchanged --
// a page with no form still returns success:true with an empty field list,
// which is a true description of it; only the earned status reads it as
// "nothing extracted".
//
// Limit, stated rather than hidden: ">= 1 field" is a floor. A posting page
// carrying some other form (a newsletter box) would pass it. formHash and the
// field labels are what tell an application form from that.

const DESCRIBE_ACTION_TYPE = 'describe_form';

// -> null when the recipe is not a describe; else { extracted, fields } where
// `fields` is the largest field list any forms probe in the run reported.
function verdictInputsFromDescribe(actionType, diagnostics) {
  if (actionType !== DESCRIBE_ACTION_TYPE) return null;
  const lists = (Array.isArray(diagnostics) ? diagnostics : [])
    .filter(d => d && d.kind === 'forms')
    .map(d => (Array.isArray(d.fields) ? d.fields.length : 0));
  const fields = lists.length ? Math.max(...lists) : 0;
  return { extracted: fields > 0, fields };
}

module.exports = { verdictInputsFromDescribe, DESCRIBE_ACTION_TYPE };
