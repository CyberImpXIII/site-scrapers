// How lab.js summarises what the internal prober handed back. Pulled out of
// lab.js (which runs main() on require) so the two failure shapes it has
// tripped on are tested: test/lab-report.test.js.

// One line for a forms probe. An errored probe has no `fields`, and reading
// its length threw (pantheon.io, 2026-10-05), which killed the whole `lab.js
// probe` output over one probe's failure.
function formsSummary(p) {
  return Array.isArray(p?.fields)
    ? { fields: p.fields.length, required: p.requiredCount, fileUpload: p.fileUploadPresent, submits: p.submits }
    : { fields: null, error: p?.error ?? 'forms probe returned no field list' };
}

// Why a prober run failed. The engine does not always set `error` (a 404
// board slug did not), and the message read "prober run failed: undefined" --
// the one thing it must carry is why. Falls back to what the run DID say.
function proberFailure(r) {
  if (!r || typeof r !== 'object') return 'the engine returned nothing readable';
  if (r.error) return String(r.error);
  const parts = [];
  if (r.failedStep !== undefined && r.failedStep !== null) parts.push(`failed at step ${JSON.stringify(r.failedStep)}`);
  if (r.timedOut) parts.push('timed out waiting for the page');
  if (r.url) parts.push(`last at ${r.url}`);
  return parts.length ? parts.join('; ') : 'the page did not load (the engine gave no error, step or url)';
}

module.exports = { formsSummary, proberFailure };
