// The built-in generic_actions library — canonical source of truth.
//
// These live in code, not only in the DB, because they are LIBRARY
// BEHAVIOR rather than site knowledge. The DB earns its keep for per-site
// recipes: those are numerous, discovered empirically, fixed by one-row
// updates, and carry the job-search queries/URLs that are exactly why
// data/scrapers.db is gitignored. Generic actions are the opposite — few,
// stable, hostname-independent, and containing nothing private. Keeping
// them here means they are version-controlled, reviewable in a diff,
// portable, and present in a fresh clone instead of vanishing with the
// untracked DB.
//
// They are still SEEDED INTO the DB on open (see seedBuiltinActions in
// db.js) so everything downstream keeps working unchanged: run_generic_action
// resolution, cycle detection, `with` substitution, `query.js
// generic-actions`, `query.js expand generic:<name>`. Same split the
// action_types taxonomy already uses.
//
// Re-seeding upserts ONLY rows marked source='builtin', so anything you
// register by hand is left alone. The flip side: editing a builtin's row
// in the DB is pointless, since the next open overwrites it — to customize
// one, register it under a new name (that copy is source='user' and is
// never touched).

const BUILTIN_ACTIONS = [
  {
    "name": "dismiss_overlay",
    "description": "DEFAULT overlay handler. Escalating ladder, cheapest/least-signalling rung first: (1) REMOVE the overlay container from the DOM -- sends no consent signal at all and needs no click; (2) if a banner is still there (its container was not one this recognizes), DECLINE it. The rungs compose without any conditional logic because each is already a no-op when nothing matches: if the remove clears the banner, the later click finds nothing. NEVER clicks Accept/Agree: auto-accepting across every site is the least privacy-preserving option and fills the saved session jar with that site's tracking cookies. A banner offering only Accept is left alone (the page usually still works; if it does not, the failure-diagnostics screenshot shows it). Use dismiss_overlay_accept only if a site genuinely gates content behind accepting. Never fails when there is no overlay. Worth knowing about remove-first: clicking Decline often writes that site's 'rejected' cookie, which with session persistence on can stop the banner reappearing on later runs, whereas removing the node writes nothing and pays the cost every run. Remove-first is still the default because it sends no consent signal either way and is faster when it works.",
    "action_type": null,
    "nav_params_schema": "{}",
    "steps": [
      {
        "action": "remove_element",
        "selector": "[role='dialog'][aria-modal='true'], [role='alertdialog'], #onetrust-consent-sdk, #onetrust-banner-sdk, #cookie-banner, #cookie-consent, .cc-window, [id*='cookie-banner' i], [class*='cookie-banner' i], [id*='consent-banner' i], [class*='consent-banner' i]",
        "restore_scroll": true
      },
      {
        "action": "wait",
        "ms": 200
      },
      {
        "action": "repeat",
        "times": 2,
        "steps": [
          {
            "action": "click",
            "selector": "button::-p-text(Reject all), button::-p-text(Reject), button::-p-text(Decline), button::-p-text(Necessary only), button::-p-text(Only necessary), button::-p-text(No thanks), button::-p-text(Dismiss), button::-p-text(Got it), ::-p-aria(Close)",
            "stop_if_missing": true,
            "timeout": 1200
          },
          {
            "action": "wait",
            "ms": 350
          }
        ]
      }
    ]
  },
  {
    "name": "dismiss_overlay_accept",
    "description": "OPT-IN variant: same ladder as dismiss_overlay, plus a final rung that clicks Accept/Agree. Escalating ladder, cheapest/least-signalling rung first: (1) REMOVE the overlay container from the DOM -- sends no consent signal at all and needs no click; (2) if a banner is still there (its container was not one this recognizes), DECLINE it; (3) only if it STILL will not go, accept it. The rungs compose without any conditional logic because each is already a no-op when nothing matches: if the remove clears the banner, the later click finds nothing. The decline pass is a separate earlier step rather than one combined selector list, because a selector list matches in DOM order, not in the order the selectors are written -- a combined list would accept or reject depending on the site's markup order. Verified with Accept placed BEFORE Reject in the markup: it still clicks Reject. Accepting sets that site's tracking cookies, which then persist into the saved session jar, so reach for this only when plain dismiss_overlay has been shown not to get through. Never fails when there is no overlay.",
    "action_type": null,
    "nav_params_schema": "{}",
    "steps": [
      {
        "action": "remove_element",
        "selector": "[role='dialog'][aria-modal='true'], [role='alertdialog'], #onetrust-consent-sdk, #onetrust-banner-sdk, #cookie-banner, #cookie-consent, .cc-window, [id*='cookie-banner' i], [class*='cookie-banner' i], [id*='consent-banner' i], [class*='consent-banner' i]",
        "restore_scroll": true
      },
      {
        "action": "wait",
        "ms": 200
      },
      {
        "action": "repeat",
        "times": 2,
        "steps": [
          {
            "action": "click",
            "selector": "button::-p-text(Reject all), button::-p-text(Reject), button::-p-text(Decline), button::-p-text(Necessary only), button::-p-text(Only necessary), button::-p-text(No thanks), button::-p-text(Dismiss), button::-p-text(Got it), ::-p-aria(Close)",
            "stop_if_missing": true,
            "timeout": 1200
          },
          {
            "action": "wait",
            "ms": 350
          }
        ]
      },
      {
        "action": "repeat",
        "times": 1,
        "steps": [
          {
            "action": "click",
            "selector": "button::-p-text(Accept all), button::-p-text(Accept), button::-p-text(Agree), button::-p-text(I agree), button::-p-text(Allow all)",
            "stop_if_missing": true,
            "timeout": 1200
          },
          {
            "action": "wait",
            "ms": 350
          }
        ]
      }
    ]
  },
  {
    "name": "expand_truncated_text",
    "description": "Best-effort: click a 'Show more' / 'See more' / 'Read more' control so deferred body text is in the DOM before extraction. Text/aria heuristics rather than per-site classes. Never fails when there is nothing to expand; runs up to 2 rounds for pages that reveal a second control after the first click. IMPORTANT -- verify a site actually needs this before composing it, because the common case does NOT. Most job boards clip a description VISUALLY (CSS max-height + a Show more button) while innerText already holds the full text, so extraction gets everything without clicking. Measured on linkedin.com job detail: a control run without this step returned a byte-identical 8502-char description, so it was dropped from that recipe -- it cost ~1-2s per fetch for zero gain. Use it only where a control run shows a genuinely SHORTER result without it (i.e. the text is lazily fetched, not just clipped).",
    "action_type": null,
    "nav_params_schema": "{}",
    "steps": [
      {
        "action": "repeat",
        "times": 2,
        "steps": [
          {
            "action": "click",
            "selector": "button::-p-text(Show more), button::-p-text(See more), button::-p-text(Read more), button::-p-text(Show full description), button::-p-text(More details), a::-p-text(Show more), a::-p-text(See more), ::-p-aria(Show more)",
            "stop_if_missing": true,
            "timeout": 1200
          },
          {
            "action": "wait",
            "ms": 400
          }
        ]
      }
    ]
  },
  {
    "name": "infinite_scroll",
    "description": "Infinite-scroll pagination: scrolls to the bottom and waits for the site to append more results, repeated. New results pile up on the same page, so the normal end-of-run extraction reads all of them; no selector needed. For sites with a Next button use 'paginate' instead.",
    "action_type": null,
    "nav_params_schema": "{\"extra_pages\":\"number: how many scroll-and-wait rounds after the first screen (0/blank = none; capped at 50). Usually passed per call.\",\"wait_ms\":\"number, optional: pause after each scroll for new results to load (default 3000).\"}",
    "steps": [
      {
        "action": "repeat",
        "times": "{{extra_pages}}",
        "steps": [
          {
            "action": "scroll_bottom"
          },
          {
            "action": "wait",
            "ms": "{{wait_ms}}",
            "default_ms": 3000
          }
        ]
      }
    ]
  },
  {
    "name": "paginate",
    "description": "Classic Next-button pagination: saves the current page's cards, clicks the site's Next control, waits for the next page, and repeats. Stops early when Next is missing or disabled (last page). Each page is collected before moving on, so it works when Next replaces the page's content. For infinite-scroll sites use 'infinite_scroll' instead. Listing recipes only (uses 'collect').",
    "action_type": null,
    "nav_params_schema": "{\"extra_pages\":\"number: how many more pages after the first (0/blank = first page only; capped at 50). Usually passed per call.\",\"next_selector\":\"CSS selector for the Next control. Usually set once per site via the step's 'with'.\",\"wait_ms\":\"number, optional: pause after each click for the next page to render (default 2500).\"}",
    "steps": [
      {
        "action": "repeat",
        "times": "{{extra_pages}}",
        "steps": [
          {
            "action": "collect"
          },
          {
            "action": "click",
            "selector": "{{next_selector}}",
            "stop_if_missing": true
          },
          {
            "action": "wait",
            "ms": "{{wait_ms}}",
            "default_ms": 2500
          }
        ]
      }
    ]
  },
  {
    "name": "remove_overlay",
    "description": "STRICT no-click variant: removes the overlay container from the DOM and does nothing else -- guaranteed never to click anything, for when a stray click might navigate or submit. dismiss_overlay already tries this same removal FIRST, so prefer that unless you specifically need the no-click guarantee. Also restores scrolling on body/html, which overlays commonly lock: removing the node alone leaves the page unscrollable and silently breaks a later scroll_bottom/infinite_scroll. Conservative by design -- it can miss a banner whose container it does not recognize, in which case dismiss_overlay's decline rung is what actually clears it. For a site whose overlay you have actually seen, compose a remove_element step directly with that exact selector. Never fails when nothing matches.",
    "action_type": null,
    "nav_params_schema": "{}",
    "steps": [
      {
        "action": "remove_element",
        "selector": "[role='dialog'][aria-modal='true'], [role='alertdialog'], #onetrust-consent-sdk, #onetrust-banner-sdk, #cookie-banner, #cookie-consent, .cc-window, [id*='cookie-banner' i], [class*='cookie-banner' i], [id*='consent-banner' i], [class*='consent-banner' i]",
        "restore_scroll": true
      },
      {
        "action": "wait",
        "ms": 200
      }
    ]
  }
];

module.exports = { BUILTIN_ACTIONS };
