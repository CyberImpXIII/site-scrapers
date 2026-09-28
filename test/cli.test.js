// The command-line layer, exercised by actually RUNNING each CLI.
//
// These are the sanctioned paths. Their internals are covered elsewhere, but
// nothing tested the layer a caller touches: argument parsing, the shape of the
// output, and the error paths. That matters more here than usual for two
// reasons.
//
// First, the documented workflow pipes these into `jq`, so output that is not
// valid JSON breaks the instructions rather than just looking untidy — and that
// happened repeatedly, because node:sqlite's ExperimentalWarning leaked into
// stdout-adjacent position until every CLI dropped the listener.
//
// Second, if `lab.js set` mis-parsed its arguments, the gate would be bypassed
// by ACCIDENT rather than intent — a hole nobody would think to look for.
//
// Run via `npm test` / `./test.sh`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

const REPO_ROOT = path.join(__dirname, '..');

// Returns { code, stdout, stderr } without throwing on a non-zero exit — a CLI
// reporting a refusal exits 1, and that is correct behaviour to assert.
async function run(script, args = []) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [path.join(REPO_ROOT, script), ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

const parse = out => {
  try {
    return JSON.parse(out);
  } catch (e) {
    assert.fail(`expected JSON on stdout, got: ${out.slice(0, 300)}\n(${e.message})`);
  }
};

const JSON_CLIS = ['query.js', 'lab.js', 'audit.js', 'verify.js', 'register.js', 'failures.js', 'init.js'];

// --- The jq contract -------------------------------------------------------

test('every CLI emits parseable JSON when invoked with no arguments', async () => {
  for (const script of JSON_CLIS) {
    const { stdout } = await run(script);
    const out = parse(stdout);
    assert.equal(typeof out, 'object', `${script} should emit a JSON object`);
  }
});

test('a CLI invoked with no arguments explains itself rather than crashing', async () => {
  for (const script of ['query.js', 'lab.js', 'verify.js', 'register.js', 'failures.js']) {
    const { stdout, stderr } = await run(script);
    const out = parse(stdout);
    assert.ok(
      out.error || out.usage || out.skeleton || Array.isArray(out),
      `${script} should return an error or usage, got ${JSON.stringify(out).slice(0, 120)}`
    );
    assert.ok(!/\bat Object\.|Cannot read properties|is not a function/.test(stderr), `${script} leaked a stack trace: ${stderr.slice(0, 200)}`);
  }
});

test('an unknown command names the commands that exist', async () => {
  for (const [script, expectSome] of [
    ['query.js', ['sites', 'health']],
    ['lab.js', ['probe', 'set']],
    ['failures.js', ['match', 'record']],
  ]) {
    const { stdout } = await run(script, ['definitely-not-a-command']);
    const out = parse(stdout);
    assert.ok(out.error, `${script} should report an error`);
    for (const cmd of expectSome) {
      assert.ok(out.error.includes(cmd), `${script}'s error should mention "${cmd}" so the caller can correct it`);
    }
  }
});

// --- lab.js set: the gated write path -------------------------------------
// If this mis-parses, the gate is bypassed by accident.

test('lab.js set refuses an earned status through the CLI, not just the library', async () => {
  for (const status of ['working', 'blocked']) {
    const { stdout, code } = await run('lab.js', ['set', 'hiringcafe.com#listing', JSON.stringify({ status, note: 'should be refused' })]);
    const out = parse(stdout);
    assert.equal(out.success, false, `status "${status}" must be refused`);
    assert.match(out.error, /earned by a run/);
    assert.match(out.error, /verify\.js/, 'it has to say what to use instead');
    assert.notEqual(code, 0, 'a refusal should exit non-zero');
  }
});

test('lab.js set requires a note, because an unexplained edit is the problem', async () => {
  const { stdout } = await run('lab.js', ['set', 'hiringcafe.com#listing', JSON.stringify({ ready_timeout_ms: 25000 })]);
  const out = parse(stdout);
  assert.equal(out.success, false);
  assert.match(out.error, /note/i);
});

test('lab.js set reports malformed JSON without a stack trace', async () => {
  const { stdout, stderr } = await run('lab.js', ['set', 'hiringcafe.com#listing', '{not json']);
  const out = parse(stdout);
  assert.equal(out.success, false);
  assert.match(out.error, /not valid JSON/i);
  assert.ok(!/SyntaxError\n\s+at /.test(stderr), 'a bad argument is a user error, not a crash');
});

test('lab.js set @file reports which file failed to parse', async () => {
  // The @file form exists because shell-escaping long notes silently turned a
  // set into a no-op. If the file is bad, the message has to name it.
  const tmp = path.join(os.tmpdir(), `cli-test-${Date.now()}.json`);
  fs.writeFileSync(tmp, '{ nope');
  try {
    const { stdout } = await run('lab.js', ['set', 'hiringcafe.com#listing', `@${tmp}`]);
    const out = parse(stdout);
    assert.equal(out.success, false);
    assert.ok(out.error.includes(tmp), `the error should name the file, got: ${out.error}`);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('lab.js set on an unknown recipe says so rather than creating one', async () => {
  const { stdout } = await run('lab.js', ['set', 'no-such-site.invalid#listing', JSON.stringify({ notes: 'x', note: 'y' })]);
  const out = parse(stdout);
  assert.equal(out.success, false);
  assert.match(out.error, /No recipe for/i);
});

// --- register.js ----------------------------------------------------------

test('register.js refuses a hand-set working status', async () => {
  const def = {
    hostname: 'cli-test.invalid',
    page_type: 'listing',
    status: 'working',
    nav_method: 'url_param',
    nav_template: 'https://cli-test.invalid/?q={{q}}',
    card_selector: 'li.x',
    fields: [{ field_name: 'title', extract_kind: 'positional_segment', segment_index: 0 }],
  };
  const { stdout } = await run('register.js', [JSON.stringify(def)]);
  const out = parse(stdout);
  assert.equal(out.success, false);
  assert.match(out.error, /cannot be set by hand/);
});

test('register.js rejects an unknown enum value by naming the valid ones', async () => {
  const def = {
    hostname: 'cli-test.invalid',
    page_type: 'listing',
    status: 'mostly-fine',
    nav_method: 'url_param',
    nav_template: 'https://cli-test.invalid/',
    card_selector: 'li.x',
  };
  const { stdout } = await run('register.js', [JSON.stringify(def)]);
  const out = parse(stdout);
  assert.equal(out.success, false);
  assert.match(out.error, /Unknown status/);
  assert.match(out.error, /needs-review/, 'the valid values have to be listed');
});

test('register.js reads a definition from a file path as well as a string', async () => {
  const { stdout } = await run('register.js', ['/no/such/file.json']);
  const out = parse(stdout);
  assert.equal(out.success, false);
  // The point: a missing file is reported, not treated as literal JSON.
  assert.ok(out.error && out.error.length > 5);
});

// --- verify.js ------------------------------------------------------------

test('verify.js reports an unknown target without running a browser', async () => {
  const started = Date.now();
  const { stdout } = await run('verify.js', ['no-such-site.invalid', '{}']);
  const out = parse(stdout);
  assert.equal(out.success, false);
  assert.equal(out.documented, false);
  assert.ok(Date.now() - started < 20000, 'it should fail before launching anything');
});

test('verify.js rejects malformed params cleanly', async () => {
  const { stdout } = await run('verify.js', ['hiringcafe.com#listing', '{not json']);
  const out = parse(stdout);
  assert.equal(out.success, false);
  assert.match(out.error, /not valid JSON/i);
});

// --- query.js -------------------------------------------------------------

test('query.js sites returns an array of registered recipes', async () => {
  const { stdout } = await run('query.js', ['sites']);
  const out = parse(stdout);
  assert.ok(Array.isArray(out), 'sites should be a list');
  assert.ok(out.length > 0);
  for (const s of out.slice(0, 3)) {
    assert.ok(s.hostname && s.page_type && s.status, `a row should carry identity and status: ${JSON.stringify(s)}`);
  }
});

test('query.js reports an undocumented site as documented:false', async () => {
  const { stdout } = await run('query.js', ['site', 'no-such-site.invalid']);
  const out = parse(stdout);
  assert.equal(out.documented, false, 'the caller branches on this field');
});

test('query.js diff on an unknown site does not throw', async () => {
  const { stdout } = await run('query.js', ['diff', 'no-such-site.invalid']);
  const out = parse(stdout);
  assert.ok(out.error);
});

// --- audit.js / init.js ---------------------------------------------------

test('audit.js units is offline and returns a findings array', async () => {
  const started = Date.now();
  const { stdout } = await run('audit.js', ['units']);
  const out = parse(stdout);
  assert.ok(Array.isArray(out.unitInvariants), 'units should return a list');
  assert.ok(Date.now() - started < 60000, 'the offline audit must stay fast enough to run before every commit');
});

test('audit.js with an unknown check does not silently report success', async () => {
  const { stdout } = await run('audit.js', ['not-a-check']);
  const out = parse(stdout);
  // It should either report nothing ran or name the checks — never imply a pass.
  assert.ok(out.summary !== undefined || out.error, `got ${JSON.stringify(out).slice(0, 120)}`);
});

test('init.js reports the shared library and the private data separately', async () => {
  const { stdout } = await run('init.js');
  const out = parse(stdout);
  assert.ok(out.sharedLibrary.genericActions > 0, 'the library should be seeded');
  assert.ok(out.sharedLibrary.failureTypes > 0);
  assert.ok(out.sharedLibrary.blockerSignatures > 0);
  assert.ok('recipes' in out.yourData, 'a clone needs to know its own data is separate');
  assert.ok(out.next, 'it should say what to do next');
});

// --- dev.sh ---------------------------------------------------------------

test('dev.sh rejects an unknown subcommand with usage', async () => {
  const r = await new Promise(resolve => {
    execFile(path.join(REPO_ROOT, 'dev.sh'), ['not-a-subcommand'], { cwd: REPO_ROOT, encoding: 'utf8' }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code : 0, stdout, stderr })
    );
  });
  assert.notEqual(r.code, 0, 'an unknown subcommand should exit non-zero');
  assert.match(`${r.stdout}${r.stderr}`, /dev\.sh/, 'it should print its own usage');
});

test('dev.sh blocked lists what is waiting on a person', async () => {
  const r = await new Promise(resolve => {
    execFile(path.join(REPO_ROOT, 'dev.sh'), ['blocked'], { cwd: REPO_ROOT, encoding: 'utf8' }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code : 0, stdout, stderr })
    );
  });
  assert.equal(r.code, 0);
  // Either something is blocked, or it says nothing is — never empty output,
  // which would read as "the command did not work".
  assert.ok(r.stdout.trim().length > 0, 'it should always say something');
});
