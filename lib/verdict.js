// The status state machine, extracted so it can be tested exhaustively.
//
// It used to live inline in verify.js's main(), which is how it came to
// violate its own documented rule: "blocked" is supposed to mean a person
// alone is sufficient, and the inline version awarded it on mere wall
// detection — with no attended run ever performed. The invariant existed only
// in a comment. A rule that is documented but unenforced is not a rule, so it
// lives here as a pure function with a test per transition.
//
// Inputs are facts a run produced, never judgements:
//   extracted     did records actually come back
//   wall          which wall services the diagnostics identified (or null)
//   attended      was a person present, i.e. --attended
//   alreadyProven does this definition have a prior passing run
//
// The asymmetry is deliberate. "working" and "blocked" are claims that have to
// be earned by a run. "blocked-attn" and "broken" are the cautious directions
// and can be reached freely, because being wrong about them only parks work
// rather than asserting success.

const VERDICTS = ['working', 'blocked', 'blocked-attn', 'broken', 'inconclusive'];

function decideVerdict({ extracted, wall = null, attended = false, alreadyProven = false }) {
  const walled = Array.isArray(wall) ? wall.length > 0 : Boolean(wall);

  if (attended) {
    // A person was present, so this run answers the one question that
    // separates the two blocked states.
    if (!extracted) {
      // Their presence was not enough: real work remains, so this is not
      // merely "blocked" no matter what wall was seen.
      return 'blocked-attn';
    }
    // Records came back with a person present. If something was in the way,
    // that is now proven attendable; if nothing was, it simply works.
    return walled ? 'blocked' : 'working';
  }

  if (extracted) return 'working';

  // Unattended and empty. A wall means something is in the way, but whether a
  // person resolves it is still unknown — that is exactly what has not been
  // tested, so it cannot be called "blocked".
  if (walled) return 'blocked-attn';

  // No wall, nothing extracted. If this definition has produced records
  // before, an empty run is most likely a query that matched nothing rather
  // than a regression, so do not demote it.
  return alreadyProven ? 'inconclusive' : 'broken';
}

// Which verdicts a run may WRITE. "inconclusive" is a report, not a status:
// it explicitly means "leave the status alone".
function isWritableStatus(verdict) {
  return verdict !== 'inconclusive';
}

// Statuses a human or agent may set directly. The earned ones must come from
// decideVerdict via an actual run; register.js and lab.js both enforce this,
// because a second write path that skips the gate is not a gate.
const HAND_SETTABLE = ['broken', 'needs-review', 'blocked-attn'];
const EARNED_BY_RUN = ['working', 'blocked'];

module.exports = { decideVerdict, isWritableStatus, VERDICTS, HAND_SETTABLE, EARNED_BY_RUN };
