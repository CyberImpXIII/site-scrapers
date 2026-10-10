// What a credential looks like, for this repo: by NAME (a key or a selector)
// and by VALUE SHAPE (a token's own prefix and length). One copy of each, so
// no second regex can drift.
//
// Consumers:
//   - lib/storeExport.js refuses to export a stored literal under a
//     credential-named key or typed into a credential-looking selector;
//   - lib/fillContract.js redactRunParams/redactRunError keep a credential a
//     caller passed at run time out of scrape_runs (params_json, error), which
//     is long-lived and read back by lab.js history / adopt-history -- by key
//     name AND by value shape, so a token under a neutral name (`x`, `url`) is
//     caught too (probed 2026-10-09: devtools/probe-run-params.js);
//   - query.js run-secrets counts past rows that hold either.
//
// VALUE_SHAPES is NOT this repo's invention. The authority is tools/checks'
// `no-secrets` SHAPES (the commit-time gate); tools/hooks renders them as ERE
// into .claude/hooks/no-secrets.sh, installed here. test/credential-shapes.test.js
// holds this list to that installed copy BY MEANING: the same kinds in the same
// order, and every sample each side builds is matched by both. A kind added
// there fails the test here until it is added below. Context-hygiene E5 (secrets
// never enter context) should share this rule set rather than write a fourth.
//
// What shape detection cannot see: a plain password ("hunter2-x!") under a
// neutral name. Nothing in its value says it is a secret; only its key can.

// --- by name ------------------------------------------------------------------
// A key is credential-named when it ENDS in a credential word, the same rule
// as no-secrets.sh's keyed literals: `password`, `user_password`, `authToken`,
// `client_secret`, `x-api-key`. The short words (pass, pwd, otp, cvv, cvc,
// ssn) need a word edge before them, so `bypass` and `laptop` are not keys.
// camelCase is split first (isCredentialKey), so `userPass` reads `user_pass`.
const CRED_KEY = /(^|[^a-z0-9])(pass(code)?|pwd|otp|cvv|cvc|ssn)$|(password|passwd|pwd|secret|token|api[_.-]?key|apikey|access[_.-]?key|private[_.-]?key|credentials?|card[_.-]?number)$/i;
const CRED_SELECTOR = /pass(word|wd|code)|secret|token|api[_-]?key|\botp\b|one-time|cvv|cvc|card-?number|\bssn\b/i;

function isCredentialKey(k) {
  if (typeof k !== 'string' || !k) return false;
  return CRED_KEY.test(k.replace(/([a-z0-9])([A-Z])/g, '$1_$2'));
}

// --- by value shape -------------------------------------------------------------
// L / R: the hook's word edges ((^|[^A-Za-z0-9_]) and ([^A-Za-z0-9_]|$)) as
// lookarounds, so a match never includes its neighbour.
const L = '(?<![A-Za-z0-9_])';
const R = '(?![A-Za-z0-9_])';
const VALUE_SHAPES = [
  { kind: 'Anthropic API key', re: new RegExp('sk-ant-[A-Za-z0-9_-]{20,}') },
  { kind: 'OpenAI API key', re: new RegExp(`${L}sk-(proj-)?[A-Za-z0-9]{32,}`) },
  { kind: 'GitHub token', re: new RegExp(`${L}gh[pousr]_[A-Za-z0-9]{36,}`) },
  { kind: 'GitHub fine-grained token', re: new RegExp(`${L}github_pat_[A-Za-z0-9_]{50,}`) },
  { kind: 'AWS access key id', re: new RegExp(`${L}AKIA[0-9A-Z]{16}${R}`) },
  { kind: 'Slack token', re: new RegExp(`${L}xox[abprs]-[A-Za-z0-9-]{10,}`) },
  { kind: 'Google API key', re: new RegExp(`${L}AIza[0-9A-Za-z_-]{35}${R}`) },
  { kind: 'Telegram bot token', re: new RegExp(`${L}[0-9]{8,10}:AA[A-Za-z0-9_-]{33}${R}`) },
  { kind: 'private key block', re: /-----BEGIN (RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/ },
];

// The kind of the first credential shape found anywhere in `s`, or null.
function credentialShapeOf(s) {
  if (typeof s !== 'string' || s.length < 8) return null;
  for (const { kind, re } of VALUE_SHAPES) if (re.test(s)) return kind;
  return null;
}

// `s` with every credential-shaped span replaced by `[redacted]`.
function cutCredentialShapes(s) {
  if (typeof s !== 'string') return s;
  let out = s;
  for (const { re } of VALUE_SHAPES) out = out.replace(new RegExp(re.source, 'g'), '[redacted]');
  return out;
}

module.exports = { CRED_KEY, CRED_SELECTOR, isCredentialKey, VALUE_SHAPES, credentialShapeOf, cutCredentialShapes };
