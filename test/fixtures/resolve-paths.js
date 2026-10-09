// Prints the store paths db.js and failuresDb.js resolved from this process's
// environment. Opens nothing. test/db-isolation.test.js.
const { DB_PATH } = require('../../db');
const { FAILURES_DB_PATH } = require('../../failuresDb');
process.stdout.write(JSON.stringify({ DB_PATH, FAILURES_DB_PATH }) + '\n');
