// Which recipes and actions SUBMIT (contain a `submit_form` step, directly or
// through any run_action / run_generic_action), so the tools that run recipes
// unattended can refuse them before a browser starts: verify.js, lab.js,
// primitives.js and the live audits in audit.js (PLAN-applications §3.5:
// nothing submits unattended). The step itself refuses without an approval;
// this is the second wall, and it keeps a submit recipe from being "verified"
// by a run nobody approved.
//
// Kept apart from lib/submitForm.js so these tools do not load the browser
// code. test/submit.test.js runs each tool against a submit recipe.

const { expandSteps, refKey } = require('./composeActions');
const { getGenericAction } = require('../db');

function stepsSubmit(steps) {
  return (Array.isArray(steps) ? steps : []).some(s => s && (s.action === 'submit_form' || stepsSubmit(s.steps)));
}

function parse(json) {
  if (Array.isArray(json)) return json;
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// A site row (snake_case, as getSite returns it). An expansion that fails is
// not a submit the engine could run: the engine refuses that recipe too, on
// the same expansion, before launching anything.
function recipeSubmits(db, site) {
  if (!site) return false;
  const visited = () => new Set([refKey({ hostname: site.hostname, pageType: site.page_type, recipeName: site.recipe_name })]);
  for (const src of [site.nav_method === 'ui_steps' ? site.nav_template : null, site.pagination_config]) {
    const raw = src ? parse(src) : null;
    if (!raw) continue;
    if (stepsSubmit(raw)) return true;
    try {
      if (stepsSubmit(expandSteps(db, raw, site.hostname, visited()))) return true;
    } catch {
      /* see above */
    }
  }
  return false;
}

// A generic action by name.
function actionSubmits(db, name) {
  const row = getGenericAction(db, name);
  if (!row) return false;
  const raw = parse(row.steps);
  if (stepsSubmit(raw)) return true;
  try {
    return stepsSubmit(expandSteps(db, [{ action: 'run_generic_action', ref: name }], 'submit-guard.internal', new Set()));
  } catch {
    return false;
  }
}

const REFUSAL =
  'refused: this recipe SUBMITS (a submit_form step). Unattended tools never run a submit (PLAN-applications §3.5); ' +
  'its gates are proven offline by test/submit.test.js, and it runs only through ./scrape.sh with a batch approval.';

module.exports = { stepsSubmit, recipeSubmits, actionSubmits, REFUSAL };
