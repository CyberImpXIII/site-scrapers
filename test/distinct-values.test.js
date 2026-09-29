// Per-field value spread, and the cross-field signal that catches positional
// drift.
//
// The fault this exists for: workingnomads.com puts location, commitment and
// experience level in sibling div.box elements, so `location` at index 0 is
// correct only while every card has all of them. A card missing one shifts the
// rest up, and then `location` holds "Part-time" -- a WRONG value, on a recipe
// whose null counts are all zero and which therefore looks healthy. The tests
// below are mostly about that shape: partial drift, on a minority of records.
//
// Run via `npm test` / `./test.sh`.

const test = require('node:test');
const assert = require('node:assert/strict');
const { distinctByField, crossFieldValues } = require('../lib/distinctValues');

// --- distinctByField --------------------------------------------------------

test('counts distinct values per field, most frequent first', () => {
  const d = distinctByField([
    { location: 'Germany' },
    { location: 'Belgium' },
    { location: 'Germany' },
  ]);
  assert.equal(d.location.distinct, 2);
  assert.deepEqual(d.location.top, [
    { value: 'Germany', n: 2 },
    { value: 'Belgium', n: 1 },
  ]);
  assert.equal(d.location.truncated, 0);
});

test('nulls, undefined and whitespace-only values are not values', () => {
  const d = distinctByField([
    { salary: null },
    { salary: undefined },
    { salary: '   ' },
    { salary: '' },
    { salary: '$4000' },
  ]);
  // One real value out of five records -- and crucially the field still
  // APPEARS, because "only 1 of 57 cards has a salary" is the finding.
  assert.equal(d.salary.distinct, 1);
  assert.deepEqual(d.salary.top, [{ value: '$4000', n: 1 }]);
});

test('a field that is null on every record is omitted entirely', () => {
  const d = distinctByField([{ company: null }, { company: null }]);
  assert.equal('company' in d, false);
});

test('values are trimmed before being compared', () => {
  // Otherwise ' Germany' and 'Germany' report as two countries, and the
  // distinct count -- the whole signal -- is inflated by markup whitespace.
  const d = distinctByField([{ location: ' Germany ' }, { location: 'Germany' }]);
  assert.equal(d.location.distinct, 1);
  assert.deepEqual(d.location.top, [{ value: 'Germany', n: 2 }]);
});

test('limit caps the listed values and reports how many were dropped', () => {
  const records = Array.from({ length: 10 }, (_, i) => ({ location: `city-${i}` }));
  const d = distinctByField(records, { limit: 3 });
  assert.equal(d.location.distinct, 10);
  assert.equal(d.location.top.length, 3);
  assert.equal(d.location.truncated, 7);
});

test('non-string values are counted rather than dropped', () => {
  // A numeric field is still a field whose spread matters, and silently
  // skipping it would report "no values" for a field that has them.
  const d = distinctByField([{ n: 0 }, { n: 0 }, { n: 5 }]);
  assert.equal(d.n.distinct, 2);
  assert.deepEqual(d.n.top[0], { value: '0', n: 2 });
});

test('empty and absent record sets do not throw', () => {
  assert.deepEqual(distinctByField([]), {});
  assert.deepEqual(distinctByField(null), {});
  assert.deepEqual(distinctByField([null, undefined]), {});
});

// --- crossFieldValues: the drift signal -------------------------------------

test('a value under two field names is reported with both fields', () => {
  const shared = crossFieldValues([
    { location: 'Germany', commitment: 'Part-time' },
    // This card was missing its location box, so the index slid: commitment's
    // value is now sitting in location.
    { location: 'Part-time', commitment: 'Entry Level' },
  ]);
  assert.equal(shared.length, 1);
  assert.equal(shared[0].value, 'Part-time');
  assert.deepEqual(
    shared[0].fields.map((f) => f.field).sort(),
    ['commitment', 'location'],
  );
});

test('partial drift is caught -- most records being correct does not mask it', () => {
  // The realistic shape, and the reason this is a cross-RECORD check rather
  // than a per-record one: 9 of 10 cards are right.
  const records = Array.from({ length: 9 }, () => ({ location: 'Germany', commitment: 'Part-time' }));
  records.push({ location: 'Part-time', commitment: 'Entry Level' });
  const shared = crossFieldValues(records);
  assert.equal(shared.length, 1);
  assert.equal(shared[0].value, 'Part-time');
  // The counts say WHERE it belongs: 9 as commitment, 1 as location.
  const byField = Object.fromEntries(shared[0].fields.map((f) => [f.field, f.n]));
  assert.deepEqual(byField, { commitment: 9, location: 1 });
});

test('a clean record set reports no drift', () => {
  const shared = crossFieldValues([
    { title: 'Data Analyst', company: 'Peroptyx', location: 'Germany' },
    { title: 'AI Content Analyst', company: 'Acme', location: 'Belgium' },
  ]);
  assert.deepEqual(shared, []);
});

test('a value repeated in the SAME field on many records is not drift', () => {
  // Every card sharing a location is normal; it must not be flagged.
  const shared = crossFieldValues([{ location: 'Remote' }, { location: 'Remote' }]);
  assert.deepEqual(shared, []);
});

test('two fields legitimately holding the same value are still reported', () => {
  // Not every hit is a bug -- a company named after its city, say. The tool
  // reports candidates and a human judges; a signal that tried to be clever
  // about which coincidences are innocent would suppress the real ones.
  const shared = crossFieldValues([{ company: 'Berlin', location: 'Berlin' }]);
  assert.equal(shared.length, 1);
});

test('long values are excluded, so a blurb repeated as a title is not a hit', () => {
  const long = 'x'.repeat(200);
  assert.deepEqual(crossFieldValues([{ blurb: long, description: long }]), []);
  // ...but the same pair at a short length IS a hit, proving the exclusion is
  // about length and not about those field names.
  assert.equal(crossFieldValues([{ blurb: 'short', description: 'short' }]).length, 1);
});

test('maxLen is a parameter, not a baked-in constant', () => {
  const v = 'y'.repeat(80);
  assert.deepEqual(crossFieldValues([{ a: v, b: v }]), []);
  assert.equal(crossFieldValues([{ a: v, b: v }], { maxLen: 100 }).length, 1);
});

test('values shared by three fields sort above values shared by two', () => {
  const shared = crossFieldValues([
    { a: 'zzz', b: 'zzz' },
    { c: 'aaa', d: 'aaa', e: 'aaa' },
  ]);
  assert.equal(shared[0].value, 'aaa');
  assert.equal(shared[0].fields.length, 3);
  assert.equal(shared[1].value, 'zzz');
});

test('nulls never collide -- two fields both null is not shared', () => {
  assert.deepEqual(crossFieldValues([{ a: null, b: null }, { a: '', b: '  ' }]), []);
});

test('empty and absent record sets do not throw', () => {
  assert.deepEqual(crossFieldValues([]), []);
  assert.deepEqual(crossFieldValues(null), []);
  assert.deepEqual(crossFieldValues([null]), []);
});
