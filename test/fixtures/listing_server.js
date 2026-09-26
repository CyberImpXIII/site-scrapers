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
  return `
    <div>
      <div>${i}d</div>
      <div>Support Engineer ${i}</div>
      <div>Remote</div>
      <a href="/job/${i}">View job</a>
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
