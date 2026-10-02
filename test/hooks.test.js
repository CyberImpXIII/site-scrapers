// The tooling's own seams -- the hook layer, dev.sh and test.sh -- checked by
// the suite rather than by hand.
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

// Every hook command, across EVERY event, not only PreToolUse.
const wiredCommands = () => {
  const raw = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  return Object.values(raw.hooks || {})
    .flat()
    .flatMap(e => (e.hooks || []).map(h => h.command))
    .filter(Boolean);
};

// The script a command runs: the first word after `.claude/hooks/`. The rest
// are ARGUMENTS -- `agent-watch.sh prespawn` runs agent-watch.sh. Taking the
// last `/`-segment read that as one name with a space in it, and check-hooks.sh
// read it as two hooks, one called `prespawn`. Same rule as its wired_scripts().
const hookScript = command => {
  const m = /\.claude\/hooks\/(\S+)/.exec(command);
  return m ? m[1] : null;
};

test('hookScript reads the script and never an argument', () => {
  assert.equal(hookScript('$CLAUDE_PROJECT_DIR/.claude/hooks/agent-watch.sh prespawn'), 'agent-watch.sh');
  assert.equal(hookScript('$CLAUDE_PROJECT_DIR/.claude/hooks/agent-watch.sh alert PostToolUse'), 'agent-watch.sh');
  assert.equal(hookScript('$CLAUDE_PROJECT_DIR/.claude/hooks/no-inline-blobs.sh'), 'no-inline-blobs.sh');
  assert.equal(hookScript('echo not a hook file'), null);
});

test('there are hooks to check', () => {
  // Guards against the whole file passing vacuously if .claude/hooks ever moves.
  assert.ok(hookFiles.length >= 3, `expected the hook set, found: ${hookFiles.join(', ') || 'none'}`);
});

test('every hook named in settings.json exists and is executable', () => {
  // The dangerous direction. Claude Code reads a non-zero exit as a block, so a
  // named-but-absent hook command does not degrade to "unenforced" -- it
  // REFUSES every matching tool call.
  for (const command of wiredCommands()) {
    const name = hookScript(command);
    if (!name) continue;
    const file = path.join(HOOKS, name);
    assert.ok(fs.existsSync(file), `settings.json names ${name}, which does not exist`);
    assert.ok((fs.statSync(file).mode & 0o111) !== 0, `${name} is not executable, so it cannot run`);
  }
});

test('every hook is wired, and every wired hook is a real file', () => {
  // A hook file nothing wires enforces nothing while looking installed.
  const wired = new Set(wiredCommands().map(hookScript).filter(Boolean));
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

test('hook tests find site-scrapers from a sibling that ALSO has a dev.sh', () => {
  // knowledge-base has its own dev.sh. The tests used to take any folder with a
  // dev.sh for site-scrapers, so from knowledge-base they queried no recipes and
  // skipped every block case while printing "all cases passed". Fixture:
  // <tmp>/knowledge-base/{dev.sh,.claude/hooks/...} beside a <tmp>/site-scrapers
  // link to this repo. Only the resolution line is asserted.
  const os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-kbfix-'));
  try {
    fs.symlinkSync(REPO, path.join(root, 'site-scrapers'));
    const kb = path.join(root, 'knowledge-base');
    const kbHooks = path.join(kb, '.claude', 'hooks');
    fs.mkdirSync(kbHooks, { recursive: true });
    fs.writeFileSync(path.join(kb, 'dev.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    for (const t of ['test-prefer-recipes.sh', 'test-troubleshooting.sh']) {
      // Only the resolution prologue runs: everything after `fails=0` up to
      // the "recipes from" echo, so no recipe query and no browser-ok marker.
      const src = fs.readFileSync(path.join(HOOKS, t), 'utf8');
      const end = src.indexOf('\nfi\n', src.indexOf('REPO="$(find_repo)"'));
      assert.ok(end > 0, `${t}: find_repo prologue not found -- did the resolution move?`);
      fs.writeFileSync(path.join(kbHooks, t), src.slice(0, end + 4), { mode: 0o755 });
      const r = require('node:child_process').spawnSync('bash', [path.join(kbHooks, t)], { encoding: 'utf8' });
      const out = `${r.stdout || ''}${r.stderr || ''}`;
      assert.match(out, /recipes from: .*\/site-scrapers\n/, `${t} from knowledge-base:\n${out}`);
      assert.doesNotMatch(out, /recipes from: .*knowledge-base/, out);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- check-hooks.sh: which hooks need a twin, on a fixture tools folder -------
//
// check-hooks.sh finds its siblings from its OWN location (the folder above it),
// so a copy placed at <tmp>/site-scrapers/check-hooks.sh checks <tmp> and never
// the real tree. Nothing real is deleted to prove a deletion is caught.

const TWINS = ['no-inline-blobs.sh', 'prefer-recipes.sh', 'troubleshooting.sh'];
const hookCmd = s => ({ type: 'command', command: `$CLAUDE_PROJECT_DIR/.claude/hooks/${s}` });

// The DECLARED list, read from the script rather than restated, so the fixture
// follows it. `.` is the top level, which every fixture already has.
const DECLARED = (() => {
  const m = /^DECLARED="([^"]*)"/m.exec(fs.readFileSync(path.join(REPO, 'check-hooks.sh'), 'utf8'));
  return m ? m[1].split(/\s+/).filter(Boolean) : [];
})();
const SIBLINGS = DECLARED.filter(l => l !== '.');

// opts.workspace: write the top-level marker and every declared sibling, as the
// real workspace has them. Without it the fixture is a STANDALONE clone: the
// top level and this repo only.
function hookFixture(opts = {}) {
  const os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-hookfix-'));
  const top = path.join(root, '.claude');
  const repo = path.join(root, 'site-scrapers');
  const script = (dir, name) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), '#!/usr/bin/env bash\n# fixture hook\nexit 0\n', { mode: 0o755 });
  };
  // Top level: the twins plus hooks that exist ONLY there, one registered with
  // mode arguments on several events, and one invented name standing in for
  // whatever top-level-only hook comes next -- no exception may name it.
  const topOnly = ['dispatch-guard.sh', 'agent-watch.sh', 'session-doctor.sh', 'future-hook.sh'];
  for (const n of [...TWINS, ...topOnly]) script(path.join(top, 'hooks'), n);
  fs.writeFileSync(path.join(top, 'settings.json'), JSON.stringify({ hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [...TWINS, 'dispatch-guard.sh', 'agent-watch.sh prespawn'].map(hookCmd) }],
    SessionStart: [{ hooks: [hookCmd('session-doctor.sh'), hookCmd('future-hook.sh --quiet')] }],
    SubagentStop: [{ hooks: [hookCmd('agent-watch.sh stop')] }],
    PostToolUse: [{ matcher: '*', hooks: [hookCmd('agent-watch.sh alert PostToolUse')] }],
  } }));
  for (const n of TWINS) script(path.join(repo, '.claude', 'hooks'), n);
  fs.writeFileSync(path.join(repo, '.claude', 'settings.json'), JSON.stringify({ hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: TWINS.map(hookCmd) }],
  } }));
  if (opts.workspace) {
    fs.writeFileSync(path.join(top, 'agents.manifest.json'), '{}');
    for (const loc of SIBLINGS) {
      for (const n of TWINS) script(path.join(root, loc, '.claude', 'hooks'), n);
      fs.writeFileSync(path.join(root, loc, '.claude', 'settings.json'), JSON.stringify({ hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: TWINS.map(hookCmd) }],
      } }));
    }
  }
  fs.copyFileSync(path.join(REPO, 'check-hooks.sh'), path.join(repo, 'check-hooks.sh'));
  fs.chmodSync(path.join(repo, 'check-hooks.sh'), 0o755);
  const run = () => {
    const r = require('node:child_process').spawnSync('bash', [path.join(repo, 'check-hooks.sh')], { encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
  };
  return { root, top, repo, run, script, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

// --- check-hooks.sh: DECLARED locations (the knowledge-base copy and its peers)

test('check-hooks: DECLARED parses and names the knowledge-base copy', () => {
  // If the regex stopped matching, every test below would build an empty
  // workspace and pass vacuously.
  assert.ok(SIBLINGS.length >= 5, `DECLARED read as: ${JSON.stringify(DECLARED)}`);
  assert.ok(DECLARED.includes('.'), 'the top level must be declared');
  assert.ok(SIBLINGS.includes('knowledge-base'), 'the knowledge-base copy must be declared');
});

test('check-hooks: a full workspace is clean and counts every declared copy', () => {
  const fx = hookFixture({ workspace: true });
  try {
    const { status, out } = fx.run();
    assert.equal(status, 0, out);
    assert.match(out, /declared locations \(workspace/);
    assert.match(out, /ok\s+knowledge-base\/\.claude\/hooks/);
    assert.doesNotMatch(out, /UNCHECKED|ERROR/);
    // top level + this repo + every sibling
    assert.match(out, new RegExp(`prefer-recipes\\.sh \\(${SIBLINGS.length + 2} copies\\)`));
  } finally { fx.cleanup(); }
});

test('check-hooks: a DRIFTED knowledge-base copy fails and is named', () => {
  const fx = hookFixture({ workspace: true });
  try {
    fs.appendFileSync(path.join(fx.root, 'knowledge-base', '.claude', 'hooks', 'prefer-recipes.sh'), 'echo drifted\n');
    const { status, out } = fx.run();
    assert.equal(status, 1, out);
    assert.match(out, /prefer-recipes\.sh has DRIFTED/);
    assert.match(out, /knowledge-base\/\.claude\/hooks\/prefer-recipes\.sh/);
  } finally { fx.cleanup(); }
});

test('check-hooks: a comment-only difference in the knowledge-base copy is NOT drift', () => {
  // Compared on meaning: each copy's header describes its own location.
  const fx = hookFixture({ workspace: true });
  try {
    fs.appendFileSync(path.join(fx.root, 'knowledge-base', '.claude', 'hooks', 'prefer-recipes.sh'), '# knowledge-base copy\n\n');
    const { status, out } = fx.run();
    assert.equal(status, 0, out);
    assert.doesNotMatch(out, /DRIFTED/);
  } finally { fx.cleanup(); }
});

test('check-hooks: one hook missing from knowledge-base fails', () => {
  const fx = hookFixture({ workspace: true });
  try {
    fs.rmSync(path.join(fx.root, 'knowledge-base', '.claude', 'hooks', 'troubleshooting.sh'));
    const { status, out } = fx.run();
    assert.equal(status, 1, out);
    assert.match(out, /ERROR\s+troubleshooting\.sh is missing from: knowledge-base\/\.claude\/hooks/);
  } finally { fx.cleanup(); }
});

test('check-hooks: the WHOLE knowledge-base hook folder gone is reported, not skipped', () => {
  // The case discovery alone missed: the remaining copies agree, so before
  // DECLARED this printed "clean" with one copy fewer.
  for (const gone of [['knowledge-base', '.claude', 'hooks'], ['knowledge-base']]) {
    const fx = hookFixture({ workspace: true });
    try {
      fs.rmSync(path.join(fx.root, ...gone), { recursive: true });
      const { status, out } = fx.run();
      assert.equal(status, 1, `removing ${gone.join('/')}:\n${out}`);
      assert.match(out, /ERROR\s+knowledge-base\/\.claude\/hooks is DECLARED but absent/);
      assert.doesNotMatch(out, /hooks: clean/);
    } finally { fx.cleanup(); }
  }
});

test('check-hooks: STANDALONE, an absent sibling is UNCHECKED out loud, not passed silently', () => {
  // A fresh clone of site-scrapers alone: no marker, no siblings. Exit 0, but
  // every absent declared copy is named, and the final line -- the one
  // `./dev.sh check` shows -- counts them.
  const fx = hookFixture();
  try {
    const { status, out } = fx.run();
    assert.equal(status, 0, out);
    assert.match(out, /declared locations \(standalone/);
    for (const loc of SIBLINGS) {
      assert.match(out, new RegExp(`UNCHECKED\\s+${loc.replace(/[.]/g, '\\.')}/\\.claude/hooks is declared but absent`), `${loc} not reported`);
    }
    const last = out.trim().split('\n').pop();
    assert.match(last, new RegExp(`${SIBLINGS.length} declared locations UNCHECKED`), last);
  } finally { fx.cleanup(); }
});

test('check-hooks: a copy found but NOT declared is an error in the workspace, a note standalone', () => {
  for (const workspace of [true, false]) {
    const fx = hookFixture({ workspace });
    try {
      for (const n of TWINS) fx.script(path.join(fx.root, 'newTool', '.claude', 'hooks'), n);
      fs.writeFileSync(path.join(fx.root, 'newTool', '.claude', 'settings.json'), JSON.stringify({ hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: TWINS.map(hookCmd) }],
      } }));
      const { status, out } = fx.run();
      assert.match(out, workspace ? /ERROR\s+newTool\/\.claude\/hooks holds twinned hooks/ : /note\s+newTool\/\.claude\/hooks holds twinned hooks/, out);
      assert.equal(status, workspace ? 1 : 0, out);
    } finally { fx.cleanup(); }
  }
});

test('check-hooks: top-level-only hooks and their arguments raise no error', () => {
  const fx = hookFixture();
  try {
    const { status, out } = fx.run();
    assert.equal(status, 0, `expected a clean check:\n${out}`);
    assert.doesNotMatch(out, /ERROR/);
    assert.match(out, /hooks: clean/);
    // An argument is never a hook name: not prespawn, stop, alert or --quiet.
    assert.doesNotMatch(out, /names (prespawn|stop|alert|PostToolUse|--quiet)\b/);
    for (const n of ['dispatch-guard.sh', 'agent-watch.sh', 'session-doctor.sh', 'future-hook.sh']) {
      assert.match(out, new RegExp(`${n.replace('.', '\\.')} is local to: \\.claude/hooks`), `${n} should be reported as local`);
    }
    // Wired on non-PreToolUse events counts as wired.
    assert.doesNotMatch(out, /present but not wired/);
  } finally { fx.cleanup(); }
});

test('check-hooks: deleting the TOP-LEVEL copy of a twin still fails', () => {
  const fx = hookFixture();
  try {
    fs.rmSync(path.join(fx.top, 'hooks', 'prefer-recipes.sh'));
    const { status, out } = fx.run();
    assert.equal(status, 1, out);
    assert.match(out, /ERROR\s+prefer-recipes\.sh is missing from: \.claude\/hooks\b/);
  } finally { fx.cleanup(); }
});

test('check-hooks: deleting THIS repo\'s copy of a twin still fails', () => {
  const fx = hookFixture();
  try {
    fs.rmSync(path.join(fx.repo, '.claude', 'hooks', 'troubleshooting.sh'));
    const { status, out } = fx.run();
    assert.equal(status, 1, out);
    assert.match(out, /site-scrapers\/\.claude\/settings\.json names troubleshooting\.sh but it does not exist/);
    assert.match(out, /troubleshooting\.sh is missing from: site-scrapers\/\.claude\/hooks/);
  } finally { fx.cleanup(); }
});

test('check-hooks: a twin whose logic drifted from its top-level copy fails', () => {
  const fx = hookFixture();
  try {
    fs.appendFileSync(path.join(fx.top, 'hooks', 'no-inline-blobs.sh'), 'echo drifted\n');
    const { status, out } = fx.run();
    assert.equal(status, 1, out);
    assert.match(out, /no-inline-blobs\.sh has DRIFTED/);
  } finally { fx.cleanup(); }
});

test('check-hooks: a missing script registered WITH arguments is named by its script', () => {
  const fx = hookFixture();
  try {
    fs.rmSync(path.join(fx.top, 'hooks', 'agent-watch.sh'));
    const { status, out } = fx.run();
    assert.equal(status, 1, out);
    assert.match(out, /names agent-watch\.sh but it does not exist/);
    assert.doesNotMatch(out, /names (prespawn|stop|alert)\b/);
  } finally { fx.cleanup(); }
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

// --- test.sh: quiet for a reader, complete for the gate ---------------------

test('a failing run is detected on BOTH the quiet and the verbose path', () => {
  // test.sh's default output is filtered down to failures plus counts, because
  // it is read far more often by a model than a person. lib/gate.js asks for
  // --verbose instead, so the reader-facing filter cannot influence what the
  // gate sees. This asserts the thing that actually matters either way: a real
  // failure is still counted. A gate that silently reported zero failures
  // would wave a broken change straight through.
  const { parseTap } = require('../lib/gate');
  const os = require('node:os');
  // Written outside test/ and not matching *.test.js in this directory, so the
  // suite never collects it as one of its own and fails forever.
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-tap-')), 'deliberate.test.js');
  fs.writeFileSync(
    tmp,
    "const test=require('node:test');const assert=require('node:assert/strict');\n" +
      "test('passes and should be invisible',()=>{assert.equal(1,1)});\n" +
      "test('fails and must be loud',()=>{assert.equal('got','wanted','the extraction returned the wrong field')});\n"
  );

  const run = args => {
    const r = require('node:child_process').spawnSync(path.join(REPO, 'test.sh'), args, {
      encoding: 'utf8',
    });
    return `${r.stdout || ''}${r.stderr || ''}`;
  };
  const quiet = run([tmp]);
  const verbose = run(['--verbose', tmp]);
  fs.rmSync(path.dirname(tmp), { recursive: true, force: true });

  for (const [label, out] of [['quiet', quiet], ['verbose', verbose]]) {
    const parsed = parseTap(out);
    assert.equal(parsed.failed, 1, `${label}: parseTap must see the failure`);
    assert.equal(parsed.passed, 1, `${label}: parseTap must see the pass`);
    assert.deepEqual(parsed.failures, ['fails and must be loud'], `${label}: the failing test must be named`);
  }

  // Loud on failure: the assertion message has to survive the filter, or a
  // quiet run tells you something broke without telling you what.
  assert.match(quiet, /the extraction returned the wrong field/, 'quiet mode must still show why it failed');

  // Quiet on success: the passing test must not appear at all, and verbose
  // must still carry it. Asserted as presence/absence rather than as a size
  // ratio -- the saving is proportional to the number of PASSING tests, so on
  // a two-test fixture the failure block dominates and a ratio says nothing.
  // The real size claim is the all-pass case in the next test.
  assert.doesNotMatch(quiet, /^\s*ok \d+ - passes and should be invisible/m, 'a passing test must be invisible');
  assert.match(verbose, /^\s*ok \d+ - passes and should be invisible/m, 'verbose must still carry every pass');
});

test('a fully passing run says almost nothing', () => {
  const os = require('node:os');
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-tap-')), 'allpass.test.js');
  fs.writeFileSync(
    tmp,
    "const test=require('node:test');const assert=require('node:assert/strict');\n" +
      Array.from({ length: 12 }, (_, i) => `test('case ${i}',()=>{assert.ok(true)});`).join('\n')
  );
  const r = require('node:child_process').spawnSync(path.join(REPO, 'test.sh'), [tmp], { encoding: 'utf8' });
  fs.rmSync(path.dirname(tmp), { recursive: true, force: true });

  const lines = (r.stdout || '').trim().split('\n').filter(Boolean);
  assert.equal(r.status, 0, 'a passing run exits 0');
  // 12 tests in, three lines out. The zero-valued cancelled/skipped/todo lines
  // are dropped too -- they are noise when there is nothing to report.
  assert.ok(lines.length <= 3, `expected at most 3 lines from a clean run, got ${lines.length}:\n${lines.join('\n')}`);
  assert.match(r.stdout, /^# pass 12$/m);
  assert.match(r.stdout, /^# fail 0$/m);
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
