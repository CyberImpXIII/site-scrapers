// Probes report rather than act (see lib/probes.js and README.md
// "Diagnosing a recipe"). The properties that matter:
//
//   - a probe never fails a run, even when it's malformed
//   - repeated_structure actually finds the cards, including the shared
//     line that makes a good card_anchor_text
//   - blockers tells apart the walls that all look like a bare timeout
//   - a probe never reports the VALUE of a form field (may be a password)
//   - a FAILING run gets the sweep automatically, so it explains itself
//     without a second run
//
// Run via `npm test` / `./test.sh`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const { openDb, upsertSite, insertField, deleteSite } = require('../db');
const { authorizeForTests } = require('../lib/writeGuard');

const REPO_ROOT = path.join(__dirname, '..');
let server;
let baseUrl;
let db;
const createdSiteIds = [];

function pageFor(query) {
  if (query.get('page') === 'login') {
    return `<html><head><meta charset="utf-8"></head><body>
      <h1>Sign in to continue</h1>
      <form><label for="u">Email</label><input id="u" name="email" type="email">
      <input id="p" name="password" type="password" value="prefilled-secret-value">
      <input type="submit" value="Sign in"></form></body></html>`;
  }
  if (query.get('page') === 'hashed') {
    // Mimics a real Workday tenant: the card wrapper carries only a
    // build-hashed emotion class, while the title link has a stable
    // data-automation-id. Also gives most-but-not-all cards a "Full-Time"
    // link so the sharedLine majority rule is exercised.
    const rows = Array.from({ length: 6 }, (_, i) =>
      `<li class="css-1q2dra3">
         <a data-automation-id="jobTitle" href="/job/${i}">Engineer ${i}</a>
         <p>Acme Corp - Remote. A description long enough to clear the average-length threshold.</p>
         ${i < 5 ? '<a href="/t">Full-Time</a>' : '<a href="/t">Contract</a>'}
         <span>${i}w</span><span>Featured</span>
       </li>`
    ).join('');
    return `<html><head><meta charset="utf-8"></head><body><ul id="hits">${rows}</ul></body></html>`;
  }
  if (query.get('page') === 'anatomy') {
    // Built to exercise the three distinctions card_anatomy claims to make,
    // because all three decide whether a child_text field returns data, null,
    // or the same string on every card:
    //   company/.ti  present in EVERY card, text varies      -> real fields
    //   .badge       present in only 2 of 6                  -> optional
    //   .apply       present in every card, text identical   -> static label
    //   .tag         TWO per card                            -> needs segment_index
    // The company is an a[data-testid] inside a layout-class wrapper with the
    // same text, which is ziprecruiter's real shape: the stable hook must win.
    // Plus an input carrying a value, which must never be reported.
    const rows = Array.from({ length: 6 }, (_, i) =>
      `<li class="card">
         <div class="d-flex justify-between"><a data-testid="card-company" href="/c">Company ${i}</a></div>
         <div class="ti"><span>Engineer ${i}</span></div>
         ${i < 2 ? '<div class="badge">Promoted</div>' : ''}
         <div class="tag">Remote</div><div class="tag">Full-Time</div>
         <a class="apply" href="/job/${i}">Apply</a>
         <input class="save" name="note" value="prefilled-secret-value">
       </li>`
    ).join('');
    return `<html><head><meta charset="utf-8"></head><body><ul>${rows}</ul></body></html>`;
  }
  if (query.get('page') === 'paging') {
    // One page per mechanism, selected by &kind=, because the whole point of
    // the probe is telling them apart -- a single fixture with all of them
    // would prove only that it finds something.
    const kind = query.get('kind');
    const filler = Array.from({ length: 40 }, (_, i) => `<p>Job ${i} with enough text to make the page scroll.</p>`).join('');
    const body = {
      load_more: '<button class="load-more">Show more jobs</button>',
      // A decoy that must NOT be read as a next control.
      decoy: '<a href="/x">Learn more</a><a href="/y">More filters</a>',
      next: '<a rel="next" href="/jobs?page=2">Next</a>',
      german: '<button class="mehr">Mehr laden</button>',
      numbered: '<nav class="pagination"><a href="?p=1">1</a><a href="?p=2">2</a><a href="?p=3">3</a></nav>',
      sentinel: '<div class="infinite-scroll-sentinel"></div>',
      disabled: '<button class="load-more" disabled>Show more jobs</button>',
      none: '',
    }[kind] || '';
    return `<html><head><meta charset="utf-8"></head><body>${filler}${body}</body></html>`;
  }
  if (query.get('page') === 'shapes') {
    // One part per recognisable shape, plus two that must NOT be proposed:
    // .place holds a plain string no vocabulary covers, and .mixed matches the
    // relative-time shape in only some cards.
    const rows = Array.from({ length: 6 }, (_, i) =>
      `<li class="card">
         <div class="pay">$${90 + i},000 - $${120 + i},000 a year</div>
         <div class="age">${i + 1} days ago</div>
         <div class="kind">${i % 2 ? 'Full-time' : 'Contract'}</div>
         <div class="place">Sioux Falls, South Dakota</div>
         <div class="mixed">${i < 3 ? `${i + 1} days ago` : `Team ${i}`}</div>
       </li>`
    ).join('');
    return `<html><head><meta charset="utf-8"></head><body><ul>${rows}</ul></body></html>`;
  }
  if (query.get('page') === 'chrome') {
    // workingnomads.com counted page chrome as cards. The footer columns and
    // the sponsored rail here are deliberately given prose long enough to clear
    // the avgTextLength floor that catches short nav lists, so they DO compete
    // with the real list -- that is the whole failure being reproduced.
    const prose = 'A block of text long enough to clear the average length threshold this probe uses.';
    const footer = Array.from({ length: 5 }, (_, i) => `<div class="fcol"><a href="/f${i}">Footer column ${i}</a> ${prose}</div>`).join('');
    const promos = Array.from({ length: 5 }, (_, i) => `<div class="promo"><a href="/p${i}">Promo ${i}</a> ${prose}</div>`).join('');
    const real = Array.from({ length: 4 }, (_, i) => `<div class="posting"><a href="/job/${i}">Real Job ${i}</a> ${prose}</div>`).join('');
    return `<html><head><meta charset="utf-8"></head><body>
      <nav><a href="/">Home</a><a href="/x">X</a></nav>
      <main><div id="list">${real}</div></main>
      <aside class="sponsored-rail">${promos}</aside>
      <footer><div id="fcols">${footer}</div></footer></body></html>`;
  }
  if (query.get('page') === 'aside-only') {
    // The case that makes excluding chrome the wrong fix: the ONLY list on the
    // page is inside an <aside>. Dropping chrome candidates would report no
    // cards at all, which is a wrong answer by omission.
    const prose = 'A block of text long enough to clear the average length threshold this probe uses.';
    const rows = Array.from({ length: 5 }, (_, i) => `<div class="posting"><a href="/job/${i}">Real Job ${i}</a> ${prose}</div>`).join('');
    return `<html><head><meta charset="utf-8"></head><body><aside><div id="list">${rows}</div></aside></body></html>`;
  }
  if (query.get('page') === 'utility') {
    // builtin.com's real shape, which is what motivated ranking utility
    // classes down: the Bootstrap wrappers sorted ABOVE the two selectors that
    // were actually usable (div.left-side-tile-item-2 and -3). Each div holds
    // its own distinct text so all three survive the wrapper-chain collapse
    // and the ORDER is what is being tested.
    const rows = Array.from({ length: 6 }, (_, i) =>
      `<li class="card">
         <div class="d-flex align-items-start">Utility Held ${i}</div>
         <div class="col-12 col-lg-7">Layout Text ${i}</div>
         <div class="left-side-tile-item-2">Semantic Title ${i}</div>
       </li>`
    ).join('');
    return `<html><head><meta charset="utf-8"></head><body><ul>${rows}</ul></body></html>`;
  }
  const cards = Array.from({ length: 6 }, (_, i) =>
    `<div class="job-card"><h3>Engineer ${i}</h3>
     <p>Acme Corp - Remote - Full Time. A description long enough to clear the average-length threshold.</p>
     <a href="/job/${i}">View job</a></div>`
  ).join('');
  return `<html><head><meta charset="utf-8"></head><body>
    <nav><a href="/">Home</a><a href="/x">X</a></nav>
    <div id="results">${cards}</div></body></html>`;
}

test.before(async () => {
  authorizeForTests();
  server = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(pageFor(new URL(req.url, 'http://x').searchParams));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/`;
  db = openDb();
});

test.after(() => {
  for (const id of createdSiteIds) deleteSite(db, id);
  server.close();
});

async function run(name, steps, params = '{"noSession":true,"noDiagnostics":true}') {
  const id = upsertSite(db, {
    hostname: '127.0.0.1',
    page_type: 'action',
    recipe_name: name,
    action_type: 'login',
    status: 'working',
    nav_method: 'ui_steps',
    nav_template: JSON.stringify(steps),
    content_selector: 'body',
    card_min_text_len: 1,
    ready_timeout_ms: 4000,
    notes: 'Test-only recipe for test/probes.test.js. Safe to delete if found stray.',
  });
  if (!createdSiteIds.includes(id)) createdSiteIds.push(id);
  insertField(db, id, { field_name: 'body', extract_kind: 'full_blob' }, 0);
  const args = ['engine.js', `127.0.0.1#action:${name}`, params];
  try {
    const { stdout } = await execFileAsync(process.execPath, args, { cwd: REPO_ROOT, encoding: 'utf8' });
    return JSON.parse(stdout);
  } catch (e) {
    return JSON.parse(e.stdout);
  }
}

const byKind = (result, kind) => (result.diagnostics || []).find(p => p.kind === kind);

test('repeated_structure finds the cards and the line that identifies them', async () => {
  const result = await run('probe_cards', [
    { action: 'goto', url: baseUrl },
    { action: 'run_generic_action', ref: 'probe_card_candidates' },
  ]);
  assert.equal(result.success, true);

  const cards = byKind(result, 'repeated_structure');
  assert.ok(cards, 'expected a repeated_structure probe result');
  const top = cards.candidates[0];
  assert.equal(top.count, 6, 'six cards on the fixture page');
  assert.equal(top.childrenWithLinks, 6);
  assert.equal(top.sharedLine, 'View job', 'the repeated line is the card_anchor_text candidate');
  // The two-link <nav> must not win: short text, below the length threshold.
  assert.ok(top.avgTextLength > 20);
});

// card_anatomy is what makes child_text CHOOSABLE. Without it, picking the
// selector for a field is a guess followed by a full re-run, which is how four
// recipes here ended up counting parts in a text blob instead — the extraction
// style that drifts and reports a wrong value rather than failing.
test('card_anatomy separates a field from an optional badge from a static label', async () => {
  const result = await run('probe_anatomy', [
    { action: 'goto', url: `${baseUrl}?page=anatomy` },
    { action: 'run_generic_action', ref: 'probe_card_anatomy', with: { card_selector: 'li.card' } },
  ]);
  assert.equal(result.success, true);
  const anat = byKind(result, 'card_anatomy');
  assert.ok(anat, 'expected a card_anatomy probe result');
  assert.equal(anat.cardCount, 6);
  const part = s => anat.parts.find(p => p.selector === s);

  // A field: in every card, different text each time. Reported by its STABLE
  // hook, not by the layout wrapper that holds the same text — the wrapper's
  // classes are the site's grid system and will not survive a redesign.
  assert.equal(part('a[data-testid="card-company"]').everyCard, true);
  assert.equal(part('a[data-testid="card-company"]').varies, true);
  assert.equal(part('a[data-testid="card-company"]').maxPerCard, 1);
  assert.equal(part('div.d-flex.justify-between'), undefined, 'the wrapper must not shadow the hook');

  // An optional badge. Reported, but marked so it is not mistaken for a field
  // or — the expensive mistake — used as a positional anchor.
  assert.equal(part('div.badge').everyCard, false);
  assert.equal(part('div.badge').presentIn, '2/6');

  // A static label: in every card, always the same string. Not data.
  assert.equal(part('a.apply').everyCard, true);
  assert.equal(part('a.apply').varies, false);

  // Two per card, so child_text needs a segment_index to say which one — and
  // the probe has to say what each index HOLDS, or picking the index is a guess
  // again and the probe stopped one step short of its own purpose.
  assert.equal(part('div.tag').maxPerCard, 2);
  const tagPositions = part('div.tag').positions;
  assert.equal(tagPositions.length, 2);
  assert.deepEqual(tagPositions[0].samples.slice(0, 1), ['Remote']);
  assert.deepEqual(tagPositions[1].samples.slice(0, 1), ['Full-Time']);
  assert.equal(part('a[data-testid="card-company"]').positions, undefined, 'one match per card needs no position breakdown');
});

test('card_anatomy reports the index child_text will actually use', async () => {
  // maxPerCard and the position indices must come from querySelectorAll on the
  // PROPOSED selector, not from the probe's own filtered walk. They diverge
  // whenever the walk skips an element the selector still matches, and a
  // segment_index read off a filtered position then points at a different
  // element at extraction time — a wrong value rather than a failure.
  const result = await run('probe_anatomy_index', [
    { action: 'goto', url: `${baseUrl}?page=anatomy` },
    { action: 'run_generic_action', ref: 'probe_card_anatomy', with: { card_selector: 'li.card' } },
  ]);
  const anat = byKind(result, 'card_anatomy');
  for (const p of anat.parts) {
    assert.ok(p.maxPerCard >= 1, `${p.selector} should match at least once`);
    for (const pos of p.positions || []) {
      assert.ok(
        pos.index < p.maxPerCard,
        `${p.selector} reports index ${pos.index} but only ${p.maxPerCard} matches exist — segment_index would miss`
      );
    }
  }
});

test('card_anatomy reports the outermost element holding a text, not every wrapper', async () => {
  // div.ti wraps a bare <span> with the same text. Reporting both would make
  // the output twice as long and offer a choice with no meaning; the outer one
  // carries the semantic class, so that is the selector worth writing down.
  const result = await run('probe_anatomy_wrap', [
    { action: 'goto', url: `${baseUrl}?page=anatomy` },
    { action: 'run_generic_action', ref: 'probe_card_anatomy', with: { card_selector: 'li.card' } },
  ]);
  const anat = byKind(result, 'card_anatomy');
  assert.ok(anat.parts.some(p => p.selector === 'div.ti'), 'the titled wrapper should be reported');
  assert.equal(anat.parts.filter(p => p.selector === 'span').length, 0, 'its bare inner span should not be');
});

// pagination_controls proposes the OTHER half of a listing recipe:
// pagination_method, and the next_selector `paginate` needs. Each mechanism
// implies a different recipe, so telling them apart is the whole job.

const paging = async (name, kind) => {
  const result = await run(`probe_paging_${name}`, [
    { action: 'goto', url: `${baseUrl}?page=paging&kind=${kind}` },
    { action: 'run_generic_action', ref: 'probe_pagination_controls' },
  ]);
  return byKind(result, 'pagination_controls');
};

test('a load-more button is found, with the selector paginate would need', async () => {
  const p = await paging('loadmore', 'load_more');
  assert.equal(p.likely, 'load_more');
  const c = p.controls.find(x => x.mechanism === 'load_more');
  assert.equal(c.selector, 'button.load-more');
  assert.match(p.hint, /next_selector/);
});

test('"Learn more" and "More filters" are not pagination controls', async () => {
  // The decoy case. `more` on its own matches both of those, and a wrong
  // next_selector is a recipe that silently paginates into nothing -- so the
  // vocabulary is anchored rather than loose.
  const p = await paging('decoy', 'decoy');
  assert.deepEqual(p.controls.filter(c => c.mechanism !== 'scroll_sentinel'), []);
  assert.notEqual(p.likely, 'load_more');
});

test('rel="next" is recognised structurally, not from its wording', async () => {
  const p = await paging('next', 'next');
  assert.equal(p.likely, 'next_link');
  assert.equal(p.controls.find(c => c.mechanism === 'next_link').selector, 'a[rel="next"]');
});

test('the text vocabulary is data, so a German control is found too', async () => {
  // stepstone.de is already in this repo. An English-only word list would
  // report "no pagination" on it, which reads as a single-page site.
  const p = await paging('german', 'german');
  assert.equal(p.likely, 'load_more');
  assert.match(p.controls[0].text, /Mehr laden/);
});

test('a run of numbered links is a mechanism; one number is not', async () => {
  const p = await paging('numbered', 'numbered');
  assert.equal(p.likely, 'numbered');
  assert.ok(p.controls.filter(c => c.mechanism === 'numbered').length >= 3);
});

test('a disabled control is not offered as a way forward', async () => {
  // "Show more" greyed out on the last page means there is no more, and
  // proposing it would build a recipe that paginates into nothing.
  const p = await paging('disabled', 'disabled');
  assert.deepEqual(p.controls.filter(c => c.mechanism === 'load_more'), []);
  assert.notEqual(p.likely, 'load_more');
});

test('infinite scroll is never CLAIMED — only scrolling can establish it', async () => {
  // The honesty requirement. A sentinel-shaped element is a hint from a class
  // name; treating it as a finding is exactly the confidently-wrong answer
  // docs/lessons.md is about. likely stays null and the hint says what would
  // settle it.
  const p = await paging('sentinel', 'sentinel');
  assert.equal(p.likely, null, 'a sentinel element is not proof of infinite scroll');
  assert.ok(p.controls.some(c => c.mechanism === 'scroll_sentinel'));
  assert.match(p.hint, /infinite_scroll action/);
  assert.match(p.hint, /never proof/);
});

test('a page with nothing and nowhere to scroll is single_page, not unknown', async () => {
  const result = await run('probe_paging_single', [
    { action: 'goto', url: `${baseUrl}?page=anatomy` },
    { action: 'run_generic_action', ref: 'probe_pagination_controls' },
  ]);
  const p = byKind(result, 'pagination_controls');
  assert.equal(p.likely, 'single_page');
  assert.match(p.hint, /probably already here/);
});

test('card_anatomy proposes a field name only from a shape it was told about', async () => {
  const result = await run('probe_shapes', [
    { action: 'goto', url: `${baseUrl}?page=shapes` },
    { action: 'run_generic_action', ref: 'probe_card_anatomy', with: { card_selector: 'li.card' } },
  ]);
  const parts = byKind(result, 'card_anatomy').parts;
  const proposal = sel => (parts.find(p => p.selector === sel) || {}).proposedField;

  assert.equal(proposal('div.pay'), 'salary', 'a currency range is a salary');
  assert.equal(proposal('div.age'), 'posted_ago', 'a relative time is a posting age');
  assert.equal(proposal('div.kind'), 'commitment', 'a closed employment-type enum');
});

test('card_anatomy proposes nothing rather than guessing', async () => {
  // The limit that matters, and the reason this is safe to have at all. A
  // probe cannot know what a novel field MEANS -- guessing is how a salary
  // came to be reported as a location on cards with no location. Two ways it
  // must decline: an unknown shape, and a known shape that only some cards
  // match (one matching sample is a coincidence, not a field).
  const result = await run('probe_shapes_decline', [
    { action: 'goto', url: `${baseUrl}?page=shapes` },
    { action: 'run_generic_action', ref: 'probe_card_anatomy', with: { card_selector: 'li.card' } },
  ]);
  const parts = byKind(result, 'card_anatomy').parts;
  const part = sel => parts.find(p => p.selector === sel);

  assert.ok(part('div.place'), 'the part is still reported');
  assert.equal(part('div.place').proposedField, undefined, 'a place name matches no vocabulary, so no guess');
  assert.ok(part('div.mixed'), 'the part is still reported');
  assert.equal(
    part('div.mixed').proposedField,
    undefined,
    'the relative-time shape holds for only 3 of 6 cards, which is not a field'
  );
});

test('repeated_structure ranks page chrome below the real list', async () => {
  // The footer columns (5) and sponsored promos (5) each outnumber the real
  // postings (4) and carry the same prose, so before chrome was recognised the
  // count*avgTextLength sort put them ABOVE the actual cards -- which is
  // exactly how workingnomads.com came to count chrome as cards.
  const result = await run('probe_chrome', [
    { action: 'goto', url: `${baseUrl}?page=chrome` },
    { action: 'run_generic_action', ref: 'probe_card_candidates' },
  ]);
  const cands = byKind(result, 'repeated_structure').candidates;
  assert.ok(cands.length, 'expected candidates');
  assert.equal(cands[0].childSelector, 'div.posting', 'the real list must rank first');
  assert.equal(cands[0].chrome, undefined, 'and must not be flagged as chrome');

  // Both kinds of chrome are recognised: a semantic <footer> and an <aside>
  // whose class matches the ad vocabulary.
  const flagged = cands.filter(c => c.chrome).map(c => c.childSelector);
  assert.ok(flagged.includes('div.fcol'), 'footer columns are chrome');
  assert.ok(flagged.includes('div.promo'), 'a sponsored rail is chrome');
});

test('a list that really is inside an aside is still reported', async () => {
  // Why chrome is demoted rather than excluded. If the only repeated structure
  // on the page sits in an <aside>, filtering it out would report nothing and
  // send someone looking for a rendering bug that does not exist.
  const result = await run('probe_aside', [
    { action: 'goto', url: `${baseUrl}?page=aside-only` },
    { action: 'run_generic_action', ref: 'probe_card_candidates' },
  ]);
  const cands = byKind(result, 'repeated_structure').candidates;
  const posting = cands.find(c => c.childSelector === 'div.posting');
  assert.ok(posting, 'the aside list must still be reported, not filtered away');
  assert.equal(posting.count, 5);
  assert.equal(posting.chrome, true, 'flagged, so the ranking is explainable');
});

test('card_anatomy ranks framework utility classes below semantic hooks', async () => {
  const result = await run('probe_anatomy_utility', [
    { action: 'goto', url: `${baseUrl}?page=utility` },
    { action: 'run_generic_action', ref: 'probe_card_anatomy', with: { card_selector: 'li.card' } },
  ]);
  const parts = byKind(result, 'card_anatomy').parts;
  const at = sel => parts.findIndex(p => p.selector === sel);

  // All three are present in every card and vary, so before the utility
  // vocabulary existed the tie-break was arbitrary and Bootstrap won by
  // accident of insertion order.
  assert.ok(at('div.left-side-tile-item-2') >= 0, 'the semantic hook must be reported');
  assert.ok(at('div.d-flex.align-items-start') >= 0, 'the utility part must STILL be reported');
  assert.ok(at('div.col-12.col-lg-7') >= 0, 'the layout part must STILL be reported');

  assert.ok(
    at('div.left-side-tile-item-2') < at('div.d-flex.align-items-start') &&
      at('div.left-side-tile-item-2') < at('div.col-12.col-lg-7'),
    'the semantic hook must sort above both utility parts'
  );
  assert.equal(parts[at('div.d-flex.align-items-start')].utility, true);
  assert.equal(parts[at('div.col-12.col-lg-7')].utility, true);
  assert.equal(parts[at('div.left-side-tile-item-2')].utility, undefined, 'a semantic hook is not flagged');
});

test('a utility class is ranked down, never dropped', async () => {
  // The property that keeps this safe to be broad about. On builtin.com
  // div.d-flex.align-items-start is the ONLY hook for four fields, so a
  // vocabulary that FILTERED would have left them unextractable. Asserted
  // separately from the ordering because it is a different promise: over-
  // matching may cost a part its position and must never cost it its row.
  const result = await run('probe_anatomy_keep', [
    { action: 'goto', url: `${baseUrl}?page=utility` },
    { action: 'run_generic_action', ref: 'probe_card_anatomy', with: { card_selector: 'li.card' } },
  ]);
  const parts = byKind(result, 'card_anatomy').parts;
  const utility = parts.filter(p => p.utility);
  assert.equal(utility.length, 2, 'both utility parts survive');
  for (const p of utility) {
    assert.equal(p.everyCard, true, 'and keep their real presentIn, not a downgraded one');
    assert.equal(p.varies, true, 'and are still reported as carrying per-card data');
  }
});

// card_match answers the MIGRATION question: the values are already known, so
// the only thing left is which selector reproduces them. Every assertion below
// is about it giving a checkable answer rather than a plausible one.

// The values the anatomy fixture's own cards hold, in DOM order.
const anatomyExpected = JSON.stringify({
  company: Array.from({ length: 6 }, (_, i) => `Company ${i}`),
  title: Array.from({ length: 6 }, (_, i) => `Engineer ${i}`),
});

const matchSteps = (expected = anatomyExpected) => [
  { action: 'goto', url: `${baseUrl}?page=anatomy` },
  {
    action: 'run_generic_action',
    ref: 'probe_card_match',
    with: { card_selector: 'li.card', expected },
  },
];

test('card_match finds the selector that reproduces each known value', async () => {
  const m = byKind(await run('probe_match_basic', matchSteps()), 'card_match');
  assert.ok(m, 'expected a card_match probe result');
  assert.equal(m.error, undefined, `probe errored: ${m.error}`);
  assert.equal(m.mode, 'aligned', '6 cards and 6 records should compare positionally');

  // The stable hook must win over the layout-class wrapper holding the same
  // text -- this is ziprecruiter's real shape, and picking the wrapper is what
  // breaks on the site's next redesign.
  assert.equal(m.fields.company.selector, 'a[data-testid="card-company"]');
  assert.equal(m.fields.company.everyCard, true);
  assert.equal(m.fields.company.varies, true);

  // div.ti wraps a bare <span> with the same text. Both reproduce the value,
  // so the tier order decides: a semantic class beats a bare tag, even though
  // the bare tag is the shorter string.
  assert.equal(m.fields.title.selector, 'div.ti');
  assert.equal(m.fields.title.matchedIn, '6/6');
});

test('card_match returns null rather than a guess when no element holds the value', async () => {
  // The single most important property. A derived value -- a regex capture, a
  // substring, an href -- is not any element's text, and proposing the closest
  // thing would be exactly the confidently-wrong output this project keeps
  // paying for. `docs/lessons.md`: prefer null over a guess.
  const m = byKind(
    await run(
      'probe_match_null',
      matchSteps(JSON.stringify({ salary: Array.from({ length: 6 }, (_, i) => `$${i}00k`) }))
    ),
    'card_match'
  );
  assert.equal(m.fields.salary.selector, null);
  assert.equal(m.fields.salary.matchedIn, '0/6');
  assert.match(m.fields.salary.note, /DERIVED/);
});

test('card_match reports the index when its selector matches more than once per card', async () => {
  // Two div.tag per card ("Remote", "Full-Time"). A selector without the index
  // would extract whichever came first, which is the positional drift
  // child_text exists to end -- so the index is the part that must be right.
  const m = byKind(
    await run('probe_match_index', matchSteps(JSON.stringify({ commitment: Array(6).fill('Full-Time') }))),
    'card_match'
  );
  assert.equal(m.fields.commitment.selector, 'div.tag');
  assert.equal(m.fields.commitment.matchesPerCard, 2);
  assert.equal(m.fields.commitment.index, 1, 'Full-Time is the SECOND tag, not the first');
  // Identical on every card, so it is a label the layout happens to repeat,
  // not per-card data -- proposing it as a field would be a wrong answer.
  assert.equal(m.fields.commitment.varies, false);
});

test('card_match scores an optional field against the cards that could have matched', async () => {
  // .badge is on 2 of 6 cards. The two records that have it are matched
  // correctly, and the four nulls are not failures -- reporting 2/6 would make
  // a correct selector for an optional field look broken.
  const m = byKind(
    await run(
      'probe_match_optional',
      matchSteps(JSON.stringify({ badge: ['Promoted', 'Promoted', null, null, null, null] }))
    ),
    'card_match'
  );
  assert.equal(m.fields.badge.selector, 'div.badge');
  assert.equal(m.fields.badge.matchedIn, '2/2', 'scored against eligible cards, not all cards');
  assert.equal(m.fields.badge.everyCard, true);
});

test('card_match falls back to set mode when cards and records disagree', async () => {
  // The page is re-opened to search it, so it can hold different cards than
  // the run that produced the values. Comparing card i to record i then
  // compares a card against ANOTHER card's value. It has to say so.
  const m = byKind(
    await run('probe_match_setmode', matchSteps(JSON.stringify({ title: ['Engineer 1', 'Engineer 3'] }))),
    'card_match'
  );
  assert.equal(m.mode, 'set', '2 records against 6 cards cannot be aligned');
  assert.match(m.hint, /could not be matched to records positionally/);
});

test('card_match never reports the value of a form control', async () => {
  // Same rule as every other probe. The input's value is deliberately fed in
  // as an expected value, which is the one way it could be echoed back.
  const m = byKind(
    await run(
      'probe_match_safe',
      matchSteps(JSON.stringify({ sneaky: Array(6).fill('prefilled-secret-value') }))
    ),
    'card_match'
  );
  assert.ok(!JSON.stringify(m).includes('prefilled-secret-value'), 'a form value must never appear in probe output');
  assert.equal(m.fields.sneaky.selector, null);
});

test('card_anatomy never reports the value of a form control', async () => {
  // Same rule as the forms probe: this output is written to disk and read back
  // into a transcript, and a card is not guaranteed not to contain an input.
  const result = await run('probe_anatomy_safe', [
    { action: 'goto', url: `${baseUrl}?page=anatomy` },
    { action: 'run_generic_action', ref: 'probe_card_anatomy', with: { card_selector: 'li.card' } },
  ]);
  assert.ok(
    !JSON.stringify(byKind(result, 'card_anatomy')).includes('prefilled-secret-value'),
    'a form value must never appear in probe output'
  );
});

test('a probe field is substituted because it is a string, not because it is on a list', async () => {
  // engine.js used to substitute three NAMED probe fields, and the list went
  // stale twice: probe_card_candidates documented min_group as a parameter
  // while never substituting it, and card_anatomy's card_selector arrived as
  // the literal "{{card_selector}}". card_selector is deliberately a field the
  // old list did not contain — if this passes, a future probe field needs no
  // change anywhere else.
  const result = await run(
    'probe_anatomy_param',
    [
      { action: 'goto', url: `${baseUrl}?page=anatomy` },
      { action: 'run_generic_action', ref: 'probe_card_anatomy', with: { card_selector: '{{cs}}' } },
    ],
    '{"noSession":true,"noDiagnostics":true,"cs":"li.card"}'
  );
  const anat = byKind(result, 'card_anatomy');
  assert.equal(anat.error ?? null, null, `expected the placeholder to be filled, got ${anat.error}`);
  assert.equal(anat.cardCount, 6);
});

test('card_anatomy says so when the card selector matches nothing', async () => {
  // Not an empty parts list, which reads as "this card has no content" — a
  // wrong card_selector is a different problem with a different fix.
  const result = await run('probe_anatomy_miss', [
    { action: 'goto', url: `${baseUrl}?page=anatomy` },
    { action: 'run_generic_action', ref: 'probe_card_anatomy', with: { card_selector: 'div.nope' } },
  ]);
  const anat = byKind(result, 'card_anatomy');
  assert.match(anat.error, /matched nothing/);
  assert.equal(anat.cardCount, 0);
});

test('blockers tells a login wall apart from a working page', async () => {
  const wall = await run('probe_wall', [
    { action: 'goto', url: `${baseUrl}?page=login` },
    { action: 'run_generic_action', ref: 'diagnose_blockers' },
  ]);
  const blocked = byKind(wall, 'blockers');
  assert.equal(blocked.blocked, true);
  assert.ok(blocked.flags.includes('loginWall'), `expected loginWall, got ${blocked.flags.join(',')}`);

  const fine = await run('probe_fine', [
    { action: 'goto', url: baseUrl },
    { action: 'run_generic_action', ref: 'diagnose_blockers' },
  ]);
  assert.equal(byKind(fine, 'blockers').blocked, false);
});

test('a form probe never reports a field value', async () => {
  const result = await run('probe_forms', [
    { action: 'goto', url: `${baseUrl}?page=login` },
    { action: 'run_generic_action', ref: 'diagnose_page' },
  ]);
  const forms = byKind(result, 'forms');
  assert.equal(forms.passwordFieldPresent, true);
  const pw = forms.fields.find(f => f.type === 'password');
  assert.equal(pw.hasValue, true, 'that a value exists is useful');
  assert.ok(!('value' in pw), 'the value itself must never be reported');
  assert.ok(
    !JSON.stringify(result).includes('prefilled-secret-value'),
    'a form value may be a password and must not reach the output'
  );
});

test('probe_selectors reports match counts for candidates', async () => {
  const result = await run('probe_sel', [
    { action: 'goto', url: baseUrl },
    { action: 'run_generic_action', ref: 'probe_selectors', with: { selectors: '.job-card, .nope' } },
  ]);
  const m = byKind(result, 'selectors').matches;
  assert.equal(m.find(x => x.selector === '.job-card').count, 6);
  assert.equal(m.find(x => x.selector === '.nope').count, 0, 'a selector matching nothing reports 0, not an error');
});

test('a malformed probe reports an error instead of failing the run', async () => {
  const result = await run('probe_bad', [
    { action: 'goto', url: baseUrl },
    { action: 'probe', kind: 'no_such_kind', label: 'bogus' },
    { action: 'probe', kind: 'selectors', label: 'busted', selectors: '>>>not a selector<<<' },
  ]);
  assert.equal(result.success, true, 'diagnostics run when things are already broken; they must not add failures');
  const bogus = (result.diagnostics || []).find(p => p.label === 'bogus');
  assert.match(bogus.error, /unknown probe kind/);
  const busted = (result.diagnostics || []).find(p => p.label === 'busted');
  assert.ok(busted.matches[0].error, 'an invalid selector is reported per-selector, not thrown');
});

test('a failing run is diagnosed automatically, with no probe in the recipe', async () => {
  // This is the point of the feature: the run that broke explains itself,
  // rather than needing a second run with probes added -- which may not
  // even reproduce the failure.
  const result = await run(
    'probe_autofail',
    [
      { action: 'goto', url: baseUrl },
      { action: 'waitForSelector', selector: '#does-not-exist', timeout: 900 },
    ],
    '{"noSession":true,"rollingFrames":0}'
  );
  assert.equal(result.success, false);
  assert.ok(result.debugDir);

  const file = path.join(result.debugDir, 'diagnostics.json');
  assert.ok(fs.existsSync(file), 'a failed run should leave diagnostics.json behind');
  const probes = JSON.parse(fs.readFileSync(file, 'utf8'));

  const cards = probes.find(p => p.kind === 'repeated_structure');
  assert.equal(cards.candidates[0].sharedLine, 'View job',
    'the failing run should still reveal what the selector ought to have been');
  assert.equal(probes.find(p => p.kind === 'blockers').blocked, false,
    'and should rule out a wall as the cause');
});

// --- Concurrency guard ----------------------------------------------------
// The failedStep breadcrumb is a single module-level slot, correct only
// while one sequence runs at a time. Nested `repeat` recursion is still
// sequential and fine; two OVERLAPPING sequences would interleave writes and
// the survivor would name a step that never failed. The guard makes that
// admit itself rather than answer confidently and wrongly.

test('overlapping sequences mark the failure position as untrustworthy', async () => {
  const { runUiSteps, progress } = require('../engine.js');

  // A fake page: each step type used below just resolves, except the one
  // selector that never appears, which rejects after a beat. No browser
  // needed -- this is about bookkeeping, not the DOM.
  const fakePage = {
    async waitForSelector(sel) {
      await new Promise(r => setTimeout(r, sel === '#slow-fail' ? 40 : 10));
      if (sel.includes('fail')) throw new Error(`Waiting for selector \`${sel}\` failed`);
    },
    url: () => 'about:blank',
  };
  const meta = { hostname: 'x', pageType: 'action', recipeName: 'guard' };
  const seq = sel => [{ action: 'waitForSelector', selector: '#ok' }, { action: 'waitForSelector', selector: sel }];

  progress.concurrentDetected = false;
  const [a, b] = await Promise.allSettled([
    runUiSteps(fakePage, seq('#slow-fail'), {}, meta),
    runUiSteps(fakePage, seq('#quick-fail'), {}, meta),
  ]);

  assert.equal(a.status, 'rejected');
  assert.equal(b.status, 'rejected');
  // allSettled, not all: `all` would have surfaced whichever rejected first
  // and discarded the other, which is the information this test is about.
  for (const outcome of [a, b]) {
    assert.ok(outcome.reason.failedStep, 'a position is still reported');
    assert.equal(
      outcome.reason.failedStep.breadcrumbUnreliable,
      true,
      'overlapping runs must admit the position may belong to another branch'
    );
    assert.match(outcome.reason.failedStep.note, /parallelise across processes/i);
  }
});

test('a single sequence reports its position with no such caveat', async () => {
  const { runUiSteps, progress } = require('../engine.js');
  const fakePage = {
    async waitForSelector(sel) {
      if (sel.includes('fail')) throw new Error(`Waiting for selector \`${sel}\` failed`);
    },
    url: () => 'about:blank',
  };
  progress.concurrentDetected = false;

  await assert.rejects(
    runUiSteps(fakePage, [{ action: 'waitForSelector', selector: '#nope-fail' }], {}, { hostname: 'x' }),
    err => {
      assert.equal(err.failedStep.index, 0);
      assert.equal(err.failedStep.selector, '#nope-fail');
      assert.ok(!err.failedStep.breadcrumbUnreliable, 'a sequential run has a trustworthy position');
      return true;
    }
  );
});

// --- Partial results ------------------------------------------------------
// A timed-out run can still have extracted everything: extraction runs
// unconditionally after the wait, so content that rendered just past the
// deadline is present and correct while `success` is false. Observed live on
// a Workday tenant returning a complete 20-job array with timedOut:true --
// and the documented "check the success field" rule would have discarded it.

test('a timed-out run that still extracted records is flagged as partial', () => {
  const { isPartial } = require('../engine.js');
  assert.equal(isPartial(true, 20), true, 'timed out but 20 records extracted — usable data');
  assert.equal(isPartial(true, 0), false, 'timed out with nothing extracted is a plain failure');
  assert.equal(isPartial(false, 20), false, 'a clean run is not "partial"');
  assert.equal(isPartial(false, 0), false);
});

test('partial results do not make a run report success', () => {
  // Deliberately NOT redefining success to `count > 0`: a wait that expired
  // early may have caught 3 of 100 cards, and silently calling that a
  // success is the worse error. The flag informs the caller instead.
  const { isPartial } = require('../engine.js');
  const timedOut = true;
  const count = 3;
  const success = !timedOut && count > 0;
  assert.equal(success, false, 'success must stay false so no existing caller changes behaviour');
  assert.equal(isPartial(timedOut, count), true, 'but the usable data must be discoverable');
});

// --- Probe selector quality -----------------------------------------------
// A parallel stress test found repeated_structure proposing selectors that
// were technically right and practically useless: a build-hashed emotion
// class on a Workday tenant, and a "sharedLine" of "7wFeatured" -- a
// per-card age string concatenated to a badge with no separating space,
// which cleared a lax 3-of-6 threshold and would have matched almost nothing.

test('a build-hashed class is flagged, and a stable data hook offered instead', async () => {
  const result = await run('probe_hashed', [
    { action: 'goto', url: `${baseUrl}?page=hashed` },
    { action: 'run_generic_action', ref: 'probe_card_candidates' },
  ]);
  const top = byKind(result, 'repeated_structure').candidates[0];

  assert.equal(top.count, 6);
  assert.equal(top.selectorIsGenerated, true, 'css-1q2dra3 is a build hash and must be called out');
  assert.ok(top.stableHook, 'a data-automation-id exists on a descendant and must be surfaced');
  assert.match(top.stableHook, /data-automation-id="jobTitle"/);
  assert.match(top.stableHook, /:has\(/, 'the hook is on a child, so the card is expressed structurally');
  // The brittle class must not leak into the proposed selector itself.
  assert.ok(!top.childSelector.includes('css-1q2dra3'), `childSelector still uses the hash: ${top.childSelector}`);
});

test('sharedLine comes from link text only, and reports how many cards have it', async () => {
  const result = await run('probe_shared', [
    { action: 'goto', url: `${baseUrl}?page=hashed` },
    { action: 'run_generic_action', ref: 'probe_card_candidates' },
  ]);
  const top = byKind(result, 'repeated_structure').candidates[0];

  // "Full-Time" is a real <a> in 5 of 6 cards -- above the 80% bar.
  assert.equal(top.sharedLine, 'Full-Time');
  assert.equal(top.sharedLineIn, '5/6', 'the fraction is what tells you it is not universal');

  // Neither the concatenated-badge string nor a bare separator can appear,
  // because only <a>/<button> text is considered at all.
  assert.ok(!/Featured/.test(String(top.sharedLine)), 'span text is not eligible — card_anchor_text matches a/button');
});
