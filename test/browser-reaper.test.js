// A browser must not outlive the process that launched it (lib/browserReaper.js).
//
// The first test is the one that matters: it SIGKILLs a real driver mid-run and
// requires that its Chrome, every process carrying its profile, and the profile
// directory are all gone. Without the watcher (armReaper's call removed from
// lib/runner.js) the browser is reparented to PID 1 and stays up -- which is
// exactly how four of them were found alive 25 hours after a suite run.
//
// Every test cleans up what it started even when it fails, so a red run here
// does not itself leave a browser behind.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { armReaper, isRemovableProfile, PROFILE_PREFIX } = require('../lib/browserReaper');

const REPO_ROOT = path.join(__dirname, '..');
const DRIVER = path.join(__dirname, 'fixtures', 'reaper-driver.js');
const REAPER = path.join(REPO_ROOT, 'lib', 'browserReaper.js');

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function commandLines() {
  return execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => {
      const i = l.indexOf(' ');
      return { pid: parseInt(l.slice(0, i), 10), command: l.slice(i + 1) };
    });
}

const naming = needle => commandLines().filter(p => p.command.includes(needle));
const watchersFor = chromePid => naming(`${REAPER} ${chromePid} `);

async function waitFor(pred, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return pred();
}

function startDriver(mode) {
  const child = spawn(process.execPath, [DRIVER, mode], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stderr.on('data', d => {
    err += d;
  });
  const exited = new Promise(r => child.on('exit', (code, signal) => r({ code, signal })));
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', d => {
      out += d;
      const nl = out.indexOf('\n');
      if (nl >= 0) resolve(JSON.parse(out.slice(0, nl)));
    });
    exited.then(x => reject(new Error(`driver exited before reporting a browser: ${JSON.stringify(x)} ${err.slice(-400)}`)));
  });
  return { child, ready, exited };
}

function cleanup(info) {
  if (!info) return;
  if (info.chromePid && alive(info.chromePid)) {
    try {
      process.kill(-info.chromePid, 'SIGKILL');
    } catch {
      try {
        process.kill(info.chromePid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  }
  if (info.userDataDir && isRemovableProfile(info.userDataDir)) fs.rmSync(info.userDataDir, { recursive: true, force: true });
}

test('a SIGKILLed driver leaves no browser, no profile process and no profile dir behind', { timeout: 120000 }, async () => {
  const d = startDriver('hang');
  let info;
  try {
    info = await d.ready;
    assert.ok(info.chromePid > 1, 'driver reported its browser pid');
    assert.ok(info.userDataDir, 'driver reported its profile dir');
    assert.ok(alive(info.chromePid), 'the browser is up before the kill');
    // Read now, asserted after the orphan check, so a run without the watcher
    // fails on the thing that matters (the browser outliving its driver).
    await waitFor(() => watchersFor(info.chromePid).length === 1, 10000);
    const armed = watchersFor(info.chromePid).length;

    d.child.kill('SIGKILL'); // no handler anywhere can see this
    await d.exited;

    const gone = await waitFor(() => !alive(info.chromePid) && naming(info.userDataDir).length === 0, 20000);
    assert.ok(
      gone,
      `browser ${info.chromePid} or a process naming its profile outlived the SIGKILLed driver: ${JSON.stringify(naming(info.userDataDir).map(p => p.pid))}`
    );
    assert.ok(await waitFor(() => !fs.existsSync(info.userDataDir), 5000), 'the temp profile was removed');
    assert.strictEqual(armed, 1, 'exactly one watcher was armed for this browser while the run was live');
    assert.ok(await waitFor(() => watchersFor(info.chromePid).length === 0, 5000), 'the watcher exited after reaping');
  } finally {
    if (d.child.exitCode === null && d.child.signalCode === null) d.child.kill('SIGKILL');
    cleanup(info);
  }
});

test('a normal close disarms the watcher: it exits and the run ends cleanly', { timeout: 120000 }, async () => {
  const d = startDriver('normal');
  let info;
  try {
    info = await d.ready;
    const { code } = await d.exited;
    assert.strictEqual(code, 0, 'driver exited 0');
    assert.ok(await waitFor(() => watchersFor(info.chromePid).length === 0, 5000), 'no watcher lingers after a normal close');
    assert.ok(await waitFor(() => !alive(info.chromePid), 5000), 'browser closed');
  } finally {
    cleanup(info);
  }
});

test('the watcher never kills a pid it cannot verify as this browser', { timeout: 30000 }, async () => {
  // A live process that is NOT a browser with this profile: a recycled pid.
  const victim = spawn('sleep', ['60'], { stdio: 'ignore' });
  try {
    for (const dirArg of [path.join(os.tmpdir(), `${PROFILE_PREFIX}not-this-one`), '']) {
      const w = spawn(process.execPath, [REAPER, String(victim.pid), dirArg], { stdio: ['pipe', 'ignore', 'ignore'] });
      const done = new Promise(r => w.on('exit', r));
      w.stdin.end(); // EOF without "done": the driver-died branch
      await done;
      assert.ok(alive(victim.pid), `an unverified pid was killed (dir arg ${JSON.stringify(dirArg)})`);
    }
  } finally {
    victim.kill('SIGKILL');
  }
});

test('armReaper fails open: no process, or a watcher that cannot start, never throws', async () => {
  assert.strictEqual(armReaper(null).pid, null);
  assert.strictEqual(armReaper({ process: () => null }).pid, null);
  const r = armReaper({ process: () => ({ pid: 999999, spawnargs: [] }) }, { nodePath: '/nonexistent/node-binary' });
  assert.doesNotThrow(() => r.disarm());
  assert.doesNotThrow(() => r.disarm());
  await new Promise(res => setTimeout(res, 300)); // the spawn error arrives asynchronously
});

test('only Puppeteer temp profiles directly in the temp dir are removable', () => {
  const tmp = os.tmpdir();
  assert.ok(isRemovableProfile(path.join(tmp, `${PROFILE_PREFIX}abc123`)));
  assert.ok(!isRemovableProfile(path.join(tmp, 'some-other-dir')));
  assert.ok(!isRemovableProfile(path.join(tmp, 'nested', `${PROFILE_PREFIX}abc123`)));
  assert.ok(!isRemovableProfile(path.join(os.homedir(), `${PROFILE_PREFIX}abc123`)));
  assert.ok(!isRemovableProfile(null));
  assert.ok(!isRemovableProfile(''));
});

test('lib/runner.js is the only place a browser is launched, so every browser is watched', () => {
  const hits = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'data', '.git', 'test'].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js') && /puppeteer\s*\.\s*launch\s*\(/.test(fs.readFileSync(p, 'utf8'))) {
        hits.push(path.relative(REPO_ROOT, p));
      }
    }
  };
  walk(REPO_ROOT);
  assert.deepStrictEqual(hits, ['lib/runner.js'], 'a new launch site must arm lib/browserReaper.js too');
  assert.match(fs.readFileSync(path.join(REPO_ROOT, 'lib', 'runner.js'), 'utf8'), /^\s*const reaper = armReaper\(browser\);/m);
});
