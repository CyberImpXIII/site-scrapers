// Gates for the opt-in fill screenshot (lib/fillScreenshot.js,
// docs/fill-output.md "## Screenshot"). The seam is the action's output: a
// top-level `fillScreenshot` beside `fill`, read by the applications side.
// Proven here:
//   1. the doc's section, the validator and the code agree (keys, the three
//      documented shapes);
//   2. not asked -> null and no file; asked -> an absolute PNG path, mode
//      0600 in a 0700 directory that git ignores;
//   3. the image is of the FILLED form: different answers, different image;
//   4. a malformed param value is refused with an error, never a guess;
//   5. a page that cannot be captured is {path:null, error}, and the fill is
//      still reported (a screenshot never turns a fill into an engine error);
//   6. pruning keeps the newest N;
//   7. the `fill` object is unchanged (contract /2 still validates it, no new
//      key inside it) and nothing submits.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const { openDb, upsertSite, insertField, deleteSite } = require('../db');
const { authorizeForTests } = require('../lib/writeGuard');
const { startAtsServer } = require('./fixtures/ats/server');
const { validateFillResult } = require('../lib/fillContract');
const { takeFillScreenshot, validateFillScreenshot, FILL_SHOT_DIR, SHOT_KEYS } = require('../lib/fillScreenshot');

const REPO_ROOT = path.join(__dirname, '..');
const HOST = 'fill-screenshot.internal';
const DOC = path.join(REPO_ROOT, 'docs', 'fill-output.md');
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let ats;
let db;
const created = [];

function recipe(name, steps) {
  const id = upsertSite(db, {
    hostname: HOST,
    page_type: 'action',
    recipe_name: name,
    status: 'working',
    nav_method: 'ui_steps',
    nav_template: JSON.stringify(steps),
    card_min_text_len: 1,
    ready_timeout_ms: 4000,
    notes: 'Test-only recipe for test/fill-screenshot.test.js. Safe to delete if found stray.',
  });
  created.push(id);
  insertField(db, id, { field_name: 'body', extract_kind: 'full_blob' }, 0);
}

async function run(name, params) {
  const args = ['engine.js', `${HOST}#action:${name}`, JSON.stringify({ noSession: true, noDiagnostics: true, ...params })];
  let stdout;
  try {
    ({ stdout } = await execFileAsync(process.execPath, args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  } catch (e) {
    stdout = e.stdout;
  }
  return JSON.parse(stdout);
}

let described;
let fillKeys = null; // the keys of `fill` on the first run: every later run must match
async function fields() {
  if (described) return described;
  const out = await run('shot_describe', { url: ats.url('greenhouse') });
  const forms = (out.diagnostics || []).find(d => d.kind === 'forms');
  assert.ok(forms && forms.fields.length, 'describe returned no fields');
  described = forms.fields;
  return described;
}

function ours() {
  try {
    return fs.readdirSync(FILL_SHOT_DIR).filter(n => n.includes(`__${HOST}__`));
  } catch {
    return [];
  }
}

async function fill(answers, extra = {}) {
  const f = await fields();
  ats.reset();
  const out = await run('shot_fill', { url: ats.url('greenhouse'), fields: f, answers, ...extra });
  assert.ok(out.fill, `no fill in output: ${JSON.stringify(out).slice(0, 300)}`);
  assert.deepEqual(validateFillResult(out.fill, f), [], 'the fill object no longer passes contract /2');
  const keys = Object.keys(out.fill).sort().join();
  fillKeys = fillKeys || keys;
  assert.equal(keys, fillKeys, 'asking for a screenshot changed the keys inside `fill`');
  assert.ok(!('fillScreenshot' in out.fill));
  assert.ok('fillScreenshot' in out, 'fillScreenshot must be present whenever fill is');
  assert.deepEqual(validateFillScreenshot(out.fillScreenshot, extra.fillScreenshot), []);
  assert.equal(ats.submits(), 0, `submit attempts: ${JSON.stringify(ats.counters)}`);
  return out;
}

test.before(async () => {
  authorizeForTests();
  ats = await startAtsServer();
  db = openDb();
  recipe('shot_describe', [{ action: 'goto', url: '{{url}}' }, { action: 'probe', kind: 'forms' }]);
  recipe('shot_fill', [{ action: 'goto', url: '{{url}}' }, { action: 'fill_form', fields: '{{fields}}', answers: '{{answers}}' }]);
});

test.after(async () => {
  for (const id of created) deleteSite(db, id);
  for (const n of ours()) fs.rmSync(path.join(FILL_SHOT_DIR, n), { force: true });
  await ats.close();
});

test('docs/fill-output.md "## Screenshot" matches the code', () => {
  const text = fs.readFileSync(DOC, 'utf8');
  const sec = text.split('## Screenshot')[1].split('\n## ')[0];
  const keysLine = sec.match(/Keys of the object: (.+?) --/);
  assert.ok(keysLine, 'the section must list the object keys');
  const docKeys = [...keysLine[1].matchAll(/`([a-zA-Z]+)`/g)].map(m => m[1]);
  assert.deepEqual(docKeys.sort(), [...SHOT_KEYS].sort(), 'documented keys != code keys');
  // Every documented shape is accepted for the request it is documented under,
  // and rejected for the other: the table rows are executable.
  const rows = [...sec.matchAll(/^\| `(.+?)` \| (.+?) \|$/gm)].map(m => m[1]);
  assert.equal(rows.length, 3, 'three documented shapes');
  const [none, taken, refused] = rows.map(r => JSON.parse(r.replace('/abs/…/', '/abs/')));
  assert.deepEqual(validateFillScreenshot(none, undefined), []);
  assert.deepEqual(validateFillScreenshot(taken, true), []);
  assert.deepEqual(validateFillScreenshot(refused, true), []);
  assert.notDeepEqual(validateFillScreenshot(none, true), [], 'asked for and got null must be a violation');
  assert.notDeepEqual(validateFillScreenshot(taken, undefined), [], 'a screenshot nobody asked for must be a violation');
  assert.notDeepEqual(validateFillScreenshot({ ...taken, value: 'x' }, true), [], 'an extra key must be a violation');
});

test('data/.fills is gitignored', () => {
  const probe = path.join('data', '.fills', 'x.png');
  // check-ignore exits 0 and echoes the path when it IS ignored.
  const out = execFileSync('git', ['check-ignore', '--no-index', probe], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(out.trim(), probe);
});

test('not asked: null and no file', async () => {
  const before = ours().length;
  const out = await fill({ '#first_name': 'Ada' });
  assert.equal(out.fillScreenshot, null);
  assert.equal(ours().length, before, 'a file was written although nobody asked');
});

test('asked: a private PNG of the filled form, and different answers make a different image', async () => {
  const a = await fill({ '#first_name': 'Ada', '#last_name': 'Lovelace' }, { fillScreenshot: true });
  const b = await fill({ '#first_name': 'Grace', '#last_name': 'Hopper' }, { fillScreenshot: true });
  for (const out of [a, b]) {
    const p = out.fillScreenshot.path;
    assert.ok(path.isAbsolute(p) && p.startsWith(FILL_SHOT_DIR), p);
    const buf = fs.readFileSync(p);
    assert.ok(buf.subarray(0, 8).equals(PNG_MAGIC), 'not a PNG');
    assert.equal(fs.statSync(p).mode & 0o777, 0o600, 'the image holds answers: owner-only');
  }
  assert.equal(fs.statSync(FILL_SHOT_DIR).mode & 0o777, 0o700);
  assert.notEqual(a.fillScreenshot.path, b.fillScreenshot.path);
  assert.ok(!fs.readFileSync(a.fillScreenshot.path).equals(fs.readFileSync(b.fillScreenshot.path)), 'the answers did not change the image: it is not of the filled form');
  assert.ok(!JSON.stringify(a).includes('Lovelace'), 'the output carries an answer');
});

test('a malformed param is refused, never guessed', async () => {
  const before = ours().length;
  const out = await fill({ '#first_name': 'Ada' }, { fillScreenshot: 'yes' });
  assert.equal(out.fillScreenshot.path, null);
  assert.match(out.fillScreenshot.error, /must be true or false/);
  assert.equal(ours().length, before);
});

test('a page that cannot be captured gives {path:null, error}; pruning keeps the newest N', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fillshot-'));
  try {
    const broken = { screenshot: async () => { throw new Error('Target closed'); } };
    const r = await takeFillScreenshot(broken, true, { hostname: HOST }, { dir });
    assert.equal(r.path, null);
    assert.match(r.error, /Target closed/);
    assert.equal(fs.readdirSync(dir).length, 0, 'a failed capture left a file');
    let n = 0;
    const page = { screenshot: async () => Buffer.concat([PNG_MAGIC, Buffer.from([n++])]) };
    const paths = [];
    for (let i = 0; i < 4; i++) {
      paths.push((await takeFillScreenshot(page, true, { hostname: `h${i}` }, { dir, keep: 2 })).path);
      await new Promise(res => setTimeout(res, 5)); // distinct timestamps
    }
    assert.deepEqual(fs.readdirSync(dir).sort(), paths.slice(2).map(p => path.basename(p)).sort(), 'not the newest two');
    assert.equal(await takeFillScreenshot(page, false, {}, { dir }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
