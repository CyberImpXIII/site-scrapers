// Run by ./dev.sh check (the suite), the gate gates.json names for this file.
// .env handling (Decision 12 revised, 2026-10-04): every env-file shape is
// gitignored, and the key-names-only example/sample/template is NOT, so it
// can be committed. Both directions are checked: a pattern that ignored
// everything would pass a one-sided test while hiding the example file.
// tools/checks `no-secrets` checks only `.env`; this covers the rest.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

// git check-ignore --no-index: exit 0 = ignored, 1 = not ignored, else error.
function ignored(p) {
  const r = spawnSync('git', ['check-ignore', '--no-index', '-q', p], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (r.status !== 0 && r.status !== 1) throw new Error(`git check-ignore ${p}: status ${r.status} ${r.stderr}`);
  return r.status === 0;
}

const MUST_IGNORE = ['.env', '.env.local', '.env.production', 'secrets.env', 'sub/.env', 'sub/dir/.env.test', 'sub/x.env'];
const MUST_KEEP = ['.env.example', '.env.sample', '.env.template', 'sub/.env.example', 'environment.js', 'docs/env.md'];

test('every env-file shape is gitignored', () => {
  const leaked = MUST_IGNORE.filter(p => !ignored(p));
  assert.deepEqual(leaked, [], `not ignored: ${leaked.join(', ')}`);
});

test('the key-names-only example/sample/template files are NOT ignored', () => {
  const hidden = MUST_KEEP.filter(p => ignored(p));
  assert.deepEqual(hidden, [], `ignored but should be committable: ${hidden.join(', ')}`);
});
