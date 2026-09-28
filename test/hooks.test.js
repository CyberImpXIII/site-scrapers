// The hook layer and dev.sh, checked by the suite rather than by hand.
//
// These exist because the enforcement layer had no enforcement of its own. The
// hooks are the only thing making three rules real, and every property they
// promise was unverified:
//
//   - the hook test scripts existed but nothing RAN them, so they could rot
//     silently while still looking like coverage
//   - nothing confirmed a hook FAILS OPEN, which is the property the whole
//     design rests on: each header promises it, and a hook that exits non-zero
//     on malformed input would refuse every matching tool call
//   - dev.sh's usage() printed a hardcoded line range that had to be bumped by
//     hand whenever a subcommand was documented, and was bumped wrong three
//     times in one session -- the help truncated mid-list while dev.sh kept
//     working, so nothing pointed at it
//   - nothing checked that a documented subcommand exists, or that an
//     implemented one is documented
//
// Cross-FOLDER checks (copies agreeing, every location installed and wired)
// live in check-hooks.sh instead, because they look outside this repo and a
// fresh clone has no siblings to compare against. `./dev.sh check` runs both.
//
// Run via `npm test` / `./test.sh`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const HOOKS = path.join(REPO, '.claude', 'hooks');
const SETTINGS = path.join(REPO, '.claude', 'settings.json');

const hookFiles = fs
  .readdirSync(HOOKS)
  .filter(f => f.endsWith('.sh') && !f.startsWith('test-'))
  .sort();

const wiredCommands = () => {
  const raw = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  return (raw.hooks?.PreToolUse || []).flatMap(e => (e.hooks || []).map(h => h.command));
};

test('there are hooks to check', () => {
  // Guards against the whole file passing vacuously if .claude/hooks ever moves.
  assert.ok(hookFiles.length >= 3, `expected the hook set, found: ${hookFiles.join(', ') || 'none'}`);
});

test('every hook named in settings.json exists and is executable', () => {
  // The dangerous direction. Claude Code reads a non-zero exit as a block, so a
  // named-but-absent hook command does not degrade to "unenforced" -- it
  // REFUSES every matching tool call.
  for (const command of wiredCommands()) {
    const name = command.split('/').pop();
    const file = path.join(HOOKS, name);
    assert.ok(fs.existsSync(file), `settings.json names ${name}, which does not exist`);
    assert.ok((fs.statSync(file).mode & 0o111) !== 0, `${name} is not executable, so it cannot run`);
  }
});

test('every hook is wired, and every wired hook is a real file', () => {
  // A hook file nothing wires enforces nothing while looking installed.
  const wired = new Set(wiredCommands().map(c => c.split('/').pop()));
  for (const name of hookFiles) {
    assert.ok(wired.has(name), `${name} exists but settings.json does not wire it`);
  }
});

test('every hook is valid bash', () => {
  for (const name of hookFiles) {
    // Throws on a syntax error, which would otherwise surface as a non-zero
    // exit and therefore as a block on every matching call.
    execFileSync('bash', ['-n', path.join(HOOKS, name)]);
  }
});

test('every hook FAILS OPEN on input it cannot parse', () => {
  // The property every hook header promises and none verified. A hook is handed
  // JSON on stdin; if it ever exits non-zero because that JSON was empty,
  // truncated or not JSON at all, it stops being a guard and becomes an outage.
  for (const name of hookFiles) {
    for (const payload of ['', '{}', 'not json at all', '{"tool_input":{}}', '{"tool_name":"Bash"}']) {
      const res = require('node:child_process').spawnSync('bash', [path.join(HOOKS, name)], {
        input: payload,
        encoding: 'utf8',
      });
      assert.equal(
        res.status,
        0,
        `${name} exited ${res.status} on input ${JSON.stringify(payload)} — it must fail open`
      );
    }
  }
});

test('every hook has a test script, and each one passes', () => {
  // Running them here is the point: they existed, and nothing executed them, so
  // they were coverage in name only.
  for (const name of hookFiles) {
    const testScript = path.join(HOOKS, `test-${name}`);
    assert.ok(fs.existsSync(testScript), `${name} has no test-${name} beside it`);
    try {
      execFileSync('bash', [testScript], { encoding: 'utf8', stdio: 'pipe', timeout: 240000 });
    } catch (e) {
      assert.fail(`test-${name} failed:\n${(e.stdout || '') + (e.stderr || '')}`);
    }
  }
});

// --- dev.sh: documented and implemented must be the same set -----------------

const devSh = fs.readFileSync(path.join(REPO, 'dev.sh'), 'utf8');

// Documented: the `./dev.sh <name>` lines in the header block.
const documented = new Set(
  [...devSh.matchAll(/^#\s+\.\/dev\.sh\s+([a-z][a-z-]*)/gm)].map(m => m[1])
);
// Implemented: the case arms, splitting the alternations -- `run|verify)` is one
// arm serving two subcommands, and a pattern that only matched a single name
// reported both as unimplemented.
const implemented = new Set(
  [...devSh.slice(devSh.indexOf('case "$cmd" in')).matchAll(/^\s{2}([a-z][a-z|-]*)\)/gm)]
    .flatMap(m => m[1].split('|'))
);

test('dev.sh documents every subcommand it implements', () => {
  const undocumented = [...implemented].filter(c => !documented.has(c));
  assert.deepEqual(undocumented, [], `implemented but not in the header: ${undocumented.join(', ')}`);
});

test('dev.sh implements every subcommand it documents', () => {
  // The direction that produces a confusing failure: a documented command falls
  // through to the catch-all and prints usage, which reads as "you typed it
  // wrong" rather than "this was never written".
  const missing = [...documented].filter(c => !implemented.has(c));
  assert.deepEqual(missing, [], `documented but not implemented: ${missing.join(', ')}`);
});

test('dev.sh usage prints the whole header, however long it grows', () => {
  // Was a hardcoded line range, bumped by hand and wrong three times. The last
  // documented subcommand is the canary: if usage() truncates, it disappears
  // first and nothing else changes.
  const out = require('node:child_process').spawnSync('bash', [path.join(REPO, 'dev.sh')], {
    encoding: 'utf8',
  });
  const help = (out.stdout || '') + (out.stderr || '');
  for (const cmd of documented) {
    assert.ok(help.includes(`./dev.sh ${cmd}`), `usage output is missing "${cmd}" — the header is being truncated`);
  }
});
