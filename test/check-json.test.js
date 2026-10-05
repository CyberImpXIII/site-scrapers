// `./dev.sh check --json` in the one schema every repo prints (the shared
// checks tool holds it, tools/checks/schema/check-json.schema.json;
// PLAN-agent-groups.md §4.4): one check per gate, each finding line of a red
// gate a failure with message, file, line and role (devtools/checkjson.js,
// called by dev.sh). Modelled on applications' tests/test_checkjson.py: the same
// shape, row format and mutant table.
//
// Anywhere: canned gate outputs, in the shapes this repo's gates print them,
// give the reviewed fixtures test/fixtures/check-red.json and check-green.json
// exactly; the exit agrees with `ok`; dev.sh wires each gate through the helper
// (a copy with canned gates, one of which assigns the loop's own variables); a
// hooks run that compared less than it says is `unchecked`, never ok; the audit
// gate exits 1 on an unwaived error and 2 on a broken audit. Mutants: one per
// shape rule the emitter can break, each applied to a throwaway copy, must change
// the output (anywhere) and fail the real validator under that rule (in the
// workspace). The validator is the shared checks CLI, run as a subprocess on a
// scratch repo. No copy of the schema or its validator lives here.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');
const HELPER = path.join(ROOT, 'devtools', 'checkjson.js');
const AUDIT_LINES = path.join(ROOT, 'devtools', 'auditlines.js');
const NODE = process.execPath;
// The validator sets this while it runs a repo's suite, and answers UNCHECKED
// to a run nested inside it. Its guard, its decision: a nested validator test
// is skipped, saying so.
const GUARD = 'CHECKS_CHECK_JSON_ACTIVE';

function checksCli() {
  for (let d = path.dirname(ROOT); d !== path.dirname(d); d = path.dirname(d)) {
    const cli = path.join(d, 'tools', 'checks', 'checks');
    try { fs.accessSync(cli, fs.constants.X_OK); return cli; } catch { /* keep looking */ }
  }
  return null;
}
const CHECKS_CLI = checksCli();
const LONE = 'no shared checks CLI in a workspace around this repo (a lone clone)';

// A red test.sh run, as node:test prints it (captured from a real run on
// 2026-10-05 and trimmed): a top-level failure, a describe's child (the parent's
// subtestsFailed line is not a finding of its own), a file that would not load.
const TAP_RED = [
  `not ok 1 - ${ROOT}/test/gone.test.js`,
  '  ---',
  '  duration_ms: 660.2',
  "  type: 'test'",
  `  location: '${ROOT}/test/gone.test.js:1:1'`,
  "  failureType: 'testCodeFailure'",
  "  error: 'test failed'",
  '  ...',
  'not ok 3 - top-level fails',
  '  ---',
  `  location: '${ROOT}/test/check-json.test.js:5:1'`,
  "  failureType: 'testCodeFailure'",
  '  error: |-',
  '    Expected values to be strictly equal:',
  '    ',
  '    1 !== 2',
  '    ',
  "  code: 'ERR_ASSERTION'",
  '  stack: |-',
  `    TestContext.<anonymous> (${ROOT}/test/check-json.test.js:5:38)`,
  '  ...',
  '    not ok 1 - inner fails',
  '      ---',
  `      location: '${ROOT}/test/check-json.test.js:7:8'`,
  "      failureType: 'testCodeFailure'",
  "      error: 'it''s boom'",
  '      ...',
  'not ok 4 - group',
  '  ---',
  `  location: '${ROOT}/test/check-json.test.js:6:6'`,
  "  failureType: 'subtestsFailed'",
  "  error: '1 subtest failed'",
  '  ...',
  '# tests 7',
  '# pass 2',
  '# fail 3',
  '',
].join('\n');

// check-hooks.sh, red: two real errors (one with its drifted copies under it),
// a Jacob's-step one, a note and an UNCHECKED that are not findings.
const HOOKS_RED = [
  'logic identical across copies:',
  '  ok     no-inline-blobs.sh (9 copies)',
  '  ERROR  prefer-recipes.sh has DRIFTED — 2 different implementations across 9 copies:',
  '           1111aaaa  site-scrapers/.claude/hooks/prefer-recipes.sh',
  '           2222bbbb  .claude/hooks/prefer-recipes.sh',
  '  note   knowledge-base/.claude/hooks/x.sh has no test-x.sh beside it',
  '  UNCHECKED  enforcement not probed -- no working recipe here to probe with',
  '  ERROR  [not applied yet] knowledge-base: settings.proposed.json is fit to apply',
  'hooks: 2 ERRORS -- 1 real; 1 only settings.json not applied yet',
  '',
].join('\n');

// (gate, role, exit code, output): one of each finding kind the helper reads,
// in the shapes dev.sh's gates print them. Made-up names only.
const RED = [
  ['test', 'code', 1, TAP_RED],
  ['audit', 'audit', 1,
    'ERROR example.test#listing:default                    card_selector matches nothing\n'
    + 'WARN  other.test#listing:default                      descendant :has()\n'
    + 'OK/W  third.test#listing:default                      descendant :has()\n'
    + '      waived 2026-09-28: 20 matches = 20 anchors\n'],
  ['hooks', 'code', 1, HOOKS_RED],
  // a file that is here gets file and line; one that is not gets neither; line 0 is not a line
  ['files', 'docs', 1, '  FAIL  dev.sh:4: canned placement\n  FAIL  gone.md:2: not here\n  FAIL  CLAUDE.md:0: no line 0\n'],
  ['quiet', 'code', 1, 'nothing that reads as a finding\n'],
  ['skipped', 'code', 3, '  UNCHECKED  a sibling is absent: nothing compared\n'],
  ['silent', 'code', 3, ''],
  ['tree', 'code', 128, 'fatal: not a git repository\n'],
];
const GREEN = [
  ['test', 'code', 0, '# tests 412\n# pass 412\n# fail 0\n'],
  ['audit', 'audit', 0, 'WARN  other.test#listing:default                      descendant :has()\n'],
  ['hooks', 'code', 3, '  UNCHECKED  knowledge-base is declared but absent here (standalone run) -- its copies are not compared\n'
    + 'hooks: clean, 1 declared location UNCHECKED (absent; standalone run)\n'],
  ['files', 'docs', 0, '  FAIL  ignored: the gate exited 0\n'],
  ['tree', 'code', 0, ' M dev.sh\n?? devtools/\n(stage only your own paths if another session\'s work is here)\n'],
];
const FAILED = RED.filter((r) => ![2, 128].includes(r[2]));
const BROKE = [['test', 'code', 0, '# pass 1\n'], ['tree', 'code', 128, 'fatal: x\n']];

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ss-checkjson-'));
}

function rows(dir, table) {
  return table.map(([gate, role, code, text]) => {
    const p = path.join(dir, `${gate}.out`);
    fs.writeFileSync(p, text);
    return `${gate}:${role}:${code}:${p}`;
  });
}

function runHelper(args, helper = HELPER) {
  return spawnSync(NODE, [helper, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function mutated(src, dest, oldText, newText) {
  const text = fs.readFileSync(src, 'utf8');
  const n = text.split(oldText).length - 1;
  if (n !== 1) throw new Error(`STALE mutant: ${JSON.stringify(oldText)} occurs ${n} time(s) in ${path.basename(src)}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, text.replace(oldText, newText), { mode: 0o755 });
  return dest;
}

// dev.sh's own check --json with its gates swapped for canned ones. A gate
// that assigns names the loop uses must change nothing outside itself.
const GATES_LINE = 'GATES="test audit hooks tree"\n';
const DISPATCH = 'cmd="${1:-}"; shift || true\n';
const CANNED = [
  // assigns every name the --json loop and the text mode use; a gate that
  // shared the loop's shell would lose the rows and the helper with it
  'gate_audit() { json=0; rows=(); code=0; dest=/dev/null; capdir=/nonexistent; g=x; NODE_BIN=/nonexistent/node; suiterc=0',
  '  echo "ERROR example.test#listing:default  canned"; return 1; }',
  `gate_test() { printf 'not ok 1 - canned\\n  ---\\n  location: %s\\n  error: %s\\n  ...\\n' "'$PWD/test/check-json.test.js:9:3'" "'canned'"; return 1; }`,
  'gate_hooks() { echo "  UNCHECKED  hooks: canned, not here"; echo "hooks: clean, canned"; return 3; }',
  'gate_tree() { echo " M dev.sh"; }',
  '',
].join('\n');
const WIRED = [
  ['test', 'fail', undefined, [['canned: canned', 'test/check-json.test.js', 9, 'code']]],
  ['audit', 'fail', undefined, [['example.test#listing:default canned', null, null, 'audit']]],
  ['hooks', 'unchecked', 'hooks: canned, not here', []],
  ['tree', 'ok', undefined, []],
];

// A copy of dev.sh (or of `devSh`, a mutated one), the helpers and the files
// the canned findings name, gates canned.
function wiredCopy(dir, devSh) {
  fs.mkdirSync(path.join(dir, 'devtools'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.copyFileSync(HELPER, path.join(dir, 'devtools', 'checkjson.js'));
  fs.copyFileSync(AUDIT_LINES, path.join(dir, 'devtools', 'auditlines.js'));
  fs.copyFileSync(__filename, path.join(dir, 'test', 'check-json.test.js'));
  let text = fs.readFileSync(devSh || path.join(ROOT, 'dev.sh'), 'utf8');
  const counts = [GATES_LINE, DISPATCH].map((s) => text.split(s).length - 1);
  if (counts.join() !== '1,1') throw new Error("dev.sh moved: update test/check-json.test.js's GATES_LINE / DISPATCH");
  text = text.replace(DISPATCH, CANNED + DISPATCH);
  fs.writeFileSync(path.join(dir, 'dev.sh'), text, { mode: 0o755 });
  return dir;
}

function runCheck(dir, ...extra) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(path.join(dir, 'dev.sh'), ['check', ...extra],
    { cwd: dir, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
}

// The real check-json validator, on a scratch repo whose dev.sh prints `text`
// and exits `code`. Returns [status, lines], or null when nested inside a
// check-json run (which answers UNCHECKED by design).
function validate(scratch, name, text, code) {
  const repo = path.join(scratch, 'live', name);
  fs.mkdirSync(repo, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'payload.json'), text);
  fs.writeFileSync(path.join(repo, 'dev.sh'),
    `#!/usr/bin/env bash\n# check --json: prints payload.json, canned\ncat payload.json\nexit ${code}\n`, { mode: 0o755 });
  const r = spawnSync(CHECKS_CLI, ['one', 'check-json', repo, '--json'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const results = JSON.parse(r.stdout).results;
  assert.deepStrictEqual(results.map((x) => x.check), ['check-json'], r.stdout);
  if (results[0].status === 'unchecked' && process.env[GUARD]) return null;
  return [results[0].status, results[0].lines];
}

const nested = () => Boolean(process.env[GUARD]);
const skipValidator = CHECKS_CLI ? false : LONE;

test.describe('report', () => {
  let dir;
  test.beforeEach(() => { dir = tmpdir(); });
  test.afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('a red report is the reviewed fixture, one line, and exits red', () => {
    const r = runHelper(rows(dir, RED));
    assert.strictEqual(r.status, 1, r.stderr);
    assert.strictEqual(r.stdout.trim().split('\n').length, 1, r.stdout);
    assert.deepStrictEqual(JSON.parse(r.stdout), fixture('check-red.json'));
  });

  test('a green report is the reviewed fixture and exits green', () => {
    const r = runHelper(rows(dir, GREEN));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(JSON.parse(r.stdout), fixture('check-green.json'));
  });

  test('an error alone is red', () => {
    const r = runHelper(rows(dir, BROKE));
    const doc = JSON.parse(r.stdout);
    assert.deepStrictEqual([r.status, doc.ok, doc.checks.map((c) => c.status)], [1, false, ['ok', 'error']]);
  });

  test('the role given is the role reported', () => {
    const table = RED.slice(0, 4).map(([g, , c, t]) => [g, 'tests', c, t]);
    const doc = JSON.parse(runHelper(rows(dir, table)).stdout);
    assert.deepStrictEqual([...new Set(doc.checks.flatMap((c) => c.failures.map((f) => f.role)))], ['tests']);
  });

  test('no gates, or a bad row, is refused rather than reported', () => {
    for (const args of [[], ['test:code:x:/dev/null'], ['test::0:/dev/null'], [':code:0:/dev/null'], ['test:code:0']]) {
      const r = runHelper(args);
      assert.deepStrictEqual([r.status, r.stdout], [64, ''], JSON.stringify(args));
    }
  });

  test('unreadable gate output is a failure, not a pass', () => {
    const gone = path.join(dir, 'absent');
    const doc = JSON.parse(runHelper([`test:code:1:${gone}`, `hooks:code:1:${gone}`]).stdout);
    assert.deepStrictEqual(doc.checks.map((c) => [c.status, c.counts.failed]), [['fail', 1], ['fail', 1]]);
  });

  test('the fixtures pass the real validator, and the old text check does not',
    { skip: skipValidator }, (t) => {
      for (const name of ['check-red.json', 'check-green.json']) {
        const doc = fixture(name);
        const got = validate(dir, name, JSON.stringify(doc), doc.ok ? 0 : 1);
        if (got === null) return t.skip('nested inside a check-json run');
        assert.deepStrictEqual(got, ['ok', []], name);
      }
      const old = '-- suite\n   # tests 1 # pass 1 # fail 0\n-- offline audit\n   units: clean\n';
      assert.strictEqual(validate(dir, 'old', old, 0)[0], 'fail');
    });
});

test.describe('wiring', () => {
  let dir;
  test.beforeEach(() => { dir = tmpdir(); });
  test.afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('dev.sh check --json wires each gate through the helper, each in its own subshell', () => {
    const r = runCheck(wiredCopy(path.join(dir, 'copy')), '--json');
    assert.strictEqual(r.status, 1, r.stdout + r.stderr);
    assert.strictEqual(r.stdout.trim().split('\n').length, 1, r.stdout);
    const doc = JSON.parse(r.stdout);
    assert.strictEqual(doc.ok, false);
    assert.deepStrictEqual(doc.checks.map((c) => [c.name, c.status, c.reason,
      c.failures.map((f) => [f.message, f.file, f.line, f.role])]), WIRED);
  });

  test('the text check keeps its shape and gates on the suite alone', () => {
    const r = runCheck(wiredCopy(path.join(dir, 'copy')));
    assert.strictEqual(r.status, 1, r.stdout + r.stderr);
    for (const s of ['-- suite', '-- offline audit', '   ERROR example.test#listing:default  canned',
      '-- hooks', '   hooks: clean, canned', '-- working tree', '    M dev.sh', 'SUITE FAILED — do not commit']) {
      assert.ok(r.stdout.split('\n').includes(s), `missing ${JSON.stringify(s)} in:\n${r.stdout}`);
    }
  });

  test('a check already running is one error document under --json, not text', () => {
    const copy = wiredCopy(path.join(dir, 'copy'));
    // held by a pid that is surely alive: this test's own
    fs.mkdirSync(path.join(copy, '.check.lock'));
    fs.writeFileSync(path.join(copy, '.check.lock', 'pid'), String(process.pid));
    const r = runCheck(copy, '--json');
    assert.strictEqual(r.status, 1, r.stdout + r.stderr);
    const doc = JSON.parse(r.stdout);
    assert.deepStrictEqual([doc.ok, doc.checks.map((c) => [c.name, c.status])], [false, [['lock', 'error']]]);
    assert.match(doc.checks[0].failures[0].message, /already running/);
  });

  test('every gate has a role from the starting set', () => {
    const text = fs.readFileSync(path.join(ROOT, 'dev.sh'), 'utf8');
    const gates = text.split('GATES="')[1].split('"')[0].split(/\s+/);
    const probe = path.join(dir, 'roles.sh');
    fs.writeFileSync(probe, text.replace(DISPATCH,
      'for g in "$@"; do echo "$g $(gate_role "$g")"; done; exit 0\n' + DISPATCH));
    const out = spawnSync('bash', [probe, ...gates], { encoding: 'utf8' }).stdout.trim().split('\n');
    const roles = Object.fromEntries(out.map((l) => l.split(' ')));
    assert.deepStrictEqual(Object.keys(roles), gates);
    for (const r of Object.values(roles)) assert.ok(['code', 'tests', 'audit', 'docs'].includes(r), r);
    for (const g of gates) assert.match(text, new RegExp(`\\ngate_${g}\\(\\) \\{`), `no gate_${g}`);
  });

  test('a hooks run that compared less than it says is unchecked; a finding stays a failure', () => {
    const text = fs.readFileSync(path.join(ROOT, 'dev.sh'), 'utf8');
    for (const [out, rc, want] of [
      ['  UNCHECKED  knowledge-base is declared but absent here\nhooks: clean, 1 declared location UNCHECKED', 0, 3],
      ['hooks: clean', 0, 0],
      ['  UNCHECKED  x absent\n  ERROR  y drifted\nhooks: 1 ERROR', 1, 1],
      ['crashed', 2, 2]]) {
      const fake = path.join(dir, `check-hooks-${rc}-${want}.sh`);
      fs.writeFileSync(fake, `#!/usr/bin/env bash\nprintf '%s\\n' ${JSON.stringify(out)}\nexit ${rc}\n`, { mode: 0o755 });
      const probe = path.join(dir, 'hooks.sh');
      fs.writeFileSync(probe, text.replace(DISPATCH, `HOOKS_SCRIPT=${JSON.stringify(fake)}; gate_hooks; exit $?\n` + DISPATCH));
      const r = spawnSync('bash', [probe], { encoding: 'utf8' });
      assert.strictEqual(r.status, want, `${out}: ${r.stdout}`);
      assert.ok(r.stdout.includes(out.split('\n')[0]), 'the gate prints what check-hooks.sh said');
    }
  });
});

test.describe('audit gate', () => {
  const run = (input) => spawnSync(NODE, [AUDIT_LINES], { input, encoding: 'utf8' });
  const f = (severity, unit, extra = {}) => ({ severity, unit, problem: 'p', why: 'w', ...extra });

  test('an unwaived error exits 1 and prints ERROR; warnings, info and waivers exit 0', () => {
    const red = run(JSON.stringify({ unitInvariants: [f('error', 'a#listing:default'), f('warn', 'b#listing:default')] }));
    assert.strictEqual(red.status, 1);
    assert.match(red.stdout, /^ERROR a#listing:default/m);
    const green = run(JSON.stringify({ unitInvariants: [
      f('warn', 'b#listing:default'), f('info', 'c#listing:default'),
      f('warn', 'd#listing:default', { waived: { on: '2026-09-28', reason: 'checked' } })] }));
    assert.strictEqual(green.status, 0);
    assert.match(green.stdout, /^OK\/W  d#listing:default/m);
    assert.match(green.stdout, /^ {6}waived 2026-09-28: checked$/m);
    const clean = run(JSON.stringify({ unitInvariants: [] }));
    assert.deepStrictEqual([clean.status, clean.stdout.trim()], [0, 'units: clean']);
  });

  test('a broken audit is an error (exit 2), never clean', () => {
    for (const input of ['', 'not json', '{}', '{"unitInvariants": 3}']) {
      const r = run(input);
      assert.strictEqual(r.status, 2, input);
      assert.match(r.stdout, /^ {2}ERROR {2}audit\.js units did not print its JSON/);
    }
  });
});

// [id, rule the validator must name, file mutated, old, new, scenario]
const MUTANTS = [
  ['devsh-leaks-gate-output', 'one-document', 'dev.sh',
    '( "gate_$g" ) >"$dest" 2>&1; code=$?', '( "gate_$g" ) 2>"$dest"; code=$?', 'wired'],
  ['devsh-gate-shares-the-loop', 'one-document', 'dev.sh',
    '( "gate_$g" ) >"$dest"', '"gate_$g" >"$dest"', 'wired'],
  ['devsh-exit-green', 'exit-agrees', 'dev.sh',
    '"$NODE_BIN" devtools/checkjson.js "${rows[@]}"; code=$?', '"$NODE_BIN" devtools/checkjson.js "${rows[@]}"; code=0', 'wired'],
  ['helper-exit-green', 'exit-agrees', 'helper', 'return doc.ok ? 0 : 1;', 'return 0;', 'red'],
  ['verdict-fail-passes', 'verdict', 'helper',
    "checks.every((c) => c.status === 'ok' || c.status === 'unchecked')", "checks.every((c) => c.status !== 'error')", 'failed'],
  ['verdict-error-passes', 'verdict', 'helper',
    "checks.every((c) => c.status === 'ok' || c.status === 'unchecked')",
    "checks.every((c) => c.status === 'ok' || c.status === 'unchecked' || c.status === 'error')", 'broke'],
  ['verdict-unchecked-red', 'verdict', 'helper',
    "checks.every((c) => c.status === 'ok' || c.status === 'unchecked')", "checks.every((c) => c.status === 'ok')", 'green'],
  ['miscounted', 'counted', 'helper', 'out.counts = { failed: failures.length };', 'out.counts = { failed: 1 };', 'red'],
  ['fail-without-failure', 'status-failures', 'helper',
    "if ((status === 'fail' || status === 'error') && !found.length) {", 'if (false) {', 'red'],
  ['ok-with-failures', 'status-failures', 'helper',
    "let found = status === 'fail' || status === 'error' ? findings(gate, text) : [];", 'let found = findings(gate, text);', 'green'],
  ['unchecked-unsaid', 'unchecked-reason', 'helper', 'out.reason = why ?', 'void (why) ?', 'green'],
  ['names-collide', 'unique-names', 'helper', 'const out = { name: gate, status };', 'const out = { name: role, status };', 'red'],
  ['line-without-file', 'line-needs-file', 'helper',
    'if (!rel) return [null, null];', 'if (!rel) return [null, m && m[2] ? Number(m[2]) : null];', 'red'],
  ['line-zero', 'schema', 'helper', "m[2] && Number(m[2]) >= 1 ? Number(m[2]) : null", 'm[2] ? Number(m[2]) : null', 'red'],
  ['role-dropped', 'schema', 'helper', '({ message, file, line, role })', '({ message, file, line })', 'red'],
];

// The run a mutant produces, and the unmutated run beside it.
function runMutant(scratch, [id, , src, oldText, newText, scenario]) {
  const d = path.join(scratch, id);
  if (src === 'dev.sh') {
    const bad = mutated(path.join(ROOT, 'dev.sh'), path.join(d, 'mutated-dev.sh'), oldText, newText);
    return [runCheck(wiredCopy(path.join(d, 'copy'), bad), '--json'), runCheck(wiredCopy(path.join(d, 'base')), '--json')];
  }
  // in a copy of the files the findings name, so they resolve as they do here
  const tool = path.join(d, 'tool');
  for (const rel of ['dev.sh', 'CLAUDE.md', 'test/check-json.test.js']) {
    fs.mkdirSync(path.dirname(path.join(tool, rel)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), path.join(tool, rel));
  }
  const helper = mutated(HELPER, path.join(tool, 'devtools', 'checkjson.js'), oldText, newText);
  const base = path.join(tool, 'devtools', 'base.js');
  fs.copyFileSync(HELPER, base);
  // the tables name files under ROOT; the copy resolves them under its own root
  const table = { red: RED, failed: FAILED, green: GREEN, broke: BROKE }[scenario]
    .map(([g, r, c, text]) => [g, r, c, text.split(ROOT).join(tool)]);
  return [runHelper(rows(d, table), helper), runHelper(rows(d, table), base)];
}

test.describe('mutants', () => {
  let dir;
  test.before(() => { dir = tmpdir(); });
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('each mutant changes the run', () => {
    for (const m of MUTANTS) {
      const [r, base] = runMutant(path.join(dir, 'changes'), m);
      assert.notDeepStrictEqual([r.stdout, r.status], [base.stdout, base.status], `${m[0]}: SURVIVED (the run did not change)`);
    }
  });

  test('each mutant fails the real validator under its rule; its baseline passes', { skip: skipValidator }, (t) => {
    if (nested()) return t.skip('nested inside a check-json run, which answers UNCHECKED here by design');
    for (const m of MUTANTS) {
      const [r, base] = runMutant(path.join(dir, 'validator'), m);
      const b = validate(dir, `${m[0]}-base`, base.stdout, base.status);
      assert.deepStrictEqual(b, ['ok', []], `${m[0]}: baseline`);
      const [status, lines] = validate(dir, m[0], r.stdout, r.status);
      assert.strictEqual(status, 'fail', `${m[0]}: SURVIVED the validator`);
      assert.ok(lines.some((l) => l.startsWith(`${m[1]}:`)), `${m[0]}: not under ${m[1]}: ${lines}`);
    }
  });

  test('every rule the schema names has a mutant', { skip: skipValidator }, () => {
    const schema = JSON.parse(fs.readFileSync(path.join(path.dirname(CHECKS_CLI), 'schema', 'check-json.schema.json'), 'utf8'));
    assert.deepStrictEqual(new Set(MUTANTS.map((m) => m[1])), new Set([...Object.keys(schema['x-rules']), 'schema']));
  });
});
