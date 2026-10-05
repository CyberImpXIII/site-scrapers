// blocked-guard: a `blocked-attn` recipe is refused by the CLI itself unless
// the run is ATTENDED. PLAN-hard-gates.md §3 row 21, §7 phase 5.
//
// `blocked-attn` means troubleshooting stalled pending Jacob: an unattended run
// already failed (often against a wall), so retrying it cannot produce a new
// answer and is how a bot wall gets mistaken for a broken recipe -- or gets
// hammered until it hardens. The rule ("a detected wall is a result to report,
// not an obstacle") was held only by the troubleshooting.sh hook, which a
// session without that hook installed, or a command the hook's target regex
// does not parse, walked straight past. engine.js's own status gate refused
// it too, but only without `allowUnverified` -- and lab.js, verify.js and
// audit.js pass that on every run by design.
//
// So the check lives where every run goes through: engine.js, after the recipe
// is loaded and before anything launches, and BEFORE the allowUnverified
// escape hatch. `allowUnverified` does not open it; only `attended` does,
// because an attended run (a person at a visible window) is the sanctioned
// next step for this state and the only way out of it (verify.js --attended).
//
// Ways to say attended, all equivalent: the `--attended` flag on engine.js /
// scrape.sh / lab.js / verify.js, or `"attended": true` in the params. The
// guard and engine.js's headed-window decision both read isAttended(), so a
// run the guard lets through is exactly a run that opens a window.
//
// Scope, deliberately: one RECIPE's status, not a host. A host-level wall
// (lab.js probe/sel/inside and primitives.js try take a bare URL) is not held
// here -- see TODO.md.
//
// Tests: test/blocked-guard.test.js.
'use strict';

const REFUSED = 'blocked-attn';

// The one reading of "attended". engine.js uses it for the headed-window
// decision too, so the two cannot drift.
function isAttended(params) {
  return Boolean(params && params.attended);
}

// 'refuse'   -- blocked-attn, unattended: the run must not happen.
// 'attended' -- blocked-attn, attended: the sanctioned run; it also clears the
//               ordinary status gate, which would otherwise refuse it with
//               "do not retry" -- the opposite of what an attended run is for.
// null       -- any other status: this guard has no opinion.
function blockedAttnGate(site, params) {
  if (!site || site.status !== 'blocked-attn') return null;
  return isAttended(params) ? 'attended' : 'refuse';
}

function targetOf(site) {
  return `${site.hostname}#${site.page_type}:${site.recipe_name}`;
}

// The refusal engine.js prints. `refused` is the machine-readable key callers
// test (lab.js, verify.js); `next` is the exact sanctioned command.
function blockedAttnRefusal(site) {
  const target = targetOf(site);
  return {
    success: false,
    documented: true,
    status: 'blocked-attn',
    refused: REFUSED,
    notes: site.notes,
    error:
      `status="blocked-attn": ${target} already failed unattended and troubleshooting is STALLED pending the user. ` +
      'Refused by the CLI (lib/blockedGuard.js): an unattended re-run cannot produce a new answer, and against a ' +
      'wall it is an attempt to get past bot detection. allowUnverified does not open this. Read `notes` for what ' +
      'the user must supply, surface it, and move on -- or, with the user present, run it attended.',
    next: `node verify.js ${target} '<params>' --attended`,
  };
}

// Did this engine output come from the guard? Callers that interpret a run
// (lab.js params would read two refusals as "parameters change the result
// set"; verify.js would demote the recipe) must stop on it instead.
function isBlockedRefusal(result) {
  return Boolean(result && result.refused === REFUSED);
}

module.exports = { isAttended, blockedAttnGate, blockedAttnRefusal, isBlockedRefusal, REFUSED };
