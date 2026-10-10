// Counts the scrape_runs rows that hold a credential, by key NAME or by value
// SHAPE (lib/credentialShapes.js), in params_json or in error. Reports key
// names, shape kinds and counts -- never a value. `node query.js run-secrets`;
// test/credential-shapes.test.js.
//
// A credential-named key counts as `unredacted` unless its stored value is a
// redaction marker ({ redacted: true }); `answers` (personal data, kept as key
// names only since 2026-10) likewise.

const { isCredentialKey, credentialShapeOf } = require('./credentialShapes');

function scanRunRows(rows) {
  const byKeyName = {};
  const byShape = {};
  const errorShapes = {};
  let rowsWithCredential = 0;
  let answersUnredacted = 0;
  let unparsed = 0;

  for (const row of rows) {
    let hit = false;
    const keysHere = new Map(); // key -> unredacted?
    const shapesHere = new Map(); // kind -> Set of keys
    const walk = (v, key, depth) => {
      if (depth > 8 || v === null || v === undefined) return;
      if (typeof v === 'string') {
        const kind = credentialShapeOf(v);
        if (kind) {
          if (!shapesHere.has(kind)) shapesHere.set(kind, new Set());
          shapesHere.get(kind).add(key);
        }
        return;
      }
      if (typeof v !== 'object') return;
      if (Array.isArray(v)) return v.forEach(x => walk(x, key, depth + 1));
      for (const [k, x] of Object.entries(v)) {
        if (isCredentialKey(k)) {
          const unredacted = !(x && typeof x === 'object' && x.redacted === true);
          keysHere.set(k, (keysHere.get(k) || false) || unredacted);
        }
        walk(x, k, depth + 1);
      }
    };
    let params;
    try {
      params = JSON.parse(row.params_json || '{}');
    } catch {
      unparsed++;
      params = null;
    }
    if (params && typeof params === 'object') {
      walk(params, '(top)', 0);
      if ('answers' in params && !(params.answers && params.answers.redacted === true)) answersUnredacted++;
    }
    for (const [k, unredacted] of keysHere) {
      const e = (byKeyName[k] ||= { rows: 0, unredacted: 0 });
      e.rows++;
      if (unredacted) {
        e.unredacted++;
        hit = true;
      }
    }
    for (const [kind, keys] of shapesHere) {
      const e = (byShape[kind] ||= { rows: 0, keys: [] });
      e.rows++;
      for (const k of keys) if (!e.keys.includes(k)) e.keys.push(k);
      hit = true;
    }
    const ek = credentialShapeOf(row.error);
    if (ek) {
      errorShapes[ek] = (errorShapes[ek] || 0) + 1;
      hit = true;
    }
    if (hit) rowsWithCredential++;
  }

  return {
    rows: rows.length,
    rowsWithCredential,
    byKeyName,
    byShape,
    errorShapes,
    answersUnredacted,
    unparsedParams: unparsed,
    valuesShown: false,
  };
}

module.exports = { scanRunRows };
