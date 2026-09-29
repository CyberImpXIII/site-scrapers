// Resolving extracted URL attributes to absolute URLs.
//
// `anchor_attribute` returned the raw attribute, so a record's href was
// absolute or relative depending on how the site happened to write it --
// Greenhouse absolute, dice relative on all 30 of a run. A caller could not
// use record.href without knowing which site produced it.
//
// The risk in fixing it is the opposite mistake: anchor_attribute can pull ANY
// attribute, and resolving a `data-job-id` against a base turns an id into a
// URL. That is a wrong value rather than a missing one, so most of these tests
// are about what must NOT be touched.
//
// Run via `npm test` / `./test.sh`.

const test = require('node:test');
const assert = require('node:assert/strict');
const { isUrlAttribute, resolveUrlValue, resolveUrlFields } = require('../lib/urlAttrs');

const BASE = 'https://www.dice.com/jobs?q=support';

// --- which attributes are URLs at all --------------------------------------

test('only standard URL-bearing attributes are resolved', () => {
  for (const a of ['href', 'src', 'action', 'HREF']) assert.equal(isUrlAttribute(a), true, a);
  // The ones that would be corrupted by resolution.
  for (const a of ['data-job-id', 'aria-label', 'title', 'id', 'class', '', null, undefined]) {
    assert.equal(isUrlAttribute(a), false, String(a));
  }
});

test('a data attribute keeps its value, even when it looks path-like', () => {
  // The dangerous case: `data-job-id="/12345"` resolved against a base becomes
  // a plausible-looking URL, and nothing downstream could tell.
  const records = [{ href: '/job/1', jobId: '/12345' }];
  resolveUrlFields(
    records,
    [
      { field_name: 'href', extract_kind: 'anchor_attribute', attribute_name: 'href' },
      { field_name: 'jobId', extract_kind: 'anchor_attribute', attribute_name: 'data-job-id' },
    ],
    BASE
  );
  assert.equal(records[0].href, 'https://www.dice.com/job/1');
  assert.equal(records[0].jobId, '/12345', 'a non-URL attribute must be untouched');
});

// --- resolving ---------------------------------------------------------------

test('a relative href becomes absolute', () => {
  assert.equal(resolveUrlValue('/job-detail/abc', BASE), 'https://www.dice.com/job-detail/abc');
  assert.equal(resolveUrlValue('jobs/2', 'https://x.com/a/b'), 'https://x.com/a/jobs/2');
  assert.equal(resolveUrlValue('../up', 'https://x.com/a/b/c'), 'https://x.com/a/up');
});

test('an already-absolute href is left alone', () => {
  // Greenhouse writes them absolute; this must be a no-op there.
  const abs = 'https://job-boards.greenhouse.io/splice/jobs/123';
  assert.equal(resolveUrlValue(abs, BASE), abs);
});

test('non-http schemes survive', () => {
  assert.equal(resolveUrlValue('mailto:jobs@x.com', BASE), 'mailto:jobs@x.com');
  assert.equal(resolveUrlValue('tel:+15551234', BASE), 'tel:+15551234');
});

test('an empty attribute does NOT become the page URL', () => {
  // new URL('', base) returns the base, which would silently turn "this card
  // has no link" into "this card links to the search page you were on".
  assert.equal(resolveUrlValue('', BASE), '');
  assert.equal(resolveUrlValue('   ', BASE), '   ');
  assert.equal(resolveUrlValue(null, BASE), null);
  assert.equal(resolveUrlValue(undefined, BASE), undefined);
});

test('an unparseable value keeps what the site actually said', () => {
  // Dropping it would tell us less than showing something odd.
  assert.equal(resolveUrlValue('http://[not a url', BASE), 'http://[not a url');
});

test('with no base, values pass through unchanged', () => {
  // Degrades to the old behaviour rather than throwing, for a page whose
  // baseURI could not be read.
  assert.equal(resolveUrlValue('/job/1', null), '/job/1');
  const records = [{ href: '/job/1' }];
  resolveUrlFields(records, [{ field_name: 'href', extract_kind: 'anchor_attribute', attribute_name: 'href' }], null);
  assert.equal(records[0].href, '/job/1');
});

test('fields from other extract kinds are never touched', () => {
  // `title` happening to contain something URL-shaped is not an attribute.
  const records = [{ title: '/not/a/link', href: '/job/1' }];
  resolveUrlFields(
    records,
    [
      { field_name: 'title', extract_kind: 'child_text', regex_pattern: 'h3' },
      { field_name: 'href', extract_kind: 'anchor_attribute', attribute_name: 'href' },
    ],
    BASE
  );
  assert.equal(records[0].title, '/not/a/link');
  assert.equal(records[0].href, 'https://www.dice.com/job/1');
});

test('a missing key is not invented', () => {
  const records = [{ title: 'x' }];
  resolveUrlFields(records, [{ field_name: 'href', extract_kind: 'anchor_attribute', attribute_name: 'href' }], BASE);
  assert.equal('href' in records[0], false, 'a record without the field must not gain one');
});
