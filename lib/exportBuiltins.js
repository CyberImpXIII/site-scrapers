// Regenerates lib/builtinActions.js from the DB's builtin rows.
//
// This flips which side is authoritative. The library used to live in the code
// file, hand-edited, seeded into the DB on open — and that made the file the
// one write path the gate could not cover, since a text editor needs no
// authorization. Now the DB is the source of truth and the file is a generated
// EXPORT of it, so every change to a generic action goes through the gate
// (audits before and after, subactions and dependents validated, rollback on
// regression) and the file is rewritten from the result.
//
// Why keep a file at all, rather than committing the database:
//   - data/*.db is gitignored, so a committed DB would still not reach a fresh
//     clone, and un-ignoring it would commit Jacob's own recipes and search
//     history alongside the shared library.
//   - A SQLite file has no reviewable diff. A change to shared behaviour that
//     cannot be read in a pull request is a change nobody can check.
//   - Binary files do not merge.
// The export is plain JS: reviewable, mergeable, and present in a clone.
//
// The file must not be hand-edited — it is overwritten. A test asserts it
// matches the DB, so an edit made directly to it shows up as drift rather
// than silently disappearing on the next export.

const fs = require('fs');
const path = require('path');

const TARGET = path.join(__dirname, 'builtinActions.js');

const HEADER = `// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Regenerated from the generic_actions table by lib/exportBuiltins.js whenever
// a builtin changes. Edit one with:
//
//   node register.js '{"kind":"generic_action","name":"...","steps":[...],"note":"why"}'
//
// which runs the gate: the offline audits before and after, validation of the
// subactions it pulls in AND the dependents it could break, the test suites
// covering all of them, and a rollback if the change introduces a finding.
// Editing this file directly skips every one of those, and the next export
// overwrites it — test/guard.test.js fails on the drift in the meantime.
//
// It is still a FILE, not just a DB row, because data/*.db is gitignored: this
// is how the shared library reaches a fresh clone, and how a change to shared
// behaviour stays reviewable in a diff. It is the export, not the source.
//
// These are seeded into the DB on open (seedBuiltinActions in db.js), which
// validates each one and refuses to seed a builtin that would not run.
`;

function exportBuiltins(db) {
  const rows = db
    .prepare("SELECT name, description, action_type, nav_params_schema, steps FROM generic_actions WHERE source = 'builtin' ORDER BY name")
    .all();
  if (!rows.length) {
    throw new Error('refusing to export an empty builtin library — that would erase it from the only place a clone can get it');
  }

  // Provenance travels WITH each action, in the committed file.
  //
  // This is the part that makes a change to shared behaviour impossible to slip
  // past a reviewer. The change_log lives in the gitignored DB, so it is
  // invisible in a diff; stamping the reason onto the exported action puts it in
  // the diff instead. A legitimate edit changes `steps` AND `changeNote`
  // together. An edit made by hand changes `steps` while leaving the note
  // describing something else — which reads as exactly what it is, and which
  // test/guard.test.js fails on.
  const log = db
    .prepare(
      `SELECT target, summary, changed_at FROM change_log
        WHERE target LIKE 'generic:%' AND rolled_back = 0
        ORDER BY id DESC`
    )
    .all();
  const latestFor = name => log.find(r => r.target === `generic:${name}`);

  const actions = rows.map(r => {
    const entry = latestFor(r.name);
    return {
      name: r.name,
      description: r.description,
      action_type: r.action_type,
      nav_params_schema: r.nav_params_schema,
      // Why this action currently looks the way it does. "seeded from the
      // original library" for ones never edited through the gate.
      changeNote: entry ? entry.summary : 'seeded from the original library, never edited through the gate',
      changedAt: entry ? entry.changed_at : null,
      steps: JSON.parse(r.steps),
    };
  });

  const body = `${HEADER}
const BUILTIN_ACTIONS = ${JSON.stringify(actions, null, 2)};

module.exports = { BUILTIN_ACTIONS };
`;
  // Written read-only, so an accidental hand-edit is refused by the filesystem
  // rather than only discouraged by a comment. Most editors will warn before
  // overriding it, which is exactly the moment to remember the gated path
  // exists. Writable first, because the previous export is already 0444.
  //
  // Honest about the limit: `chmod +w` defeats this in a keystroke, and git
  // does not preserve the read-only bit, so a fresh clone gets an ordinary
  // writable file. It raises the cost of the accident, which is the common
  // case; it is not a security boundary. The real protections are seeding
  // validation and the drift test.
  try {
    if (fs.existsSync(TARGET)) fs.chmodSync(TARGET, 0o644);
  } catch {
    /* mode change is best-effort — never let it block the export itself */
  }
  fs.writeFileSync(TARGET, body);
  let readOnly = false;
  try {
    fs.chmodSync(TARGET, 0o444);
    readOnly = true;
  } catch {
    /* some filesystems ignore modes; the export is still correct */
  }
  return { file: TARGET, count: actions.length, names: actions.map(a => a.name), readOnly };
}

// Does the committed export still match the DB? Drift means either the file was
// hand-edited, or a change was made without regenerating it.
function exportIsCurrent(db) {
  const rows = db
    .prepare("SELECT name, description, action_type, nav_params_schema, steps FROM generic_actions WHERE source = 'builtin' ORDER BY name")
    .all();
  let fileActions;
  try {
    delete require.cache[require.resolve('./builtinActions')];
    fileActions = require('./builtinActions').BUILTIN_ACTIONS;
  } catch (e) {
    return { current: false, reason: `the export does not load: ${e.message}` };
  }
  if (fileActions.length !== rows.length) {
    return { current: false, reason: `the export has ${fileActions.length} actions, the DB has ${rows.length}` };
  }
  for (const r of rows) {
    const f = fileActions.find(a => a.name === r.name);
    if (!f) return { current: false, reason: `"${r.name}" is in the DB but not in the export` };
    if (JSON.stringify(f.steps) !== r.steps) return { current: false, reason: `"${r.name}" has different steps in the export` };
    if ((f.description ?? null) !== r.description) return { current: false, reason: `"${r.name}" has a different description in the export` };
    if ((f.nav_params_schema ?? null) !== r.nav_params_schema) {
      return { current: false, reason: `"${r.name}" has a different nav_params_schema in the export` };
    }
  }
  return { current: true };
}

module.exports = { exportBuiltins, exportIsCurrent, TARGET };
