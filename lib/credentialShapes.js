// The one list of what a credential looks like BY NAME, for this repo.
//
// Two consumers, so one copy (a second regex would drift):
//   - lib/storeExport.js refuses to export a stored literal under a
//     credential-named key or typed into a credential-looking selector;
//   - lib/fillContract.js redactRunParams/redactRunError keep a credential a
//     caller passed at run time out of scrape_runs (params_json, error), which
//     is long-lived and read back by lab.js history / adopt-history.
//
// Structural only: key and selector NAMES. Value shapes (token prefixes, JWTs)
// are the data repo's no-secrets gate, not a third copy here.

const CRED_KEY = /^(pass(word|wd|code)?|pwd|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|otp|cvv|cvc|card[_-]?number|ssn)$/i;
const CRED_SELECTOR = /pass(word|wd|code)|secret|token|api[_-]?key|\botp\b|one-time|cvv|cvc|card-?number|\bssn\b/i;

function isCredentialKey(k) {
  return typeof k === 'string' && CRED_KEY.test(k);
}

module.exports = { CRED_KEY, CRED_SELECTOR, isCredentialKey };
