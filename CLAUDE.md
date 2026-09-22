# site-scrapers — quick use

Prefer this over interactive browser tools for job sites. Recipes live in a
DB, not per-site code. Two recipe types (`page_type`): `listing` (results
page, repeated cards — default) and `article` (single detail/post page).
Pick with a `#` suffix, e.g. `hiringcafe.com#article`; omit it for `listing`.

1. `node query.js site <hostname>[#page_type]` — check if known first.
2. Known + `working` → `./scrape.sh <hostname>[#page_type] '<json params>'`
   (article recipes take `{"url": "<full page url>"}`). Check the `success`
   field, not exit code. Add trailing `--raw` only when debugging extraction
   (roughly doubles output size) — omit it otherwise.
3. `documented:false` → nothing known. `documented:true, success:false` →
   broken/needs-review, or this run failed — check `error`/`timedOut`/
   `consistencyWarning`.
4. Unknown or broken → fall back to interactive browser tools.
5. After a successful interactive session, document it:
   `node register.js '<recipe json>'` (both JSON shapes are in register.js's
   header comment).

No auto-detector yet for which page_type a URL is — you have to know/guess.

Full details: README.md.
