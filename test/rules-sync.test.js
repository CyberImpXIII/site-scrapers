// Run by ./dev.sh check (the suite), the gate gates.json names for this file.
// The "Keeping these rules in sync" list in CLAUDE.md is a documented list of
// files, so it is checked both ways against the top level's own list: every
// copy the top level names (other than this one) is named here, every one
// named here exists and is named there. A list that drifts is how a rule
// change reaches four copies of seven.
//
// Workspace only: a standalone clone has no top level to compare with. That
// case is SKIPPED with the reason printed, never passed silently. Workspace is
// detected the way check-hooks.sh does it, by the top level's
// .claude/agents.manifest.json.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const TOP = path.join(REPO, '..');
const SELF = path.basename(REPO); // 'site-scrapers'

function syncSection(md) {
  const m = md.match(/^## Keeping these rules in sync\n([\s\S]*?)(?=^## |(?![\s\S]))/m);
  return m ? m[1] : null;
}

function claudePaths(section) {
  return [...section.matchAll(/`([^`]*CLAUDE\.md)`/g)].map(x => x[1]);
}

test('CLAUDE.md has a "Keeping these rules in sync" section naming the other copies', () => {
  const section = syncSection(fs.readFileSync(path.join(REPO, 'CLAUDE.md'), 'utf8'));
  assert.ok(section, 'the section is missing from site-scrapers/CLAUDE.md');
  const named = claudePaths(section);
  assert.ok(named.includes('../CLAUDE.md'), 'the top level copy must be named');
  assert.ok(!named.some(p => p === 'CLAUDE.md' || p === `../${SELF}/CLAUDE.md`), 'a copy does not list itself');
});

test('the sync list here matches the top level list, both ways (workspace only)', t => {
  const manifest = path.join(TOP, '.claude', 'agents.manifest.json');
  if (!fs.existsSync(manifest)) {
    t.skip(`standalone clone (no ${manifest}): nothing to compare the sync list with`);
    return;
  }
  const mine = new Set(claudePaths(syncSection(fs.readFileSync(path.join(REPO, 'CLAUDE.md'), 'utf8'))));
  const topSection = syncSection(fs.readFileSync(path.join(TOP, 'CLAUDE.md'), 'utf8'));
  assert.ok(topSection, 'the top level CLAUDE.md has no "Keeping these rules in sync" section to compare with');
  // The top level writes paths relative to itself; here they are relative to
  // this repo. Translate theirs to ours, drop this repo's own entry, add theirs.
  const theirs = new Set(['../CLAUDE.md', ...claudePaths(topSection).filter(p => p !== `${SELF}/CLAUDE.md`).map(p => `../${p}`)]);
  assert.ok(claudePaths(topSection).includes(`${SELF}/CLAUDE.md`), 'the top level list does not name this repo at all');
  assert.deepEqual([...mine].filter(p => !theirs.has(p)).sort(), [], 'named here but not by the top level');
  assert.deepEqual([...theirs].filter(p => !mine.has(p)).sort(), [], 'named by the top level but missing here');
  for (const p of mine) assert.ok(fs.existsSync(path.join(REPO, p)), `${p} is named but does not exist`);
});
