// What counts as "the same page", so several recipes on one page can share
// what has been learned about it.
//
// `sites` is keyed (hostname, page_type, recipe_name) — that is a RECIPE, not a
// page. Two recipes can target the identical URL and currently know nothing
// about each other, which is how the same page gets characterised twice.
// Measured on the 35 real recipes: three pages already carry two recipes each,
// all of them an ATS job posting with an `article` recipe that reads it and an
// `action` recipe that describes its apply form.
//
// THE TRAP, and the reason this is its own module with its own tests: the
// obvious key, `nav_template`, finds ZERO shared pages. An `action` recipe's
// nav_template holds its ui_steps array, so a page reached by `{{url}}` and the
// same page reached by `[{"action":"goto","url":"{{url}}"}, ...]` look nothing
// alike as strings. Keyed that way, primitives would never merge — the feature
// would run, report nothing, and silently do nothing, which is the failure
// class this repo keeps paying for. The key has to be where a recipe actually
// LANDS, not how its navigation happens to be written down.

// The URL template a recipe enters the page at, or null when it cannot be
// determined. Null rather than a guess: a recipe with no `goto` starts from
// wherever the browser already is, and inventing an identity for it would merge
// unrelated recipes, which is worse than leaving it unmerged.
function entryUrlFor(site) {
  if (!site || typeof site !== 'object') return null;
  const template = site.nav_template;
  if (typeof template !== 'string' || !template.trim()) return null;

  if (site.nav_method !== 'ui_steps') return template.trim();

  let steps;
  try {
    steps = JSON.parse(template);
  } catch {
    return null; // unparseable steps are a broken recipe, not a page
  }
  if (!Array.isArray(steps)) return null;

  // The FIRST goto is the entry. A later one is a navigation the action
  // performs, which is part of what it does rather than where it starts.
  // Nested steps (inside `repeat`) are deliberately not searched: a goto in a
  // loop is not an entry point.
  const goto = steps.find(s => s && s.action === 'goto' && typeof s.url === 'string' && s.url.trim());
  return goto ? goto.url.trim() : null;
}

// The identity two recipes must share to be "the same page". Hostname is part
// of it because `{{url}}` is the entry template for every ATS article recipe —
// on its own it would merge Greenhouse with Lever.
function pageKeyFor(site) {
  const entry = entryUrlFor(site);
  if (!entry) return null;
  return `${String(site.hostname || '').toLowerCase()}\u0000${entry}`;
}

// A page key rendered for a human: "hostname  <entry template>".
function describePageKey(key) {
  if (!key) return null;
  const [host, entry] = key.split('\u0000');
  return `${host}  ${entry}`;
}

// Groups recipes by page. Recipes with no determinable entry point are returned
// separately rather than lumped together — see entryUrlFor.
function groupByPage(sites) {
  const pages = new Map();
  const unkeyed = [];
  for (const site of sites || []) {
    const key = pageKeyFor(site);
    if (!key) {
      unkeyed.push(site);
      continue;
    }
    if (!pages.has(key)) pages.set(key, []);
    pages.get(key).push(site);
  }
  return { pages, unkeyed };
}

module.exports = { entryUrlFor, pageKeyFor, describePageKey, groupByPage };
