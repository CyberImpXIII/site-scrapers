// A browser must not outlive the process that launched it.
//
// WHY THIS EXISTS. Puppeteer starts Chrome `detached` (its own process group,
// its own session) and relies on handlers in the DRIVER process -- `exit`,
// SIGINT, SIGTERM, SIGHUP -- to kill it. SIGKILL runs no handler. So when a
// driver is SIGKILLed (a harness timeout, a killed tool call, an OOM kill), its
// Chrome is reparented to PID 1 and stays up, idle, holding its temp profile.
// Being in its own group, it also survives a kill aimed at the caller's group.
// Found 2026-10-10: four Chrome for Testing browsers (plus their crashpad
// handlers) alive 25h after a suite run at 2026-10-09 01:01, their open tabs
// this repo's own test fixtures (extraction /chips, multi-select ?multi=pre,
// submit ?outcome=confirm). Their engine.js drivers were gone, and nothing in
// this repo could have noticed.
//
// THE MECHANISM. armReaper() spawns a tiny watcher, itself detached, holding
// the read end of a pipe whose write end only the driver has. The OS closes that
// pipe however the driver dies, SIGKILL included, so the watcher sees EOF:
//   - "done" before EOF  -> the driver closed the browser itself; exit quietly.
//   - EOF without "done" -> the driver died with the browser possibly up: kill
//     the browser's process group, then remove its temp profile.
// A driver that exits through process.exit() mid-run also lands in the second
// branch. Puppeteer's own `exit` handler has already SIGKILLed Chrome then, but
// it cannot remove the profile asynchronously, so those directories were left
// in $TMPDIR (2040 of them on 2026-10-10); the watcher removes them.
//
// A WRONG KILL IS WORSE THAN A LEFTOVER. Before killing, the watcher checks
// with `ps` that the pid is still a process whose command line carries this
// browser's --user-data-dir; a recycled pid, or a `ps` it cannot read, means no
// kill. The profile is removed only if it sits directly in os.tmpdir() under
// Puppeteer's own `puppeteer_dev_chrome_profile-` prefix (a caller's own
// userDataDir is never touched).
//
// FAILS OPEN. A watcher that cannot start leaves the run exactly as it was
// before this file existed; it never fails a scrape.
//
// Gates: test/browser-reaper.test.js (a SIGKILLed driver leaves no browser and
// no profile; a normal close leaves no watcher and kills nothing; an
// unverified pid is never killed; a watcher that cannot spawn fails open).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const PROFILE_PREFIX = 'puppeteer_dev_chrome_profile-';
const DONE = 'done\n';

function userDataDirOf(spawnargs) {
  for (const a of spawnargs || []) {
    if (typeof a === 'string' && a.startsWith('--user-data-dir=')) return a.slice('--user-data-dir='.length);
  }
  return null;
}

// Only Puppeteer's own throwaway profile, directly inside the temp dir.
function isRemovableProfile(dir) {
  if (!dir) return false;
  const real = p => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const resolved = path.resolve(dir);
  return real(path.dirname(resolved)) === real(os.tmpdir()) && path.basename(resolved).startsWith(PROFILE_PREFIX);
}

/**
 * Arms a watcher for `browser` (a Puppeteer Browser it launched). Returns
 * `{ pid, disarm() }`; call disarm() once browser.close() has finished. Never
 * throws: with no process to watch (connect mode, Windows) or a watcher that
 * will not start, it returns a no-op with `pid: null`.
 * `nodePath` exists so the test can prove the fail-open path.
 */
function armReaper(browser, { nodePath = process.execPath } = {}) {
  const noop = { pid: null, disarm() {} };
  if (process.platform === 'win32') return noop;
  let proc;
  try {
    proc = browser && typeof browser.process === 'function' ? browser.process() : null;
  } catch {
    return noop;
  }
  if (!proc || !proc.pid) return noop;
  const dir = userDataDirOf(proc.spawnargs);
  let child;
  try {
    child = spawn(nodePath, [__filename, String(proc.pid), dir || ''], {
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
  } catch {
    return noop;
  }
  child.on('error', () => {}); // ENOENT etc. arrives here, asynchronously: fail open
  child.stdin.on('error', () => {}); // EPIPE if the watcher already went: never crash the driver
  child.unref();
  child.stdin.unref?.();
  let disarmed = false;
  return {
    pid: child.pid || null,
    disarm() {
      if (disarmed) return;
      disarmed = true;
      try {
        child.stdin.end(DONE);
      } catch {
        /* fail open */
      }
    },
  };
}

// --- the watcher process ---------------------------------------------------

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// Is `pid` still THIS browser? Unreadable means no.
function stillOurBrowser(pid, dir) {
  if (!dir) return false;
  let cmd;
  try {
    cmd = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return false;
  }
  return cmd.includes(`--user-data-dir=${dir}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function reap(pid, dir) {
  if (alive(pid) && stillOurBrowser(pid, dir)) {
    // The browser leads its own group (Puppeteer launches it detached): the
    // group kill takes the renderers and GPU process with it.
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    for (let i = 0; i < 50 && alive(pid); i++) await sleep(100);
  }
  if (!alive(pid) && isRemovableProfile(dir)) {
    // Chrome's helpers can still be writing for a moment after the kill.
    for (let i = 0; i < 5; i++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        if (!fs.existsSync(dir)) break;
      } catch {
        /* retry */
      }
      await sleep(200);
    }
  }
}

function runWatcher(pid, dir) {
  let got = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => {
    got += d;
  });
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (got.includes(DONE.trim())) process.exit(0);
    reap(pid, dir).finally(() => process.exit(0));
  };
  process.stdin.on('end', finish);
  process.stdin.on('error', finish);
}

if (require.main === module) {
  const pid = parseInt(process.argv[2], 10);
  const dir = process.argv[3] || null;
  if (!Number.isInteger(pid) || pid <= 1) process.exit(2);
  runWatcher(pid, dir);
}

module.exports = { armReaper, userDataDirOf, isRemovableProfile, stillOurBrowser, PROFILE_PREFIX };
