#!/usr/bin/env node
// This repo's `./dev.sh check --json`: one document in the one schema every
// repo's check prints (ok, checks[] of name/status/counts/failures, each failure
// with message, file, line and role; the shared checks tool holds the schema,
// tools/checks/schema/check-json.schema.json, PLAN-agent-groups.md §4.4). Same
// shape and row format as applications', emailTools' and tools/hub's
// devtools/checkjson.py, in Node because this repo is Node; the finding lines
// read here are this repo's own gates'.
//
//   devtools/checkjson.js <gate>:<role>:<exit code>:<output file> ...
//
// One check per gate, in the order given. The exit code is the gate's own
// verdict (dev.sh's gate_* functions: 0 ok, 1 fail, 3 unchecked), never
// re-judged from the output:
//
//   0      `ok`, no failures, whatever the output says
//   3      `unchecked`, `reason` from its `UNCHECKED  <why>` line; `ok` stays true
//   1      `fail`, one failure per finding line in the gate's captured output
//   other  `error` (the gate broke: a crash, a kill, the lock), same findings
//
// Finding lines:
//
//   test       node:test's TAP, as test.sh prints a red run: each `not ok N -
//              <name>` (any depth) whose YAML block is not `failureType:
//              'subtestsFailed'` (a parent that only says a child failed --
//              the child is its own finding). Message `<name>: <error>` with
//              this repo's absolute prefix dropped, file and line from its
//              `location:`.
//   audit      devtools/auditlines.js's `ERROR <unit> <problem>` (column 0); a
//              WARN or a waived OK/W is not a finding (the gate exits 0 on them)
//   any other  `  FAIL  <finding>` or `  ERROR  <finding>` (two spaces in;
//              check-hooks.sh prints ERROR), with the lines under it indented
//              six or more joined into its message (check-hooks.sh prints a
//              drifted hook's copies so)
//
// `file`/`line` are set only where the output itself says them and the file
// exists in this repo: a TAP `location:`, or a leading `<path>:` /
// `<path>:<line>:`. Otherwise both are null (prefer null to a guess). A red gate
// with no finding line still gets one failure naming the gate, so a `fail`
// always says what. Prints the document and exits 0 iff `ok`.
//
// test/check-json.test.js holds this against test/fixtures/check-*.json, with a
// mutant per shape rule, and in the workspace against the real validator.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const FAIL = /^ {2}(?:FAIL|ERROR)\s+(.*\S)/;
const DETAIL = /^ {6,}(\S.*)/;
const UNCHECKED = /^\s*UNCHECKED\s+(.*\S)/;
const NOT_OK = /^(\s*)not ok \d+ - (.*\S)/;
const AUDIT_ERROR = /^ERROR\s+(\S.*)/;
const AT = /^([^\s:]+):(?:(\d+):)?/;
const STATUS = { 0: 'ok', 1: 'fail', 3: 'unchecked' };
const MAX_MESSAGE = 300;

// `p` repo-relative when it is a file inside this repo, else null.
function repoFile(p) {
  try {
    const abs = fs.realpathSync(path.resolve(ROOT, p));
    const rel = path.relative(fs.realpathSync(ROOT), abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return fs.statSync(abs).isFile() ? rel.split(path.sep).join('/') : null;
  } catch { return null; }
}

// [file, line] from a leading `<path>:` or `<path>:<line>:` naming a file here.
function place(msg) {
  const m = AT.exec(msg);
  const rel = m ? repoFile(m[1]) : null;
  if (!rel) return [null, null];
  const line = m[2] && Number(m[2]) >= 1 ? Number(m[2]) : null;
  return [rel, line];
}

const squash = (s) => s.replace(/\s+/g, ' ').trim();

// node:test names a file that would not load by its absolute path; a message is
// read on other machines, so this repo's own prefix is dropped from it.
function unrooted(s) {
  let real = ROOT;
  try { real = fs.realpathSync(ROOT); } catch { /* ROOT as given */ }
  return [...new Set([ROOT, real])].reduce((acc, r) => acc.split(`${r}${path.sep}`).join(''), s);
}
const clip = (s) => (s.length > MAX_MESSAGE ? `${s.slice(0, MAX_MESSAGE - 3)}...` : s);

function unquote(v) {
  const m = /^'(.*)'$/.exec(v);
  return m ? m[1].replace(/''/g, "'") : v;
}

// The YAML block under a `not ok` line: { location, failureType, error }.
// Only the three keys read here; a block scalar (`|-`) is its indented lines.
function yamlBlock(lines, start, indent) {
  const out = {};
  const key = new RegExp(`^${' '.repeat(indent + 2)}(\\w+):\\s?(.*)$`);
  let i = start;
  if (!lines[i] || lines[i].trim() !== '---') return [out, start];
  for (i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '...') return [out, i + 1];
    const m = key.exec(l);
    if (!m) continue;
    const [, k, v] = m;
    if (v === '|-' || v === '|' || v === '>-') {
      const body = [];
      while (i + 1 < lines.length && (lines[i + 1].startsWith(' '.repeat(indent + 4)) || lines[i + 1].trim() === '')) {
        if (lines[i + 1].trim() === '...') break;
        body.push(lines[++i]);
      }
      out[k] = squash(body.join(' '));
    } else {
      out[k] = unquote(v.trim());
    }
  }
  return [out, i];
}

function tapFindings(lines) {
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const m = NOT_OK.exec(lines[i]);
    if (!m) continue;
    const [y] = yamlBlock(lines, i + 1, m[1].length);
    if (y.failureType === 'subtestsFailed') continue;
    let file = null, line = null;
    const loc = /^(.*):(\d+):\d+$/.exec(y.location || '');
    if (loc) {
      file = repoFile(loc[1]);
      line = file && Number(loc[2]) >= 1 ? Number(loc[2]) : null;
    }
    const why = y.error ? `: ${y.error}` : '';
    found.push([clip(squash(unrooted(`${m[2]}${why}`))), file, line]);
  }
  return found;
}

function genericFindings(lines) {
  const found = [];   // [head, [detail]]
  let cur = null;
  for (const l of lines) {
    const m = FAIL.exec(l);
    let d;
    if (m) { cur = [m[1], []]; found.push(cur); }
    else if (cur && (d = DETAIL.exec(l))) cur[1].push(squash(d[1]));
    else cur = null;
  }
  // check-hooks.sh ends a head that introduces its detail with a colon
  return found.map(([head, detail]) =>
    [clip(head + (detail.length ? `${head.endsWith(':') ? '' : ':'} ${detail.join(' | ')}` : '')), ...place(head)]);
}

// devtools/auditlines.js's `ERROR <unit> <problem>` (column 0): a recipe's
// finding, so no file -- recipes live in the DB.
function auditFindings(lines) {
  return lines.map((l) => AUDIT_ERROR.exec(l)).filter(Boolean).map((m) => [clip(squash(m[1])), null, null]);
}

const READERS = { test: tapFindings, audit: auditFindings };

// [[message, file, line]] for every finding line in a red gate's output: the
// gate's own reader first, then the generic `  FAIL  ` / `  ERROR  ` lines.
function findings(gate, text) {
  const lines = text.split(/\r?\n/);
  const own = READERS[gate] ? READERS[gate](lines) : [];
  return own.length ? own : genericFindings(lines);
}

function check(gate, role, code, text) {
  const status = STATUS[code] || 'error';
  let found = status === 'fail' || status === 'error' ? findings(gate, text) : [];
  if ((status === 'fail' || status === 'error') && !found.length) {
    // its last line, as it said it, is the best evidence there is of what
    const last = text.split(/\r?\n/).map(squash).filter(Boolean).pop();
    found = [[clip(`gate ${gate} ${status === 'fail' ? 'failed' : 'broke'} (exit ${code}) with no finding line;`
      + (last ? ` its last line: ${last}` : ' it printed nothing')), null, null]];
  }
  const failures = found.map(([message, file, line]) => ({ message, file, line, role }));
  const out = { name: gate, status };
  if (status === 'unchecked') {
    const why = text.split(/\r?\n/).map((l) => UNCHECKED.exec(l)).find(Boolean);
    out.reason = why ? why[1] : `gate ${gate} exited 3 (unchecked) without saying why`;
  }
  out.counts = { failed: failures.length };
  // The audit's warnings are not failures (it exits 0 on them), but they are
  // findings nobody has checked yet: counted, so the JSON drops nothing the
  // text check shows.
  if (gate === 'audit') {
    out.counts.warnings = text.split(/\r?\n/).filter((l) => /^WARN\s/.test(l)).length;
    out.counts.waived = text.split(/\r?\n/).filter((l) => /^OK\/W\s/.test(l)).length;
  }
  out.failures = failures;
  return out;
}

function parse(args) {
  return args.map((a) => {
    const parts = a.split(':');
    if (parts.length < 4) throw new Error(a);
    const [gate, role, code] = parts;
    const file = parts.slice(3).join(':');
    if (!gate || !role || !/^\d+$/.test(code) || !file) throw new Error(a);
    return [gate, role, Number(code), file];
  });
}

function read(p) {
  try { return fs.readFileSync(p, 'utf8'); }
  catch (e) { return `  FAIL  the gate's output could not be read: ${e.code || e.message}`; }
}

function main(argv) {
  let rows;
  try { rows = parse(argv); }
  catch {
    process.stderr.write(`usage: devtools/checkjson.js <gate>:<role>:<exit code>:<output file> ... (got ${JSON.stringify(argv)})\n`);
    return 64;
  }
  if (!rows.length) {
    process.stderr.write('checkjson: no gates: a report of nothing is not a pass\n');
    return 64;
  }
  const checks = rows.map(([g, r, c, p]) => check(g, r, c, read(p)));
  const doc = { ok: checks.every((c) => c.status === 'ok' || c.status === 'unchecked'), checks };
  process.stdout.write(`${JSON.stringify(doc)}\n`);
  return doc.ok ? 0 : 1;
}

module.exports = { check, findings, parse, ROOT };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
