// Child process for test/db-isolation.test.js: a separate process, like every
// engine/verify/lab child the suite spawns, so it proves the override is read
// from the ENVIRONMENT at load time and not passed by the test's own code.
// Writes one fixture recipe through the ordinary accessor and opens the
// failures store; prints the paths it resolved.

const { openDb, upsertSite, getSite, DB_PATH } = require('../../db');
const { openFailuresDb, FAILURES_DB_PATH } = require('../../failuresDb');
const { authorizeForTests } = require('../../lib/writeGuard');

authorizeForTests();
const db = openDb();
const host = process.argv[2];
upsertSite(db, {
  hostname: host,
  page_type: 'listing',
  recipe_name: 'default',
  status: 'needs-review',
  nav_method: 'url_param',
  nav_template: 'http://127.0.0.1:9/{{q}}',
  card_selector: 'div.card',
  notes: 'Test-only recipe for test/db-isolation.test.js; lives only in a throwaway store.',
});
openFailuresDb().close();
process.stdout.write(JSON.stringify({ DB_PATH, FAILURES_DB_PATH, written: !!getSite(db, host) }) + '\n');
