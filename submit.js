#!/usr/bin/env node
// The approve side's half of the submit contract (docs/submit-output.md).
//
//   node submit.js hash @params.json
//
// params.json holds {url, fields, answers}: the same three the submit action
// is given. Prints {"submissionHash": "<64 hex>", "descriptionHash", "files"}.
// The approval lists each packet's submissionHash; the submit step recomputes
// it from what it is handed and refuses `packet_changed` on any difference.
// One implementation (lib/submitContract.js) so the two sides cannot drift.
// Prints no value; reads params only from a file, never argv.

process.removeAllListeners('warning');
const fs = require('fs');
const { submissionHash, CONTRACT } = require('./lib/submitContract');

function out(o, code) {
  process.stdout.write(`${JSON.stringify(o)}\n`, () => process.exit(code));
}

const [, , cmd, arg] = process.argv;
if (cmd !== 'hash' || !arg || !arg.startsWith('@')) {
  out({ success: false, error: 'Usage: node submit.js hash @params.json   (params: {url, fields, answers}; a file, never inline)' }, 1);
} else {
  let params;
  try {
    params = JSON.parse(fs.readFileSync(arg.slice(1), 'utf8'));
  } catch (e) {
    // Not e.message: a JSON.parse message quotes the text around the fault,
    // which here is an answer.
    out({ success: false, error: `params file is not readable JSON (${e.code || e.name})` }, 1);
    return;
  }
  const h = submissionHash(params || {});
  if (h.error) out({ success: false, error: h.error }, 1);
  else out({ success: true, contract: CONTRACT, submissionHash: h.hash, descriptionHash: h.descriptionHash, files: h.files }, 0);
}
