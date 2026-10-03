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
    topApply: '<button type="button" id="top-apply" class="btn btn--pill">Apply</button>',
    submitText: 'Submit application',
  },
  // lever: { file: path.join(__dirname, 'lever.html'), ... }   -- not built yet
  // ashby: { file: path.join(__dirname, 'ashby.html'), ... }   -- not built yet
};

const WALLS = {
  captcha: '<div class="challenge"><p>Please verify you are human to continue.</p></div>',
  login: '<form id="login-gate"><label for="pw">Password</label><input type="password" id="pw" name="pw"></form>',
};

function render(ats, query) {
  const fx = ATS_FIXTURES[ats];
  if (!fx) return null;
  let html = fs.readFileSync(fx.file, 'utf8');
  const wall = WALLS[query.get('wall')] || '';
  // ?submit_text=Apply makes the submit control say "Apply" and removes the
  // harmless top button, so a selector matching "Apply" can only find submit.
  const submitText = query.get('submit_text') || fx.submitText;
  const topApply = query.get('submit_text') ? '' : fx.topApply;
  html = html.replace('<!--WALL-->', wall).replace('<!--TOP_APPLY-->', topApply).replace('SUBMIT_TEXT', submitText);
  return html;
}

function startAtsServer() {
  const counters = { submitClick: 0, submitEvent: 0, enterKey: 0, applyPost: 0 };
  let lastState = null;
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
        else if (u.pathname === '/apply') counters.applyPost += 1;
        res.setHeader('Content-Type', 'application/json');
        res.end('{}');
        return;
      }
      const m = u.pathname.match(/^\/([a-z]+)\/form$/);
      const html = m ? render(m[1], u.searchParams) : null;
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
        counters,
        submits: () => counters.submitClick + counters.submitEvent + counters.enterKey + counters.applyPost,
        state: () => lastState,
        reset: () => {
          for (const k of Object.keys(counters)) counters[k] = 0;
          lastState = null;
        },
        close: () => new Promise(r => server.close(r)),
      });
    });
  });
}

module.exports = { startAtsServer, ATS_FIXTURES, WALLS };
