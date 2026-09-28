// Blocks writes that did not come through a sanctioned path.
//
// Detecting off-path edits after the fact was not enough: the edits still
// landed, with no audits run against them, and the record of them was a warning
// someone had to go looking for. This refuses them outright.
//
// Every function in db.js that mutates a recipe DEFINITION calls
// assertAuthorized(). Authorization is granted only inside authorize(), which
// the sanctioned paths use:
//
//   lib/gate.js       guardedChange — audits before and after, rolls back a
//                     regression, writes a change_log row
//   register.js       its own validation (enum checks, taxonomy, the earned-
//                     status gate) then a version snapshot
//   verify.js         writes a status EARNED by a real run
//   test helpers      authorizeForTests(), so a test writing fixtures is
//                     deliberate and visible rather than an exception
//
// What is deliberately NOT guarded: logRun. It is append-only telemetry
// written by every scrape, not a change to a definition, and requiring
// authorization for it would mean every run needed a reason.
//
// This cannot stop someone opening the file with the sqlite3 CLI. It stops the
// thing that actually kept happening — inline `node -e` calling db.js's own
// exported mutators, or raw db.prepare() next to them, because that was quick.

let authorization = null;
let testsAuthorized = false;

/**
 * Runs `fn` with writes authorized. Nested calls are fine; the outermost owns
 * the lifetime, so a gated change that calls register-style helpers internally
 * does not have to thread a token through.
 */
function authorize(reason, fn) {
  if (!reason) throw new Error('authorize() needs a reason — it is recorded and it is what makes the write accountable');
  if (authorization) return fn(); // already inside an authorized scope
  authorization = { reason, at: Date.now() };
  try {
    return fn();
  } finally {
    authorization = null;
  }
}

/** Async form of authorize(), for paths that await inside the scope. */
async function authorizeAsync(reason, fn) {
  if (!reason) throw new Error('authorizeAsync() needs a reason');
  if (authorization) return fn();
  authorization = { reason, at: Date.now() };
  try {
    return await fn();
  } finally {
    authorization = null;
  }
}

/**
 * Opens writes for a test file. Called once in a test's setup so that fixture
 * writes are explicit — a test IS a sanctioned writer, but it should say so
 * rather than being silently exempt.
 */
function authorizeForTests(reason = 'test fixtures') {
  testsAuthorized = true;
  authorization = { reason, at: Date.now() };
}

/**
 * Closes the blanket test authorization again.
 *
 * Needed because authorizeForTests() is deliberately permanent and global — a
 * test file writes fixtures throughout its life, not inside one scope. The cost
 * is that a test asserting a write is REFUSED cannot run after any file has
 * opened it: the assertion passes vacuously. That happened, and it made four
 * guard tests pass for the wrong reason. A test checking a refusal calls this
 * first.
 */
function revokeTestAuthorization() {
  testsAuthorized = false;
  authorization = null;
}

function currentAuthorization() {
  return authorization ? { ...authorization } : null;
}

function assertAuthorized(operation) {
  if (authorization || testsAuthorized) return;
  throw new Error(
    `${operation}() is a guarded write and was called outside a sanctioned path. ` +
      'Recipe edits go through `node lab.js set <target> \'{..., "note": "why"}\'`, which runs the offline audits ' +
      'before and after, rolls back a regression and records the change. New recipes go through `node register.js`. ' +
      'A status is earned by a run via `node verify.js`. ' +
      'If you are writing a test, call authorizeForTests() in its setup. ' +
      'Do not reach for raw SQL or inline node -e: that path skips every check, which is the specific problem this guard exists to fix.'
  );
}

module.exports = {
  authorize,
  authorizeAsync,
  authorizeForTests,
  revokeTestAuthorization,
  assertAuthorized,
  currentAuthorization,
};
