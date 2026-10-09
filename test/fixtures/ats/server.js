// Offline application-form fixtures for test/fill.test.js, keyed by ATS.
//
// Greenhouse is the only one built (PLAN-applications.md phase 1). Lever and
// Ashby are the next entries in ATS_FIXTURES: add an HTML file mirroring that
// board's form markup and an entry here, and every generic gate in
// fill.test.js (outcome for every field, answers change values, zero submits)
// runs against it with no other change, because those tests iterate this map.
//
// The page reports to this server: every submit attempt (click on a submit
// control, the submit event, Enter in a field, a POST to the form action) is
// counted, and the form's current state is posted on every input/change. The
// counters are what "zero clicks on the submit control" is measured against.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ATS_FIXTURES = {
  greenhouse: {
    file: path.join(__dirname, 'greenhouse.html'),
    // What the real board's markup puts in front of the form (mirrored from
    // job-boards.greenhouse.io): a type=button "Apply" that only scrolls.
    topApply: '<button type="button" id="top-apply" class="btn btn--pill" data-entry>Apply</button>',
    submitText: 'Submit application',
  },
  // lever: { file: path.join(__dirname, 'lever.html'), ... }   -- not built yet
  // ashby: { file: path.join(__dirname, 'ashby.html'), ... }   -- not built yet
};

const WALLS = {
  captcha: '<div class="challenge"><p>Please verify you are human to continue.</p></div>',
  login: '<form id="login-gate"><label for="pw">Password</label><input type="password" id="pw" name="pw"></form>',
};

// Entry controls (the thing open_apply_form should click), by ?entry=. Each
// carries data-entry; the page counts a click on it as /entry-click. "typed"
// is the fixture's own topApply. The others are the shapes seen live:
// Ashby's untyped <button> outside any form, Lever's <a>.
const ENTRIES = {
  untyped: '<button id="top-apply" class="btn" data-entry>Apply for this Job</button>',
  link: '<a href="#" id="top-apply" class="postings-btn" data-entry>Apply</a>',
  none: '',
};

// ?groups=1: multi-option questions, in the two live shapes measured
// 2026-10-03. Greenhouse (twitch/jobs/8623401002): a fieldset whose legend is
// the question, aria-required on the fieldset, and `required` on EVERY option
// although one ticked answers it; each option has an id and its own label.
// Lever (palantir/ac978161...): options with NO id, sharing one name, each
// wrapped in its label; the question is a sibling block marked with a "✱".
// Lever's radios carry a value attribute; its checkboxes (a 33-option
// language question) carry NONE, so nothing but position tells them apart.
const GROUPS =
  '<div class="field-wrapper"><fieldset class="checkbox" id="question_3003[]" aria-required="true">' +
  '<legend>Which fixture platforms have you used?<span aria-hidden="true">*</span></legend>' +
  ['Alpha', 'Beta', 'None']
    .map((t, i) => `<div class="checkbox__wrapper"><div class="checkbox__input"><input required type="checkbox" id="question_3003[]_${i}" name="question_3003[]" value="${i}"></div><label for="question_3003[]_${i}">${t}</label></div>`)
    .join('') +
  '</fieldset></div>' +
  '<ul><li class="application-question custom-question"><div>' +
  '<div class="application-label">Are you authorized to work in Fixtureland?<span class="required">✱</span></div>' +
  '<div class="application-field full-width required-field"><ul>' +
  ['Yes', 'No'].map(t => `<li><label><input type="radio" name="cards[fx-0001][field0]" value="${t}" required="required">${t}</label></li>`).join('') +
  '</ul></div></div></li>' +
  '<li class="application-question custom-question"><div>' +
  '<div class="application-label">Which fixture languages do you speak?<span class="required">✱</span></div>' +
  '<div class="application-field full-width required-field"><ul>' +
  ['Fixtish', 'Testese', 'Mockian'].map(t => `<li><label><input type="checkbox" name="cards[fx-0001][field1]" required="">${t}</label></li>`).join('') +
  '</ul></div></div></li></ul>';

// ?multi=1: controls that take SEVERAL options. A react-select isMulti
// combobox (value container `--is-multi`, chips, see the page script) --
// "Saw" and "Saw blade" share a prefix so a prefix match would be caught --
// and a native <select multiple>. ?multi=pre starts the combobox with "Level"
// already chosen. No live Greenhouse field of this kind measured yet (TODO.md).
function multiControls(mode) {
  if (!mode) return '';
  const pre = mode === 'pre' ? ' data-pre="Level"' : '';
  return (
    '<div class="field"><label for="question_4004" id="question_4004-label">Which fixture tools do you use?</label>' +
    `<div class="select__container" data-options='["Hammer","Saw","Saw blade","Level"]'${pre}>` +
    '<div class="select__control"><div class="select__value-container select__value-container--is-multi">' +
    '<div class="select__input-container"><input id="question_4004" class="select__input" type="text" role="combobox" aria-expanded="false" aria-autocomplete="list" aria-labelledby="question_4004-label" autocomplete="off"></div>' +
    '</div></div></div></div>' +
    '<div class="field"><label for="languages">Fixture languages</label>' +
    '<select id="languages" name="languages" multiple>' +
    '<option value="en">English</option><option value="fx" selected>Fixtish</option><option value="ts">Testese</option><option value="mk">Mockian</option>' +
    '</select></div>'
  );
}

// Submit controls, by ?submit=. Every one of these submits the form when
// clicked, and the page counts it: typed, a <button> with no type INSIDE the
// form (submit by default), and a <button form=...> OUTSIDE it (form-owned).
// For test/submit.test.js: `two` (two visible submit controls -- which one
// is meant cannot be known) and `none` (the form owns no submit control).
function submitControl(kind, text) {
  if (kind === 'two') {
    return { inForm: `<button type="submit" id="submit_app" class="btn btn--pill">${text}</button><input type="submit" id="submit_app_2" value="Send">`, outside: '' };
  }
  if (kind === 'none') return { inForm: '', outside: '' };
  if (kind === 'untyped') return { inForm: `<button id="submit_app" class="btn btn--pill">${text}</button>`, outside: '' };
  if (kind === 'form_attr') return { inForm: '', outside: `<button form="application-form" id="submit_app" class="btn btn--pill">${text}</button>` };
  return { inForm: `<button type="submit" id="submit_app" class="btn btn--pill">${text}</button>`, outside: '' };
}

// --- submit outcomes (test/submit.test.js) -----------------------------------
// What /apply answers a real submit with, by ?outcome=. The HTTP status is
// set separately (&status=), so a test can serve a confirmation with a 500
// and an error page with a 200: the status plays no part in the verdict.
// The confirmation text and /confirmation path mirror what Greenhouse is
// believed to show -- unverified live (TODO.md), and it is the recipe's
// confirm_text / confirm_url_includes that carry it, not this file.
const CONFIRM_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>Application submitted</title></head><body>' +
  '<h1>Thank you for applying.</h1><p>Your application to Example Corp (fixture) has been received.</p></body></html>';
const ERROR_BANNER = '<div class="application--error" role="alert">There was a problem with your application. Please review the fields below.</div>';
const OUTCOMES = {
  confirm: true, // 303 to /<ats>/confirmation, as a successful form post would
  error: true, // the form again, with ERROR_BANNER
  wall: true, // a CAPTCHA challenge page
  silent: true, // a page that says nothing either way
};
// ?drift=: the form is not the one described. `1` an extra required
// question; `fill` the same question, appearing on the first input event.
const DRIFT_FIELD =
  '<div class="field"><label for="question_9009">Fixture drift question<span aria-hidden="true">*</span></label>' +
  '<input id="question_9009" name="question_9009" type="text" aria-required="true"></div>';
const DRIFT = {
  1: DRIFT_FIELD,
  fill:
    '<div id="drift-slot"></div><script>(function () { var done = false; document.addEventListener("input", function () {' +
    ` if (done) return; done = true; document.getElementById("drift-slot").innerHTML = ${JSON.stringify(DRIFT_FIELD).replace(/</g, '\\u003c')}; }, true); })();</script>`,
};

function outcomePage(ats, outcome) {
  if (outcome === 'error') return render(ats, new URLSearchParams('banner=error'));
  if (outcome === 'wall') return `<!doctype html><html><head><meta charset="utf-8"><title>Verify</title></head><body>${WALLS.captcha}</body></html>`;
  return '<!doctype html><html><head><meta charset="utf-8"><title>Processing</title></head><body><p>Processing.</p></body></html>';
}

function render(ats, query) {
  const fx = ATS_FIXTURES[ats];
  if (!fx) return null;
  let html = fs.readFileSync(fx.file, 'utf8');
  const wall = WALLS[query.get('wall')] || '';
  // ?submit_text=Apply makes the submit control say "Apply" and, unless
  // ?entry= says otherwise, removes the harmless top button, so a selector
  // matching "Apply" can only find submit.
  const submitText = query.get('submit_text') || fx.submitText;
  const entry = query.get('entry');
  let topApply = entry ? (entry === 'typed' ? fx.topApply : ENTRIES[entry]) : query.get('submit_text') ? '' : fx.topApply;
  if (topApply === undefined) return null; // unknown ?entry= -> 404, never a silent default
  // ?entry_delay_ms=N: the entry control is not in the served HTML; a script
  // inserts it N ms after it runs, the way Lever's Apply link renders late
  // (measured live 2026-10-03: 4.5-4.9s into open_apply_form's click window).
  const delay = query.get('entry_delay_ms');
  if (delay !== null) {
    if (!/^\d+$/.test(delay) || !topApply) return null; // nothing to delay -> 404
    const late = JSON.stringify(topApply).replace(/</g, '\\u003c');
    topApply = `<div id="late-entry"></div><script>setTimeout(function () { document.getElementById('late-entry').innerHTML = ${late}; }, ${Number(delay)});</script>`;
  }
  const submit = submitControl(query.get('submit'), submitText);
  // ?outcome= (with optional &status=): the form posts to /apply carrying them,
  // and the page lets that submit go (see greenhouse.html).
  const outcome = query.get('outcome');
  if (outcome !== null && !OUTCOMES[outcome]) return null; // unknown outcome -> 404, never a silent default
  const applyQuery = outcome ? `?outcome=${outcome}${query.get('status') ? `&status=${encodeURIComponent(query.get('status'))}` : ''}` : '';
  const drift = query.get('drift');
  if (drift !== null && !DRIFT[drift]) return null;
  html = html
    .replace('<!--APPLY_QUERY-->', applyQuery)
    .replace('<!--BANNER-->', query.get('banner') === 'error' ? ERROR_BANNER : '')
    .replace('<!--DRIFT-->', drift ? DRIFT[drift] : '')
    .replace('<!--WALL-->', wall)
    .replace('<!--TOP_APPLY-->', topApply)
    .replace('<!--SUBMIT_IN_FORM-->', submit.inForm)
    .replace('<!--SUBMIT_OUTSIDE_FORM-->', submit.outside)
    .replace('<!--GROUPS-->', query.get('groups') ? GROUPS : '')
    .replace('<!--MULTI-->', multiControls(query.get('multi')))
    // ?captcha=1: the textarea reCAPTCHA's script injects, in its live shape
    // (per-widget id suffix, display:none). No widget, no network.
    .replace('<!--CAPTCHA-->', query.get('captcha')
      ? '<textarea id="g-recaptcha-response-100000" name="g-recaptcha-response" class="g-recaptcha-response" style="display:none"></textarea>'
      : '');
  return html;
}

// /posting: a job posting with NO form -- what describe reads when the entry
// click misses (Lever and Ashby, 2026-10-03). Plenty of text, an Apply link,
// zero form fields; the shape that let a describe stay `working` on nothing.
const POSTING_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>Fixture Engineer</title></head><body>' +
  '<h1>Fixture Engineer</h1><p>About the role: build test fixtures. This page is a posting, not an application form.</p>' +
  '<ul><li>Remote</li><li>Full time</li></ul><a href="#" id="top-apply" data-entry>Apply for this job</a></body></html>';

function startAtsServer() {
  // entryClick is NOT a submit: it counts clicks on the data-entry control.
  const counters = { submitClick: 0, submitEvent: 0, enterKey: 0, applyPost: 0, entryClick: 0 };
  let lastState = null;
  // The bodies of real submits (?outcome= mode), parsed: what was SENT.
  const applyBodies = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let body = '';
    req.on('data', c => {
      body += c;
    });
    req.on('end', () => {
      if (req.method === 'POST') {
        if (u.pathname === '/state') {
          try {
            lastState = JSON.parse(body);
          } catch {
            /* malformed: keep the previous state */
          }
        } else if (u.pathname === '/submit-click') counters.submitClick += 1;
        else if (u.pathname === '/submit-event') counters.submitEvent += 1;
        else if (u.pathname === '/enter-key') counters.enterKey += 1;
        else if (u.pathname === '/apply') {
          counters.applyPost += 1;
          const outcome = u.searchParams.get('outcome');
          if (outcome && OUTCOMES[outcome]) {
            const sent = {};
            for (const [k, v] of new URLSearchParams(body)) sent[k] = k in sent ? [].concat(sent[k], v) : v;
            applyBodies.push(sent);
            const status = Number(u.searchParams.get('status')) || 200;
            if (outcome === 'confirm') {
              res.statusCode = 303;
              res.setHeader('Location', `/greenhouse/confirmation?status=${status}`);
              res.end();
              return;
            }
            res.statusCode = status;
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(outcomePage('greenhouse', outcome));
            return;
          }
        } else if (u.pathname === '/entry-click') counters.entryClick += 1;
        res.setHeader('Content-Type', 'application/json');
        res.end('{}');
        return;
      }
      if (u.pathname === '/greenhouse/confirmation') {
        res.statusCode = Number(u.searchParams.get('status')) || 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(CONFIRM_HTML);
        return;
      }
      // /redirect?to=/path: a 302, so the page lands somewhere other than the URL asked for.
      if (u.pathname === '/redirect') {
        const to = u.searchParams.get('to') || '';
        res.statusCode = to.startsWith('/') && !to.startsWith('//') ? 302 : 404;
        if (res.statusCode === 302) res.setHeader('Location', to);
        res.end();
        return;
      }
      const m = u.pathname.match(/^\/([a-z]+)\/form$/);
      const html = m ? render(m[1], u.searchParams) : u.pathname === '/posting' ? POSTING_HTML : null;
      if (!html) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(html);
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({
        url: (ats, query = '') => `${base}/${ats}/form${query ? `?${query}` : ''}`,
        postingUrl: () => `${base}/posting`,
        redirectUrl: to => `${base}/redirect?to=${encodeURIComponent(to)}`,
        counters,
        submits: () => counters.submitClick + counters.submitEvent + counters.enterKey + counters.applyPost,
        state: () => lastState,
        applyBodies: () => applyBodies.slice(),
        reset: () => {
          for (const k of Object.keys(counters)) counters[k] = 0;
          lastState = null;
          applyBodies.length = 0;
        },
        close: () => new Promise(r => server.close(r)),
      });
    });
  });
}

module.exports = { startAtsServer, ATS_FIXTURES, WALLS, GROUPS };
