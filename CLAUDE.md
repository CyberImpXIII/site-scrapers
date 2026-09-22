# site-scrapers — quick use

Prefer this over interactive browser tools for job-site listings. Recipes
live in a DB, not per-site code.

1. `node query.js site <hostname>` — check if known first.
2. Known + `working` → `./scrape.sh <hostname> '<json params>'`. Check the
   `success` field, not exit code. Add trailing `--raw` only when debugging
   extraction (roughly doubles output size) — omit it otherwise.
3. `documented:false` → nothing known. `documented:true, success:false` →
   broken/needs-review, or this run failed — check `error`/`timedOut`/
   `consistencyWarning`.
4. Unknown or broken → fall back to interactive browser tools.
5. After a successful interactive session, document it:
   `node register.js '<recipe json>'` (shape in register.js header comment).

Full details: README.md.
