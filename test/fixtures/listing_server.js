// Deterministic local fixture for efficiency tests — a fake job-listing
// page with a fixed, known number of cards, so output size can be asserted
// against a real, reproducible baseline instead of a live (and variable)
// site.
const http = require('http');

function cardHtml(i) {
  // Each field on its own block-level element — innerText only inserts line
  // breaks between block-level boxes, not between inline siblings like
  // adjacent <span>s, which would collapse onto one line and break
  // positional_segment extraction.
  //
  // THE CLASSES AND data-* ATTRIBUTES ARE LOAD-BEARING, do not tidy them away.
  // The efficiency test asserts structured output is much smaller than the raw
  // page, and its own rationale is that raw HTML "carries markup/attributes
  // this recipe never touches" — which a fixture of bare <div>s does not. With
  // no markup the page was barely larger than the JSON extracted from it, so
  // the assertion measured almost nothing and tipped over the moment hrefs
  // became absolute (~22 chars x 10 records). Real listing markup is mostly
  // attributes; this approximates that so the ratio means something.
  return `
    <div class="job-card job-card--listing" data-testid="job-card" data-job-id="job-${i}">
      <div class="job-card__meta text-muted small" data-field="posted-at">${i}d</div>
      <div class="job-card__title h3 fw-bold text-truncate" data-field="title">Support Engineer ${i}</div>
      <div class="job-card__location d-flex align-items-center gap-1" data-field="location">Remote</div>
      <a class="job-card__link btn btn-primary btn-sm" data-testid="job-link" href="/job/${i}">View job</a>
    </div>`;
}

function makePage(cardCount) {
  const cards = Array.from({ length: cardCount }, (_, i) => cardHtml(i + 1)).join('\n');
  return `<!doctype html><html><body>${cards}</body></html>`;
}

function startFixtureServer(cardCount = 10) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(makePage(cardCount));
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/` });
    });
  });
}

module.exports = { startFixtureServer, cardHtml, makePage };
