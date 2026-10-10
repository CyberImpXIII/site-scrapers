// Driver for test/browser-reaper.test.js: launches a browser the way every run
// does (lib/runner.js withPage), prints one JSON line naming it, then either
// hangs inside the run (mode "hang", for the test to SIGKILL) or returns
// normally (mode "normal").
const { withPage } = require('../../lib/runner');
const { userDataDirOf } = require('../../lib/browserReaper');

const mode = process.argv[2] || 'hang';

withPage(async page => {
  const proc = page.browser().process();
  process.stdout.write(`${JSON.stringify({ chromePid: proc.pid, userDataDir: userDataDirOf(proc.spawnargs) })}\n`);
  if (mode === 'hang') await new Promise(() => {});
}).then(
  () => process.exit(0),
  e => {
    process.stderr.write(`${e && e.stack}\n`);
    process.exit(1);
  }
);
