#!/usr/bin/env bash
# FIXTURE: a stand-in site-scrapers dev.sh for test/hooks.test.js, so the hooks
# and their tests run against a known recipe table without the real DB.
# Implements only what the hooks and their tests call: known, failures,
# browser-ok. browser-ok mirrors the real one's SS_BROWSER_OK handling; the real
# one is tested for that separately.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BROWSER_OK="${SS_BROWSER_OK:-$DIR/data/.browser-ok}"
case "${1:-}" in
  known)
    case "${2:-}" in
      example.test|*.example.test) printf 'example.test#listing:default\tworking\n' ;;
      broken.test)                 printf 'broken.test#listing:default\tbroken\n' ;;
      attn.test)                   printf 'attn.test#listing:default\tblocked-attn\n' ;;
    esac
    ;;
  failures) : ;;
  blocked)  : ;;
  browser-ok)
    mkdir -p "$(dirname "$BROWSER_OK")"
    date +%s > "$BROWSER_OK"
    echo "${2:-15}" >> "$BROWSER_OK"
    ;;
esac
exit 0
