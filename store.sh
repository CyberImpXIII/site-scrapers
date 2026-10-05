#!/usr/bin/env bash
# The store's one CLI for its exported form (cli.json): export, import, verify.
# A wrapper so callers (setup's data component, tools/checks' stores-exported)
# need not know the Node 22 path; the system `node` is too old for node:sqlite.
# Usage and the contract: ./store.sh help, and lib/storeExport.js's header.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="$HOME/.nvm/versions/node/v22.20.0/bin/node"
export NODE_NO_WARNINGS=1
exec "$NODE_BIN" "$DIR/store.js" "$@"
