# site-scrapers — quick use

Prefer this over interactive browser tools for job sites. Recipes live in a
DB, not per-site code. Three recipe types (`page_type`): `listing` (results
page, repeated cards — default), `article` (single detail/post page), and
`action` (a repeatable, parameterized automation — login, add-to-cart, etc;
runs the same as `article` — steps, then optional field capture — it's a
separate type purely for organization). Pick with a `#` suffix, e.g.
`hiringcafe.com#article`; omit it for `listing`.

A hostname can hold more than one recipe of the *same* page_type too (e.g.
two `action` recipes) — add `:recipe_name`, e.g. `example.com#action:login`
vs `example.com#action:add_to_cart`. Omit it for the single/primary recipe of
a page_type (implicit `recipe_name` = `default`).

1. `node query.js site <hostname>[#page_type[:recipe_name]]` — check if known
   first. `node query.js sites` lists every registered recipe (all
   hostnames/page_types/recipe_names) if you're not sure what's there.
2. Known + `working` → `./scrape.sh <hostname>[#page_type[:recipe_name]] '<json params>'`
   (article/action recipes take whatever params their `nav_params_schema`
   documents — often `{"url": "<full page url>"}` for article, or credentials/
   inputs substituted into `ui_steps` for action). Check the `success` field,
   not exit code. Add trailing `--raw` only when debugging extraction
   (roughly doubles output size) — omit it otherwise.
3. `documented:false` → nothing known. `documented:true, success:false` →
   broken/needs-review, or this run failed — check `error`/`timedOut`/
   `consistencyWarning`.
4. Unknown or broken → fall back to interactive browser tools.
5. Whenever navigating to a page to *do* something for the user — not just
   to scrape a listing/article — confirm with the user whether they'd like
   that action stored as a reusable, adjustable recipe (`page_type: action`)
   before moving on, rather than assuming a one-off interactive pass is
   fine. Don't ask this for read-only listing/article lookups.
6. After a successful interactive session (and the user said yes to step 5,
   for actions), document it: `node register.js '<recipe json>'` (all three
   JSON shapes are in register.js's header comment). Give it an explicit
   `recipe_name` if the hostname already has a recipe of the same page_type.

For `action` recipes specifically, prefer keeping them within the small
`action_types` taxonomy (`node query.js action-types`) rather than inventing
arbitrary, similar-but-not-quite-the-same types (e.g. `add_to_cart` on one
site and `add-to-basket` on another for the same underlying action).
`register.js` enforces this — it rejects an `action_type` that isn't already
in the taxonomy unless you deliberately add `new_action_type_description` to
register a genuinely new one. Reach for that escape hatch only when nothing
existing actually fits, not as a default.

Credential-shaped values (passwords, tokens) for an `action` recipe belong in
caller-supplied params at run time, never written into the stored recipe
(`nav_template`/`notes`/`fields`) — same as any other param, just don't let
it end up in the DB.

No auto-detector yet for which page_type a URL is — you have to know/guess.

Full details: README.md.
