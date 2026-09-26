#!/usr/bin/env node
// Inspect what's already documented — this is the tool a context-less
// session should reach for FIRST, before assuming a site needs interactive
// re-discovery.
//
// Usage:
//   node query.js sites                                    # list every known recipe + status
//   node query.js site <hostname>[#page_type[:recipe_name]] # full recipe + fields for one site
//   node query.js runs <hostname>[#page_type[:recipe_name]] [n] # recent run history (reliability)
//   node query.js action-types                              # the action_type taxonomy for page_type "action"
//   node query.js sessions [hostname]                        # saved session cookie jars (metadata only, never cookie values)
//   node query.js clear-session <hostname>[:sessionName]      # delete one saved session, forcing a fresh login/handoff next run
//   node query.js expand <hostname>#page_type:recipe_name     # flatten a ui_steps recipe's run_action/run_generic_action references
//   node query.js expand generic:<name>                       # same, for a generic_actions library entry
//   node query.js generic-actions                             # list the generic_actions library (name/description/action_type, no steps)
//   node query.js generic-action <name>                       # one generic action, full detail including steps
//   node query.js versions <hostname>[#page_type[:recipe_name]] # recipe version history (v<major>.<minor>, which are stable, per-version run record)
//   node query.js diff <hostname>[#...] [vA] [vB]             # what changed between two versions (defaults: last stable vs current)
//   node query.js promote <hostname>[#...] [note]             # publish the current definition as the next major (a permanent, never-pruned vN.0)
//   node query.js health [recentN]                            # observed reliability per recipe vs its declared status (default last 10 runs)
//   node query.js efficiency                                  # real output-size history per recipe (avg/min/max chars + rough est. tokens)
//   node query.js debug-captures                              # failed-run diagnostics (screenshot/DOM/console/network dirs), newest last
//
// #page_type ('#listing' | '#article' | '#action') picks which recipe when a
// hostname has more than one; omitting it defaults to 'listing'. A hostname
// can also have more than one recipe of the SAME page_type (e.g. two
// 'action' recipes) — add ':recipe_name' to disambiguate, e.g.
// "example.com#action:login". Omitting it defaults to 'default'. Run
// `node query.js sites` to see every (hostname, page_type, recipe_name)
// combination that's registered.
//
// Before registering a NEW 'action' recipe, run `node query.js action-types`
// and prefer reusing an existing action_type over inventing a near-duplicate
// (e.g. "add_to_cart" vs "add-to-basket") — register.js enforces this.

const {
  openDb,
  listSites,
  getSite,
  getFields,
  getRuns,
  getRecipeHealth,
  getEfficiencyStats,
  parseSiteArg,
  listActionTypes,
  listGenericActions,
  getGenericAction,
  listVersions,
  getVersion,
  getCurrentVersion,
  getLastStableVersion,
  promoteVersion,
  restoreVersion,
} = require('./db');
const { listSessions, clearSession } = require('./lib/sessions');
const { expandSteps, refKey, genericRefKey } = require('./lib/composeActions');
const { listDebugCaptures } = require('./lib/debug');

// A diff is only useful if you can read it. `notes` in particular runs to
// several hundred characters, and printing both copies in full buries a
// one-word edit in ~1200 characters of identical prose — the opposite of
// what this tool is for. For long strings, report only the differing span
// plus a little context on each side.
const DIFF_FULL_TEXT_LIMIT = 160;
function compactChange(from, to) {
  if (typeof from !== 'string' || typeof to !== 'string') return { from, to };
  if (from.length <= DIFF_FULL_TEXT_LIMIT && to.length <= DIFF_FULL_TEXT_LIMIT) return { from, to };

  let head = 0;
  while (head < from.length && head < to.length && from[head] === to[head]) head++;
  let tail = 0;
  while (
    tail < from.length - head &&
    tail < to.length - head &&
    from[from.length - 1 - tail] === to[to.length - 1 - tail]
  ) tail++;

  const ctx = 40;
  const slice = (s) => {
    const start = Math.max(0, head - ctx);
    const end = Math.min(s.length, s.length - tail + ctx);
    return (start > 0 ? '…' : '') + s.slice(start, end) + (end < s.length ? '…' : '');
  };
  return {
    from: slice(from),
    to: slice(to),
    note: `long text elided — ${head} leading and ${tail} trailing characters are identical`,
  };
}

function main() {
  const [, , cmd, arg, limitArg] = process.argv;
  const db = openDb();

  if (cmd === 'sites' || !cmd) {
    console.log(JSON.stringify(listSites(db), null, 2));
    return;
  }

  if (cmd === 'site') {
    if (!arg) {
      console.log(JSON.stringify({ error: 'Usage: node query.js site <hostname>[#page_type[:recipe_name]]' }));
      process.exit(1);
    }
    const { hostname, pageType, recipeName } = parseSiteArg(arg);
    const site = getSite(db, hostname, pageType, recipeName);
    if (!site) {
      console.log(JSON.stringify({ error: `No site documented for "${hostname}#${pageType}:${recipeName}"`, documented: false }));
      process.exit(1);
    }
    const fields = getFields(db, site.id);
    console.log(JSON.stringify({ ...site, fields }, null, 2));
    return;
  }

  if (cmd === 'action-types') {
    console.log(JSON.stringify(listActionTypes(db), null, 2));
    return;
  }

  if (cmd === 'sessions') {
    console.log(JSON.stringify(listSessions(arg), null, 2));
    return;
  }

  if (cmd === 'clear-session') {
    if (!arg) {
      console.log(JSON.stringify({ error: 'Usage: node query.js clear-session <hostname>[:sessionName]' }));
      process.exit(1);
    }
    const [hostname, sessionName] = arg.split(':');
    const removed = clearSession(hostname, sessionName);
    console.log(JSON.stringify({ removed, hostname, sessionName: sessionName || 'default' }));
    return;
  }

  if (cmd === 'expand') {
    if (!arg) {
      console.log(JSON.stringify({ error: 'Usage: node query.js expand <hostname>#page_type:recipe_name | expand generic:<name>' }));
      process.exit(1);
    }

    if (arg.startsWith('generic:')) {
      const name = arg.slice('generic:'.length);
      const ga = getGenericAction(db, name);
      if (!ga) {
        console.log(JSON.stringify({ error: `No generic action documented for "${name}"`, documented: false }));
        process.exit(1);
      }
      try {
        // No fixed hostname to resolve a bare run_action against — pass
        // null, same as register.js's check (bare refs are only valid once
        // something with a real hostname invokes this).
        const steps = expandSteps(db, JSON.parse(ga.steps), null, new Set([genericRefKey(name)]));
        console.log(JSON.stringify({ name, steps }, null, 2));
      } catch (e) {
        console.log(JSON.stringify({ error: e.message }));
        process.exit(1);
      }
      return;
    }

    const { hostname, pageType, recipeName } = parseSiteArg(arg);
    const site = getSite(db, hostname, pageType, recipeName);
    if (!site) {
      console.log(JSON.stringify({ error: `No site documented for "${hostname}#${pageType}:${recipeName}"`, documented: false }));
      process.exit(1);
    }
    if (site.nav_method !== 'ui_steps') {
      console.log(JSON.stringify({ error: `"${hostname}#${pageType}:${recipeName}" uses nav_method "${site.nav_method}", not "ui_steps" — nothing to expand.` }));
      process.exit(1);
    }
    try {
      const steps = expandSteps(db, JSON.parse(site.nav_template), hostname, new Set([refKey({ hostname, pageType, recipeName })]));
      console.log(JSON.stringify({ hostname, pageType, recipeName, steps }, null, 2));
    } catch (e) {
      console.log(JSON.stringify({ error: e.message }));
      process.exit(1);
    }
    return;
  }

  if (cmd === 'generic-actions') {
    console.log(JSON.stringify(listGenericActions(db), null, 2));
    return;
  }

  if (cmd === 'generic-action') {
    if (!arg) {
      console.log(JSON.stringify({ error: 'Usage: node query.js generic-action <name>' }));
      process.exit(1);
    }
    const ga = getGenericAction(db, arg);
    if (!ga) {
      console.log(JSON.stringify({ error: `No generic action documented for "${arg}"`, documented: false }));
      process.exit(1);
    }
    console.log(JSON.stringify({ ...ga, steps: JSON.parse(ga.steps) }, null, 2));
    return;
  }

  if (cmd === 'versions') {
    if (!arg) {
      console.log(JSON.stringify({ error: 'Usage: node query.js versions <hostname>[#page_type[:recipe_name]]' }));
      process.exit(1);
    }
    const { hostname, pageType, recipeName } = parseSiteArg(arg);
    const site = getSite(db, hostname, pageType, recipeName);
    if (!site) {
      console.log(JSON.stringify({ error: `No site documented for "${hostname}#${pageType}:${recipeName}"`, documented: false }));
      process.exit(1);
    }
    const versions = listVersions(db, site.id).map(v => ({
      version: `v${v.major}.${v.minor}`,
      stable: !!v.stable,
      note: v.note,
      created_at: v.created_at,
      // How each version actually fared, so "which one was good" is evidence
      // rather than memory.
      runs: db.prepare('SELECT COUNT(*) AS n, SUM(success) AS ok FROM scrape_runs WHERE version_id = ?').get(v.id),
    }));
    console.log(JSON.stringify({ hostname, pageType, recipeName, versions }, null, 2));
    return;
  }

  if (cmd === 'diff') {
    const [target, a, b] = [arg, limitArg, process.argv[5]];
    if (!target) {
      console.log(JSON.stringify({ error: 'Usage: node query.js diff <hostname>[#page_type[:recipe_name]] [vA] [vB]  (defaults: last stable vs current)' }));
      process.exit(1);
    }
    const { hostname, pageType, recipeName } = parseSiteArg(target);
    const site = getSite(db, hostname, pageType, recipeName);
    if (!site) {
      console.log(JSON.stringify({ error: `No site documented for "${hostname}#${pageType}:${recipeName}"`, documented: false }));
      process.exit(1);
    }
    const pick = label => {
      if (!label) return null;
      const m = /^v?(\d+)\.(\d+)$/.exec(label);
      if (!m) return null;
      return getVersion(db, site.id, Number(m[1]), Number(m[2]));
    };
    // Default comparison answers the question you actually have when
    // something breaks: what changed since it last worked?
    const left = pick(a) || getLastStableVersion(db, site.id);
    const right = pick(b) || getCurrentVersion(db, site.id);
    if (!left || !right) {
      console.log(JSON.stringify({ error: 'Need two versions to compare; no stable version recorded yet? Try `node query.js versions <target>`.' }));
      process.exit(1);
    }
    const L = JSON.parse(left.definition);
    const R = JSON.parse(right.definition);
    const changes = {};
    for (const k of new Set([...Object.keys(L), ...Object.keys(R)])) {
      if (k === 'fields') continue;
      if (JSON.stringify(L[k]) !== JSON.stringify(R[k])) changes[k] = compactChange(L[k], R[k]);
    }
    const fieldsBy = d => Object.fromEntries((d.fields || []).map(f => [f.field_name, f]));
    const [lf, rf] = [fieldsBy(L), fieldsBy(R)];
    const fieldChanges = {};
    for (const name of new Set([...Object.keys(lf), ...Object.keys(rf)])) {
      if (JSON.stringify(lf[name]) !== JSON.stringify(rf[name])) {
        fieldChanges[name] = { from: lf[name] ?? null, to: rf[name] ?? null };
      }
    }
    console.log(JSON.stringify({
      from: `v${left.major}.${left.minor}${left.stable ? ' (stable)' : ''}`,
      to: `v${right.major}.${right.minor}${right.stable ? ' (stable)' : ''}`,
      unchanged: Object.keys(changes).length === 0 && Object.keys(fieldChanges).length === 0,
      // Otherwise "v1.0 vs v1.0, unchanged" reads like a bug rather than
      // "this recipe hasn't been touched since it was blessed".
      ...(left.id === right.id
        ? { sameVersion: 'the current version IS the last stable one — nothing has changed since it was promoted' }
        : {}),
      changed: changes,
      fields: fieldChanges,
    }, null, 2));
    return;
  }

  if (cmd === 'restore') {
    if (!arg || !limitArg) {
      console.log(JSON.stringify({ error: 'Usage: node query.js restore <hostname>[#page_type[:recipe_name]] <vMAJOR.MINOR>' }));
      process.exit(1);
    }
    const { hostname, pageType, recipeName } = parseSiteArg(arg);
    const site = getSite(db, hostname, pageType, recipeName);
    if (!site) {
      console.log(JSON.stringify({ error: `No site documented for "${hostname}#${pageType}:${recipeName}"`, documented: false }));
      process.exit(1);
    }
    const m = /^v?(\d+)\.(\d+)$/.exec(limitArg);
    if (!m) {
      console.log(JSON.stringify({ error: `"${limitArg}" is not a version — expected vMAJOR.MINOR, e.g. v1.0. Run \`node query.js versions ${arg}\`.` }));
      process.exit(1);
    }
    const restored = restoreVersion(db, site.id, Number(m[1]), Number(m[2]));
    if (!restored) {
      console.log(JSON.stringify({ error: `No v${m[1]}.${m[2]} recorded for that recipe. Run \`node query.js versions ${arg}\`.` }));
      process.exit(1);
    }
    console.log(JSON.stringify({
      restoredFrom: `v${m[1]}.${m[2]}`,
      recordedAs: `v${restored.major}.${restored.minor}`,
      note: 'the live recipe now matches the restored definition; the version it replaced is still in history',
    }, null, 2));
    return;
  }

  if (cmd === 'promote') {
    if (!arg) {
      console.log(JSON.stringify({ error: 'Usage: node query.js promote <hostname>[#page_type[:recipe_name]] [note]' }));
      process.exit(1);
    }
    const { hostname, pageType, recipeName } = parseSiteArg(arg);
    const site = getSite(db, hostname, pageType, recipeName);
    if (!site) {
      console.log(JSON.stringify({ error: `No site documented for "${hostname}#${pageType}:${recipeName}"`, documented: false }));
      process.exit(1);
    }
    const promoted = promoteVersion(db, site.id, { note: limitArg });
    if (!promoted) {
      console.log(JSON.stringify({ error: 'No version recorded yet for that recipe — register it once first.' }));
      process.exit(1);
    }
    console.log(JSON.stringify({
      promoted: `v${promoted.major}.${promoted.minor}`,
      stable: true,
      note: promoted.note,
      permanent: 'a vN.0 is never pruned; further edits continue at ' +
        `v${promoted.major}.1`,
    }, null, 2));
    return;
  }

  if (cmd === 'health') {
    const recentN = arg ? parseInt(arg, 10) : 10;
    console.log(JSON.stringify(getRecipeHealth(db, Number.isFinite(recentN) ? recentN : 10), null, 2));
    return;
  }

  if (cmd === 'efficiency') {
    console.log(JSON.stringify(getEfficiencyStats(db), null, 2));
    return;
  }

  if (cmd === 'debug-captures') {
    console.log(JSON.stringify(listDebugCaptures(), null, 2));
    return;
  }

  if (cmd === 'runs') {
    if (!arg) {
      console.log(JSON.stringify({ error: 'Usage: node query.js runs <hostname>[#page_type[:recipe_name]] [limit]' }));
      process.exit(1);
    }
    const { hostname, pageType, recipeName } = parseSiteArg(arg);
    const site = getSite(db, hostname, pageType, recipeName);
    if (!site) {
      console.log(JSON.stringify({ error: `No site documented for "${hostname}#${pageType}:${recipeName}"` }));
      process.exit(1);
    }
    const runs = getRuns(db, site.id, limitArg ? parseInt(limitArg, 10) : 10);
    console.log(JSON.stringify(runs, null, 2));
    return;
  }

  console.log(JSON.stringify({
    error: `Unknown command "${cmd}". Use: sites | site <hostname>[#page_type[:recipe_name]] | runs <hostname>[#page_type[:recipe_name]] [n] | action-types | sessions [hostname] | clear-session <hostname>[:sessionName] | expand <hostname>#page_type:recipe_name | expand generic:<name> | generic-actions | generic-action <name> | versions <hostname>[#...] | diff <hostname>[#...] [vA] [vB] | promote <hostname>[#...] [note] | efficiency | health [recentN] | debug-captures`,
  }));
  process.exit(1);
}

main();
