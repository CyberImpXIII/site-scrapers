#!/usr/bin/env bash
# Wrapper so callers don't need to remember the Node 22 nvm path.
# (The system default `node` in PATH is v16, too old for node:sqlite.)
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="$HOME/.nvm/versions/node/v22.20.0/bin/node"
exec "$NODE_BIN" --test "$DIR"/test/*.test.js
