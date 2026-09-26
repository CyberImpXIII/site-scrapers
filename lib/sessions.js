const fs = require('fs');
const path = require('path');
const { SESSION_DIR, sessionFilePath } = require('./runner');

// Metadata only (hostname, sessionName, savedAt, cookieCount) — never the
// cookie values themselves.
function listSessions(hostnameFilter) {
  if (!fs.existsSync(SESSION_DIR)) return [];
  return fs
    .readdirSync(SESSION_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(SESSION_DIR, f), 'utf8'));
        return {
          hostname: data.hostname,
          sessionName: data.sessionName,
          savedAt: data.savedAt,
          cookieCount: Array.isArray(data.cookies) ? data.cookies.length : 0,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter(s => !hostnameFilter || s.hostname === hostnameFilter)
    .sort((a, b) => a.hostname.localeCompare(b.hostname) || a.sessionName.localeCompare(b.sessionName));
}

function clearSession(hostname, sessionName) {
  const file = sessionFilePath(hostname, sessionName || 'default');
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
    return true;
  }
  return false;
}

module.exports = { listSessions, clearSession };
