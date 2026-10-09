// One submit click per (batch, packet), ever, on this machine.
//
// The submit step claims an entry BEFORE it clicks, with an exclusive create
// (`wx`): a second run for the same approved packet -- a retry after an
// `unknown`, a duplicated call, two processes at once -- finds the claim and
// refuses `already_attempted` without touching the page. A retry could send a
// second application under Jacob's name; a new yes (a new batch id) is the
// only way to send the same packet again.
//
// Each entry holds ids, the submission hash and the outcome. No answer values.
// The directory is data/submit-ledger/ (gitignored, mode 0700, files 0600).
// SS_SUBMIT_LEDGER_DIR moves it, for the test suite.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function ledgerDir() {
  return process.env.SS_SUBMIT_LEDGER_DIR || path.join(__dirname, '..', 'data', 'submit-ledger');
}

function entryPath(batchId, packetId) {
  const key = crypto.createHash('sha256').update(`${batchId}\n${packetId}`).digest('hex').slice(0, 32);
  return path.join(ledgerDir(), `${key}.json`);
}

// true / false, or null when the ledger cannot be read (the caller refuses).
function attempted(batchId, packetId) {
  try {
    fs.accessSync(entryPath(batchId, packetId));
    return true;
  } catch (e) {
    return e.code === 'ENOENT' ? false : null;
  }
}

// { ok: true } | { ok: false, reason: 'already_attempted' | 'ledger_unavailable' }
function claim(batchId, packetId, submissionHash) {
  const file = entryPath(batchId, packetId);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const fd = fs.openSync(file, 'wx', 0o600);
    try {
      fs.writeSync(fd, JSON.stringify({ batchId, packetId, submissionHash, claimedAt: new Date().toISOString(), status: null, reason: null }));
    } finally {
      fs.closeSync(fd);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.code === 'EEXIST' ? 'already_attempted' : 'ledger_unavailable' };
  }
}

// After the click: the outcome is added to the claim. Best effort -- the claim
// itself is what blocks a second click, and it is already on disk.
function record(batchId, packetId, status, reason) {
  const file = entryPath(batchId, packetId);
  try {
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...entry, status, reason, recordedAt: new Date().toISOString() }), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

module.exports = { ledgerDir, entryPath, attempted, claim, record };
