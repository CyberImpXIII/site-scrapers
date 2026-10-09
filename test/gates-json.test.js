// gates.json: every section of CLAUDE.md outside the shared block has a row.
// Run by ./dev.sh check (the suite), which is the gate the dev.sh rows name.
//
// The rows are read by tools/checks' `rules-gated`, which validates them
// (shape, each quote found in its section, each gate executable, each test
// naming its gate) and fails on a section with no row. This runs that one
// check on this repo rather than re-implementing it, so a section added,
// renamed or reworded without its row turns ./dev.sh check red here.
//
// Also, with no workspace needed:
//   - gates.json parses and holds a non-empty `rules` list;
//   - CLAUDE.md carries exactly one shared:rules block, and its content still
//     hashes to its marker (tools/setup's own rule), so an edit made inside the
//     markers fails here, not only when setup next runs. A block BEHIND the
//     template is not a failure here: that is setup's report, and
//     `tools/setup/setup site-scrapers --only rules` is the fix.
//
// Workspace only for the rules-gated half: in a lone clone tools/checks is
// absent and that test is SKIPPED with the reason, never passed silently. The
// verdict read is the check's own `OK rules-gated` line, not the exit code alone.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const CHECKS = path.join(REPO, '..', 'tools', 'checks', 'checks');
const BLOCK = /<!-- shared:rules@([0-9a-f]{12}) -->\n([\s\S]*?)<!-- \/shared -->\n?/g;

test('gates.json parses and holds a rules list', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(REPO, 'gates.json'), 'utf8'));
  assert.ok(Array.isArray(doc.rules) && doc.rules.length > 0, 'a non-empty `rules` list');
});

test('CLAUDE.md carries one shared:rules block, unedited', () => {
  const text = fs.readFileSync(path.join(REPO, 'CLAUDE.md'), 'utf8');
  const blocks = [...text.matchAll(BLOCK)];
  assert.equal(blocks.length, 1, `exactly one block (saw ${blocks.length})`);
  const [, mark, body] = blocks[0];
  assert.ok(body.trim(), 'the block is filled (setup fills an empty marker pair)');
  const content = crypto.createHash('sha256').update(body).digest('hex').slice(0, 12);
  assert.equal(content, mark, 'an edit inside the markers belongs in tools/setup/templates/shared-rules.md instead');
});

test("tools/checks' rules-gated is ok on this repo (workspace only)", t => {
  if (!fs.existsSync(CHECKS)) {
    t.skip(`${CHECKS} absent (a lone clone): rules-gated not run, nothing compared`);
    return;
  }
  const r = spawnSync(CHECKS, ['one', 'rules-gated', REPO], { cwd: path.dirname(CHECKS), encoding: 'utf8', timeout: 300000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const tail = out.trim().split('\n').slice(-12).join('\n');
  assert.equal(r.status, 0, `rules-gated exited ${r.status}:\n${tail}`);
  assert.match(out, /^\s*OK\s+rules-gated\b/m, `no OK line:\n${tail}`);
  assert.doesNotMatch(out, /FAIL/, tail);
});
