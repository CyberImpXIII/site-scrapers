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
    let out = '';
    try {
      out = execFileSync('bash', [testScript], { encoding: 'utf8', stdio: 'pipe', timeout: 240000 });
    } catch (e) {
      assert.fail(`test-${name} failed:\n${(e.stdout || '') + (e.stderr || '')}`);
    }
    // A pass is only a pass if it read THIS repo's recipes. Skips are allowed
    // only for fixtures this DB genuinely lacks (a fresh clone has none); the
    // mock-workspace tests below cover every case with a fixed table.
    const m = /^recipes from: (.*)$/m.exec(out);
    if (m) assert.equal(fs.realpathSync(m[1]), fs.realpathSync(REPO), `test-${name} read recipes from ${m[1]}`);
  }
});

// --- the hooks from OTHER tool folders, on a mock workspace -------------------
//
// Each copy resolves site-scrapers from its own location, so identical bytes
// can still enforce nothing. Two siblings fooled it in turn: knowledge-base (it
// has a dev.sh) and scriptingTools/data-bridge (it has dev.sh, engine.js AND
// query.js). From data-bridge the LIVE hook allowed a covered host, and the
// tests skipped every block case and printed "all cases passed".
//
// Mock: <tmp>/site-scrapers is test/fixtures/hook-workspace/site-scrapers (a
// fake dev.sh and query.js over a fixed recipe table, so no real DB), beside a
// data-bridge-shaped and a knowledge-base-shaped sibling holding copies of the
// real hooks and their tests.

const { spawn, spawnSync } = require('node:child_process');
const FIXTURE_SS = path.join(__dirname, 'fixtures', 'hook-workspace', 'site-scrapers');
const RECIPE_HOOKS = ['prefer-recipes.sh', 'troubleshooting.sh'];

function mockWorkspace() {
  const os = require('node:os');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-mockws-')));
  const ss = path.join(root, 'site-scrapers');
  fs.cpSync(FIXTURE_SS, ss, { recursive: true });
  fs.mkdirSync(path.join(ss, 'data'));
  const bridge = path.join(root, 'scriptingTools', 'data-bridge');
  const kb = path.join(root, 'knowledge-base');
  fs.mkdirSync(bridge, { recursive: true });
  fs.mkdirSync(kb, { recursive: true });
  // The decoys: what each sibling has that a looser rule mistook for site-scrapers.
  for (const f of ['dev.sh', 'engine.js', 'query.js']) fs.writeFileSync(path.join(bridge, f), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bridge, 'package.json'), '{"name":"data-bridge"}');
  fs.writeFileSync(path.join(kb, 'dev.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  const where = {};
  for (const [label, dir] of [['site-scrapers', ss], ['data-bridge', bridge], ['knowledge-base', kb]]) {
    const h = path.join(dir, '.claude', 'hooks');
    fs.mkdirSync(h, { recursive: true });
    for (const n of RECIPE_HOOKS) for (const f of [n, `test-${n}`]) {
      fs.copyFileSync(path.join(HOOKS, f), path.join(h, f));
      fs.chmodSync(path.join(h, f), 0o755);
    }
    where[label] = h;
  }
  return { root, ss, where, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const env = extra => ({ ...process.env, SS_BROWSER_OK: '', ...extra });
const webfetch = host => JSON.stringify({ tool_name: 'WebFetch', tool_input: { url: `https://${host}/jobs` } });

test('the LIVE prefer-recipes hook blocks a covered host from every sibling, data-bridge included', () => {
  const ws = mockWorkspace();
  try {
    for (const [label, h] of Object.entries(ws.where)) {
      const r = spawnSync('bash', [path.join(h, 'prefer-recipes.sh')], { input: webfetch('example.com'), encoding: 'utf8', env: env() });
      assert.equal(r.status, 2, `from ${label}: expected a block on a covered host, got exit ${r.status}\n${r.stdout}${r.stderr}`);
      const ok = spawnSync('bash', [path.join(h, 'prefer-recipes.sh')], { input: webfetch('unknown.test'), encoding: 'utf8', env: env() });
      assert.equal(ok.status, 0, `from ${label}: an unknown host must be allowed`);
    }
  } finally { ws.cleanup(); }
});

test('the hook TESTS run every case from every sibling: they resolve site-scrapers, never skip-and-pass', () => {
  const ws = mockWorkspace();
  try {
    for (const [label, h] of Object.entries(ws.where)) {
      for (const n of RECIPE_HOOKS) {
        const r = spawnSync('bash', [path.join(h, `test-${n}`)], { encoding: 'utf8', env: env(), timeout: 120000 });
        const out = `${r.stdout || ''}${r.stderr || ''}`;
        assert.equal(r.status, 0, `test-${n} from ${label}:\n${out}`);
        assert.ok(out.includes(`recipes from: ${ws.ss}\n`), `test-${n} from ${label} resolved elsewhere:\n${out}`);
        // The fixture table has a working, a broken and a blocked-attn recipe,
        // so the only case allowed to skip is prefer-recipes' subdomain one.
        const skips = out.split('\n').filter(l => /^\s+SKIP/.test(l) && !/subdomain/.test(l));
        assert.deepEqual(skips, [], `test-${n} from ${label} skipped cases it has fixtures for:\n${out}`);
      }
    }
  } finally { ws.cleanup(); }
});

// Contract changed 2026-10-05 with the copies themselves: tools/hooks/source
// (79703b6) reports "site-scrapers not found" as UNCHECKED, exit 3, where the
// old copies said FAIL, exit 1. The copies were re-rendered from that source by
// `tools/setup/setup site-scrapers --only hooks --rebuild` (Jacob's yes,
// PLAN-repo-setup.md §7.12), so this asserts the source's contract. What it
// guards is unchanged: a run that tested no recipes never exits 0 and never
// says "all cases passed".
test('the hook tests do NOT pass (UNCHECKED, exit 3) when site-scrapers cannot be found; the hook itself fails open', () => {
  const ws = mockWorkspace();
  try {
    fs.rmSync(ws.ss, { recursive: true });
    for (const n of RECIPE_HOOKS) {
      const r = spawnSync('bash', [path.join(ws.where['data-bridge'], `test-${n}`)], { encoding: 'utf8', env: env(), timeout: 120000 });
      const out = `${r.stdout || ''}${r.stderr || ''}`;
      assert.equal(r.status, 3, `test-${n} must report UNCHECKED (exit 3) with no site-scrapers:\n${out}`);
      assert.match(out, /UNCHECKED\s+site-scrapers not found/);
      assert.doesNotMatch(out, /recipes from:/);
      assert.doesNotMatch(out, /all cases passed/);
    }
    const live = spawnSync('bash', [path.join(ws.where['data-bridge'], 'prefer-recipes.sh')], { input: webfetch('example.com'), encoding: 'utf8', env: env() });
    assert.equal(live.status, 0, 'with no site-scrapers the hook must fail OPEN');
  } finally { ws.cleanup(); }
});

test('concurrent hook-test runs neither race nor touch a REAL browser-ok override', async () => {
  // Six owners synced and ran test-prefer-recipes.sh at once: they wrote and
  // deleted the one live marker under each other (3 of 4 parallel runs failed
  // here on 2026-10-02), and every run deleted any override Jacob had open.
  const ws = mockWorkspace();
  try {
    const live = path.join(ws.ss, 'data', '.browser-ok');
    const content = `${Math.floor(Date.now() / 1000)}\n15\n`;
    fs.writeFileSync(live, content); // a real, fresh override
    const run = () => new Promise(resolve => {
      const p = spawn('bash', [path.join(ws.where['data-bridge'], 'test-prefer-recipes.sh')], { env: env() });
      let out = '';
      p.stdout.on('data', d => { out += d; });
      p.stderr.on('data', d => { out += d; });
      p.on('close', status => resolve({ status, out }));
    });
    const results = await Promise.all([run(), run(), run(), run()]);
    for (const r of results) assert.equal(r.status, 0, r.out);
    // Untouched, and never READ either: had the hook seen this fresh override,
    // the block cases above would have exited 0 and failed.
    assert.equal(fs.readFileSync(live, 'utf8'), content, 'the real override was rewritten or deleted');
  } finally { ws.cleanup(); }
});

test('the real dev.sh browser-ok writes where SS_BROWSER_OK says, not the live marker', () => {
  const os = require('node:os');
  const priv = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-bok-')), 'marker');
  const live = path.join(REPO, 'data', '.browser-ok');
  const before = fs.existsSync(live) ? fs.readFileSync(live, 'utf8') : null;
  try {
    spawnSync(path.join(REPO, 'dev.sh'), ['browser-ok', '1'], { cwd: REPO, encoding: 'utf8', env: env({ SS_BROWSER_OK: priv }) });
    const lines = fs.existsSync(priv) ? fs.readFileSync(priv, 'utf8').trim().split('\n') : [];
    assert.equal(lines.length, 2, 'expected <epoch>\\n<minutes> in the private marker');
    assert.equal(lines[1], '1');
    const after = fs.existsSync(live) ? fs.readFileSync(live, 'utf8') : null;
    if (before === null && after !== null) fs.rmSync(live); // undo what a regression opened
    assert.equal(after, before, 'browser-ok touched the live marker despite SS_BROWSER_OK');
  } finally { fs.rmSync(path.dirname(priv), { recursive: true, force: true }); }
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
  // deep-work's applications repo (2026-10-03) carries the three twins too.
  assert.ok(SIBLINGS.includes('applications'), 'the applications copy must be declared');
  // 2026-10-03: addon-bench and tools/setup (a NESTED repo) carry the twins too.
  assert.ok(SIBLINGS.includes('addon-bench'), 'the addon-bench copy must be declared');
  assert.ok(SIBLINGS.includes('tools/setup'), 'the tools/setup copy must be declared');
  // 2026-10-04: four more nested repos under tools/ carry the twins (td-7).
  for (const loc of ['tools/checks', 'tools/hooks', 'tools/hub', 'tools/todo']) {
    assert.ok(SIBLINGS.includes(loc), `the ${loc} copy must be declared`);
  }
});

// The copies added 2026-10-03 (one flat, one nested) and 2026-10-04 (four
// nested under tools/): each must be able to FAIL the check, or declaring it
// bought nothing.
const NEW_COPIES = ['addon-bench', 'tools/setup', 'tools/checks', 'tools/hooks', 'tools/hub', 'tools/todo'];
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

test('check-hooks: a DRIFTED addon-bench or tools/setup copy fails and is named', () => {
  for (const loc of NEW_COPIES) {
    for (const name of TWINS) {
      const fx = hookFixture({ workspace: true });
      try {
        fs.appendFileSync(path.join(fx.root, loc, '.claude', 'hooks', name), 'echo drifted\n');
        const { status, out } = fx.run();
        assert.equal(status, 1, `${loc}/${name}:\n${out}`);
        assert.match(out, new RegExp(`${reEsc(name)} has DRIFTED`));
        assert.match(out, new RegExp(`${reEsc(loc)}/\\.claude/hooks/${reEsc(name)}`));
      } finally { fx.cleanup(); }
    }
  }
});

test('check-hooks: a twin missing from addon-bench or tools/setup fails', () => {
  for (const loc of NEW_COPIES) {
    const fx = hookFixture({ workspace: true });
    try {
      fs.rmSync(path.join(fx.root, loc, '.claude', 'hooks', 'prefer-recipes.sh'));
      const { status, out } = fx.run();
      assert.equal(status, 1, out);
      assert.match(out, new RegExp(`ERROR\\s+prefer-recipes\\.sh is missing from: ${reEsc(loc)}/\\.claude/hooks`));
    } finally { fx.cleanup(); }
  }
});

// A declared location is checked wherever it is. Discovery stops at depth 4
// below the tools folder; a declared copy deeper than that used to read "ok"
// in section 0 (its directory exists) while nothing compared, probed or synced
// it. The fixture's check-hooks.sh copy gets one extra, deep DECLARED entry.
function withDeepDeclared(fx, deep) {
  const f = path.join(fx.repo, 'check-hooks.sh');
  const src = fs.readFileSync(f, 'utf8');
  const patched = src.replace(/^DECLARED="([^"]*)"/m, (_, l) => `DECLARED="${l} ${deep}"`);
  assert.notEqual(patched, src, 'could not patch DECLARED in the fixture copy');
  fs.writeFileSync(f, patched);
  for (const n of TWINS) fx.script(path.join(fx.root, deep, '.claude', 'hooks'), n);
  fs.writeFileSync(path.join(fx.root, deep, '.claude', 'settings.json'), JSON.stringify({ hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: TWINS.map(hookCmd) }],
  } }));
}

test('check-hooks: a declared copy deeper than discovery reaches is still compared, and its drift fails', () => {
  const deep = 'a/b/c/deeptool';
  const fx = hookFixture({ workspace: true });
  try {
    withDeepDeclared(fx, deep);
    let { status, out } = fx.run();
    assert.equal(status, 0, out);
    // top level + this repo + every sibling + the deep one
    assert.match(out, new RegExp(`prefer-recipes\\.sh \\(${SIBLINGS.length + 3} copies\\)`), out);
    fs.appendFileSync(path.join(fx.root, deep, '.claude', 'hooks', 'troubleshooting.sh'), 'echo drifted\n');
    ({ status, out } = fx.run());
    assert.equal(status, 1, out);
    assert.match(out, new RegExp(`${reEsc(deep)}/\\.claude/hooks/troubleshooting\\.sh`));
  } finally { fx.cleanup(); }
});

test('check-hooks --sync reaches a declared copy deeper than discovery, and only the set it checks', () => {
  const deep = 'a/b/c/deeptool';
  const fx = hookFixture({ workspace: true });
  try {
    withDeepDeclared(fx, deep);
    const target = path.join(fx.root, deep, '.claude', 'hooks', 'troubleshooting.sh');
    fs.appendFileSync(target, 'echo drifted\n');
    const r = require('node:child_process').spawnSync('bash', [path.join(fx.repo, 'check-hooks.sh'), '--sync'], { encoding: 'utf8' });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    assert.match(out, new RegExp(`synced troubleshooting\\.sh -> ${reEsc(deep)}/\\.claude/hooks`), out);
    assert.equal(fs.readFileSync(target, 'utf8'), fs.readFileSync(path.join(fx.repo, '.claude', 'hooks', 'troubleshooting.sh'), 'utf8'));
    assert.equal(r.status, 0, out);
  } finally { fx.cleanup(); }
});

test('check-hooks: a full workspace is clean and counts every declared copy', () => {
  const fx = hookFixture({ workspace: true });
  try {
    const { status, out } = fx.run();
    assert.equal(status, 0, out);
    assert.match(out, /declared locations \(workspace/);
    assert.match(out, /ok\s+knowledge-base\/\.claude\/hooks/);
    assert.doesNotMatch(out, /ERROR|UNCHECKED\s+\S+\/\.claude\/hooks is declared/);
    // No recipes in this fixture, so the enforcement probe says so out loud.
    assert.match(out.trim().split('\n').pop(), /enforcement UNCHECKED/);
    // top level + this repo + every sibling
    assert.match(out, new RegExp(`prefer-recipes\\.sh \\(${SIBLINGS.length + 2} copies\\)`));
  } finally { fx.cleanup(); }
});

// Give the fixture repo the mock recipe table (working: example.com) so the
// enforcement probe has a host to probe with.
function withRecipes(fx) {
  for (const f of ['dev.sh', 'query.js', 'package.json']) {
    fs.copyFileSync(path.join(FIXTURE_SS, f), path.join(fx.repo, f));
  }
  fs.chmodSync(path.join(fx.repo, 'dev.sh'), 0o755);
}

test('check-hooks: a copy that is present, identical and does NOT block is an ERROR', () => {
  // The fixture hooks are `exit 0` stubs: logic-identical everywhere, so the
  // drift check is clean -- exactly data-bridge's state before the fix.
  const fx = hookFixture({ workspace: true });
  try {
    withRecipes(fx);
    const { status, out } = fx.run();
    assert.equal(status, 1, out);
    assert.match(out, /ERROR\s+scriptingTools\/data-bridge\/\.claude\/hooks\/prefer-recipes\.sh does NOT enforce from there: exit 0 on example\.com/);
    assert.doesNotMatch(out, /DRIFTED/);
  } finally { fx.cleanup(); }
});

test('check-hooks: the REAL prefer-recipes.sh blocks from every declared location, beside a data-bridge decoy', () => {
  const fx = hookFixture({ workspace: true });
  try {
    withRecipes(fx);
    const bridge = path.join(fx.root, 'scriptingTools', 'data-bridge');
    for (const f of ['dev.sh', 'engine.js', 'query.js']) fs.writeFileSync(path.join(bridge, f), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    for (const d of [fx.top, ...SIBLINGS.map(l => path.join(fx.root, l, '.claude')), path.join(fx.repo, '.claude')]) {
      fs.copyFileSync(path.join(HOOKS, 'prefer-recipes.sh'), path.join(d, 'hooks', 'prefer-recipes.sh'));
    }
    const { status, out } = fx.run();
    assert.equal(status, 0, out);
    assert.match(out, /ok\s+scriptingTools\/data-bridge\/\.claude\/hooks\/prefer-recipes\.sh blocks example\.com/);
    assert.match(out, /hooks: clean/);
    assert.doesNotMatch(out, /enforcement UNCHECKED/);
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

test('check-hooks: the WHOLE knowledge-base or applications hook folder gone is reported, not skipped', () => {
  // The case discovery alone missed: the remaining copies agree, so before
  // DECLARED this printed "clean" with one copy fewer.
  // [path removed, the declared location it takes away]
  const cases = [
    [['knowledge-base', '.claude', 'hooks'], 'knowledge-base'], [['knowledge-base'], 'knowledge-base'],
    [['applications', '.claude', 'hooks'], 'applications'], [['applications'], 'applications'],
    [['addon-bench', '.claude', 'hooks'], 'addon-bench'], [['addon-bench'], 'addon-bench'],
    [['tools', 'setup', '.claude', 'hooks'], 'tools/setup'], [['tools', 'setup'], 'tools/setup'],
    ...['checks', 'hooks', 'hub', 'todo'].flatMap(t => [
      [['tools', t, '.claude', 'hooks'], `tools/${t}`], [['tools', t], `tools/${t}`],
    ]),
    // The whole tools/ folder: every nested repo under it is named, not just one.
    [['tools'], ['tools/setup', 'tools/checks', 'tools/hooks', 'tools/hub', 'tools/todo']],
  ];
  for (const [gone, locs] of cases) {
    const fx = hookFixture({ workspace: true });
    try {
      fs.rmSync(path.join(fx.root, ...gone), { recursive: true });
      const { status, out } = fx.run();
      assert.equal(status, 1, `removing ${gone.join('/')}:\n${out}`);
      for (const loc of [].concat(locs)) {
        assert.match(out, new RegExp(`ERROR\\s+${reEsc(loc)}/\\.claude/hooks is DECLARED but absent`), `removing ${gone.join('/')}: ${loc}\n${out}`);
      }
      assert.doesNotMatch(out, /hooks: clean/);
    } finally { fx.cleanup(); }
  }
});

// --- check-hooks.sh: "settings.json not applied yet" vs a real fault ----------
//
// A new tool repo ships `.claude/settings.proposed.json` and Jacob copies it to
// settings.json himself. Until he does, the hooks there do not run -- still an
// ERROR -- but it is HIS step, not drift, and the output must say which is which.
// It counts as "not applied yet" only when the proposal is something worth
// applying: valid JSON that wires every twin present there, each of which
// exists, parses and fails open. Anything less is a real fault.

function proposeInstead(fx, loc, proposal) {
  const dir = path.join(fx.root, loc, '.claude');
  fs.rmSync(path.join(dir, 'settings.json'));
  if (proposal !== undefined) {
    fs.writeFileSync(path.join(dir, 'settings.proposed.json'),
      typeof proposal === 'string' ? proposal : JSON.stringify(proposal));
  }
}
const proposalOf = names => ({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: names.map(hookCmd) }] } });
const lastLine = out => out.trim().split('\n').pop();

test('check-hooks: a valid settings.proposed.json not yet applied is labelled as Jacob\'s step, not drift', () => {
  const fx = hookFixture({ workspace: true });
  try {
    proposeInstead(fx, 'tools/todo', proposalOf(TWINS));
    const { status, out } = fx.run();
    assert.equal(status, 1, out); // the hooks there still do not run
    assert.match(out, /ERROR\s+\[not applied yet\] tools\/todo\/\.claude: no settings\.json; settings\.proposed\.json is valid/, out);
    assert.doesNotMatch(out, /DRIFTED|is missing from/);
    assert.match(lastLine(out), /^hooks: 1 ERROR -- 0 real; 1 only settings\.json not applied yet \(Jacob's step: copy settings\.proposed\.json to settings\.json in tools\/todo\/\.claude\)$/, out);
  } finally { fx.cleanup(); }
});

test('check-hooks: pending settings and real drift together are counted apart', () => {
  const fx = hookFixture({ workspace: true });
  try {
    proposeInstead(fx, 'tools/hub', proposalOf(TWINS));
    proposeInstead(fx, 'tools/checks', proposalOf(TWINS));
    fs.appendFileSync(path.join(fx.root, 'tools', 'hooks', '.claude', 'hooks', 'prefer-recipes.sh'), 'echo drifted\n');
    const { status, out } = fx.run();
    assert.equal(status, 1, out);
    assert.match(out, /prefer-recipes\.sh has DRIFTED/);
    assert.match(lastLine(out), /^hooks: 3 ERRORS -- 1 real; 2 only settings\.json not applied yet \(Jacob's step: copy settings\.proposed\.json to settings\.json in tools\/checks\/\.claude tools\/hub\/\.claude\)$/, out);
  } finally { fx.cleanup(); }
});

test('check-hooks: no settings.json and NO proposal is a real error, unlabelled', () => {
  const fx = hookFixture({ workspace: true });
  try {
    proposeInstead(fx, 'tools/todo');
    const { status, out } = fx.run();
    assert.equal(status, 1, out);
    assert.match(out, /ERROR\s+tools\/todo\/\.claude\/hooks has hooks but no settings\.json/);
    assert.doesNotMatch(out, /not applied yet/);
    assert.match(lastLine(out), /^hooks: 1 ERROR$/);
  } finally { fx.cleanup(); }
});

test('check-hooks: a proposal that would not work is a real error, never "not applied yet"', () => {
  const cases = [
    ['not json {', /settings\.proposed\.json is not valid JSON/],
    [proposalOf(['no-inline-blobs.sh', 'troubleshooting.sh']), /settings\.proposed\.json does not wire: prefer-recipes\.sh/],
    [proposalOf([...TWINS, 'ghost.sh']), /tools\/todo\/\.claude\/settings\.proposed\.json names ghost\.sh but it does not exist/],
  ];
  for (const [proposal, why] of cases) {
    const fx = hookFixture({ workspace: true });
    try {
      proposeInstead(fx, 'tools/todo', proposal);
      const { status, out } = fx.run();
      assert.equal(status, 1, out);
      assert.match(out, why, out);
      assert.doesNotMatch(out, /\[not applied yet\]/, out);
      assert.match(lastLine(out), /^hooks: \d+ ERRORS?$/, out);
    } finally { fx.cleanup(); }
  }
  // A proposed hook that does not fail open makes the proposal unfit too.
  const fx = hookFixture({ workspace: true });
  try {
    proposeInstead(fx, 'tools/todo', proposalOf(TWINS));
    fs.writeFileSync(path.join(fx.root, 'tools', 'todo', '.claude', 'hooks', 'troubleshooting.sh'), '#!/usr/bin/env bash\nexit 3\n', { mode: 0o755 });
    const { status, out } = fx.run();
    assert.equal(status, 1, out);
    assert.match(out, /tools\/todo\/\.claude\/hooks\/troubleshooting\.sh does not fail open/);
    assert.doesNotMatch(out, /\[not applied yet\]/, out);
  } finally { fx.cleanup(); }
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
