// lab.js set refuses what it cannot write, rather than dropping it.
//
// 2026-10-05: `lab.js set job-boards.greenhouse.io#article` with
// {nav_method: "ui_steps", nav_template: [steps]} reported success, changed
// only nav_template (nav_method was not a settable column), and left a
// `working` direct_url recipe whose "URL" was a JSON step list. A dropped key
// reads exactly like a written one, so every refusal below happens before the
// gate runs and before anything is written.
//
// Every case is a refusal, so the shared recipe used as the target
// (hiringcafe.com#listing, as in test/cli.test.js) is never modified.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

const REPO_ROOT = path.join(__dirname, '..');
const TARGET = 'hiringcafe.com#listing'; // a url_param recipe

async function labSet(def) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [path.join(REPO_ROOT, 'lab.js'), 'set', TARGET, JSON.stringify(def)], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    return { code: 0, out: JSON.parse(stdout) };
  } catch (e) {
    return { code: e.code ?? 1, out: JSON.parse(e.stdout || '{}') };
  }
}

test('an unknown key is refused by name, not silently dropped', async () => {
  const { code, out } = await labSet({ nav_methd: 'ui_steps', note: 'typo should be refused' });
  assert.equal(out.success, false);
  assert.match(out.error, /does not write "nav_methd"/);
  assert.notEqual(code, 0);
});

test('nav_method is validated against the known methods', async () => {
  const { out } = await labSet({ nav_method: 'teleport', note: 'should be refused' });
  assert.equal(out.success, false);
  assert.match(out.error, /Unknown nav_method "teleport"/);
});

test('a step-list template on a non-ui_steps recipe is refused', async () => {
  // The exact shape of the 2026-10-05 no-op: template changed, method not.
  const { out } = await labSet({ nav_template: [{ action: 'goto', url: '{{url}}' }], note: 'should be refused' });
  assert.equal(out.success, false);
  assert.match(out.error, /set "nav_method": "ui_steps"/);
});

test('ui_steps without a step-list template is refused', async () => {
  const { out } = await labSet({ nav_method: 'ui_steps', note: 'should be refused' });
  assert.equal(out.success, false);
  assert.match(out.error, /JSON array of steps/);
});

test('lab.js and register.js accept the same nav_method list', () => {
  // Two literals kept in step by a comment; this is the check.
  const listIn = (file, name) => {
    const src = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
    const m = src.match(new RegExp(`const ${name} = (\\[[^\\]]*\\])`));
    assert.ok(m, `${file} should define ${name}`);
    return JSON.parse(m[1].replace(/'/g, '"'));
  };
  assert.deepEqual(listIn('lab.js', 'NAV_METHODS').sort(), listIn('register.js', 'VALID_NAV_METHODS').sort());
});
