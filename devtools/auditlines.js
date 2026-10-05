#!/usr/bin/env node
// `./dev.sh audit`: `node audit.js units` (JSON on stdin) as one line per
// finding, and a verdict in the exit code so `check --json` can gate on it.
//
//   ERROR <unit> <problem>      an error-severity finding: something is already broken
//   WARN  <unit> <problem>      a warning nobody has checked yet
//   INFO  <unit> <problem>
//   OK/W  <unit> <problem>      a warning already checked (`./dev.sh waive`), with
//         waived <date>: <reason>   the evidence and date, so a stale one shows as stale
//   units: clean                nothing found
//
// Exit 0 with no unwaived ERROR, 1 with one or more (CLAUDE.md: "an `error`
// from the audit means something is already broken"), 2 when the input is not
// the audit's JSON (the audit broke: never read as clean). Was an inline
// `node -e` in dev.sh that always exited 0.
'use strict';

function lines(doc) {
  const out = [];
  let errors = 0;
  for (const f of doc.unitInvariants || []) {
    // A waived finding is one already checked against the live site, so it
    // reads as settled rather than outstanding.
    const tag = f.waived ? 'OK/W' : String(f.severity).toUpperCase();
    if (!f.waived && f.severity === 'error') errors++;
    out.push(`${tag.padEnd(5)} ${String(f.unit).padEnd(52)} ${f.problem}`);
    if (f.waived) out.push(`      waived ${f.waived.on}: ${f.waived.reason}`);
  }
  if (!(doc.unitInvariants || []).length) out.push('units: clean');
  return { out, errors };
}

function main() {
  let raw = '';
  process.stdin.on('data', (d) => { raw += d; }).on('end', () => {
    let doc;
    try { doc = JSON.parse(raw); } catch { doc = null; }
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.unitInvariants)) {
      console.log(`  ERROR  audit.js units did not print its JSON (${raw.length} bytes): the audit broke, nothing was checked`);
      process.exitCode = 2;
      return;
    }
    const { out, errors } = lines(doc);
    console.log(out.join('\n'));
    process.exitCode = errors ? 1 : 0;
  });
}

module.exports = { lines };

if (require.main === module) main();
