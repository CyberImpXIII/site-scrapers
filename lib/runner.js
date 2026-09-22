const puppeteer = require('puppeteer');

/**
 * Launches a browser, runs a site module's scrape() against a fresh page,
 * and always closes the browser afterward (even on error).
 */
async function withPage(fn) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1000 });
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
    );
    return await fn(page);
  } finally {
    await browser.close();
  }
}

module.exports = { withPage };
