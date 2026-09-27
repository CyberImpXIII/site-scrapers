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

// Every overlay handler ends with this: an OPTIONAL escape hatch letting a
// site contribute its own banner container without forking the action. The
// built-in selector list covers platform vocabulary (ARIA dialog roles,
// OneTrust and friends) which is genuinely site-independent; a site whose
// banner is none of those is site knowledge, and site knowledge belongs to
// the recipe. `optional_selector` makes the step skip itself when the caller
// passes nothing, so the parameter costs existing callers nothing.
const EXTRA_OVERLAY_STEP = {
  action: 'remove_element',
  selector: '{{extra_overlay_selector}}',
  optional_selector: true,
  restore_scroll: true,
};
const EXTRA_OVERLAY_PARAM =
  '"extra_overlay_selector":"optional CSS for a banner container this site uses that the built-in list does not recognise. Omit it and the step is skipped."';

// Applied after the list is defined: appends the escape hatch to each overlay
// handler and advertises the parameter, in one place rather than three copies.
function withOverlayExtension(actions) {
  const overlayHandlers = new Set(['dismiss_overlay', 'dismiss_overlay_accept', 'remove_overlay']);
  for (const a of actions) {
    if (!overlayHandlers.has(a.name)) continue;
    a.steps = [...a.steps, EXTRA_OVERLAY_STEP];
    const existing = (a.nav_params_schema || '{}').trim();
    a.nav_params_schema =
      existing === '{}' || existing === ''
        ? `{${EXTRA_OVERLAY_PARAM}}`
        : `${existing.slice(0, -1)},${EXTRA_OVERLAY_PARAM}}`;
  }
  return actions;
}

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
  },

  {
    "name": "diagnose_page",
    "description": "DIAGNOSTIC, not an action: reports what is actually on the page without changing anything. Runs the blocker check (CAPTCHA, bot-check, login wall, consent overlay, near-empty body), the repeated-structure scan that proposes card_selector / card_anchor_text candidates, and a description of any form fields. Use it when building a new recipe or when an existing one returns zero results and you do not yet know why -- it answers 'what am I actually looking at' in one run instead of re-running with guesses. Results come back in the output JSON's `diagnostics` array, never as page changes. This same sweep runs automatically on any failed run and is written to the capture's diagnostics.json, so reach for this explicitly only when the run is NOT failing (a recipe that 'works' but returns the wrong thing).",
    "action_type": null,
    "nav_params_schema": "{}",
    "steps": [
      {
        "action": "probe",
        "kind": "blockers",
        "label": "blockers"
      },
      {
        "action": "probe",
        "kind": "repeated_structure",
        "label": "cards"
      },
      {
        "action": "probe",
        "kind": "forms",
        "label": "forms"
      }
    ]
  },
  {
    "name": "probe_card_candidates",
    "description": "DIAGNOSTIC, not an action: scans for repeated sibling structures and reports the best card-container candidates, each with a count, average text length, how many contain links, a sample of the text, and the most repeated short line across members (a strong card_anchor_text candidate). Getting card_selector / card_anchor_text wrong is the most common reason a new listing recipe returns zero results, and this replaces guess-then-rerun. Prefer sharedLine as card_anchor_text when one is reported; auto-generated class names (Tailwind JIT and similar) make childSelector brittle. Changes nothing on the page.",
    "action_type": null,
    "nav_params_schema": "{\"min_group\":\"optional integer, minimum repeated siblings to count as a group (default 3)\"}",
    "steps": [
      {
        "action": "probe",
        "kind": "repeated_structure",
        "label": "cards",
        "min_group": 3
      }
    ]
  },
  {
    "name": "diagnose_blockers",
    "description": "DIAGNOSTIC, not an action: reports whether the page is a wall rather than the content you asked for -- CAPTCHA (recaptcha/hcaptcha/turnstile frames or challenge text), bot-check/rate-limit text, a login wall (password field or sign-in prompt), a cookie/consent overlay, a scroll lock, or a near-empty body (an SPA that never hydrated). These failure modes are indistinguishable in a bare selector timeout, and telling them apart decides what to do next: solve nothing and back off, add a session/login, or dismiss an overlay. Changes nothing on the page.",
    "action_type": null,
    "nav_params_schema": "{}",
    "steps": [
      {
        "action": "probe",
        "kind": "blockers",
        "label": "blockers"
      }
    ]
  },
  {
    "name": "probe_selectors",
    "description": "DIAGNOSTIC, not an action: for each selector given, reports how many nodes match, how many are visible, and a text sample from the first. Use it to test candidate selectors in ONE run instead of editing the recipe and re-running per guess. Pass selectors as a comma-separated list via `with`, e.g. {\"action\":\"run_generic_action\",\"ref\":\"probe_selectors\",\"with\":{\"selectors\":\".job-card, [data-testid='result'], article\"}}. Plain CSS only -- this evaluates in page context, where Puppeteer's ::-p-text() custom selectors do not exist. Changes nothing on the page.",
    "action_type": null,
    "nav_params_schema": "{\"selectors\":\"required, comma-separated CSS selectors to test\"}",
    "steps": [
      {
        "action": "probe",
        "kind": "selectors",
        "label": "selectors",
        "selectors": "{{selectors}}"
      }
    ]
  },

  {
    "name": "open_apply_form",
    "description": "Gets a job posting to the point where its application form is on screen, WITHOUT filling or submitting anything. Dismisses any consent overlay, clicks an 'Apply' entry point if one exists (optional -- wrapped in repeat/stop_if_missing, so it is a no-op on boards whose form is already inline), waits for the form to render, then dismisses again since some banners only appear after the click. Derived from building three ATS recipes independently -- Greenhouse (form inline, no click needed), Lever and Ashby (form behind an Apply button) -- whose step lists differed only in wait duration and the Apply selector list. Pass settle_ms via `with` for a slow board. SAFETY: this opens a form, it never submits one. It must never be extended with a step that clicks Submit/Send -- pair it with describe_form and let a person decide what to enter.",
    "action_type": null,
    "nav_params_schema": "{\"settle_ms\":\"optional ms to wait for the posting to render before looking for the entry control (default 2000)\",\"entry_selector\":\"optional: the control that opens the form. A PARAMETER because the wording belongs to the site, not to this action -- 'Apply' is job-board vocabulary, and the same shape serves 'Register', 'Enquire', 'Request a quote'. Defaults to button/a matching the text 'Apply' (substring), which covers 'Apply for this Job' and similar.\"}",
    "steps": [
      {
        "action": "run_generic_action",
        "ref": "dismiss_overlay"
      },
      {
        "action": "wait",
        "ms": "{{settle_ms}}",
        "default_ms": 2000
      },
      {
        "action": "repeat",
        "times": 1,
        "steps": [
          {
            "action": "click",
            "selector": "{{entry_selector}}",
            "default_selector": "button::-p-text(Apply), a::-p-text(Apply)",
            "stop_if_missing": true
          }
        ]
      },
      {
        "action": "wait",
        "ms": 1500
      },
      {
        "action": "run_generic_action",
        "ref": "dismiss_overlay"
      }
    ]
  },
  {
    "name": "describe_form",
    "description": "DIAGNOSTIC, not an action: reports every form field on the page -- selector, type, label, placeholder, whether it is required and on what evidence (an HTML attribute or a '*'/'\u2731' marker in the label, since Greenhouse and Lever only mark required-ness in label text), plus whether a file upload exists and which controls would submit. Returns the description in the output JSON's `diagnostics` so a person can decide what to enter; fills in nothing and clicks nothing. Prefer this over diagnose_page on a form page -- diagnose_page also runs the card-structure and blocker sweeps, which are noise there. NEVER reports a field's value, only that one is set.",
    "action_type": null,
    "nav_params_schema": "{}",
    "steps": [
      {
        "action": "probe",
        "kind": "forms",
        "label": "form"
      }
    ]
  },

  {
    "name": "captcha_handoff",
    "description": "Hands control to the PERSON when a CAPTCHA is blocking the page, and does nothing at all when one isn't. Never attempts to solve or bypass a challenge -- like a login handoff, the whole point is that a human does the part a bot must not. The pause is conditional (only_if_selector), so a run on a clean page is unaffected; when a challenge IS present the engine switches to a real visible browser window, the person solves it there, and the run resumes automatically once the challenge element disappears. Compose this at the top of any recipe for a site that intermittently challenges. For a site that challenges EVERY time, prefer marking the recipe status \"blocked\" -- that says a human is required every run, which is a property of the site, not something to paper over with a step.",
    "action_type": null,
    "nav_params_schema": "{\"captcha_timeout_ms\":\"optional ms to wait for the person (default 300000)\"}",
    "steps": [
      {
        "action": "handoff",
        "only_if_selector": "iframe[src*='recaptcha'], iframe[src*='hcaptcha'], iframe[src*='turnstile'], iframe[title*='challenge' i], .g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey]",
        "reason": "A CAPTCHA or bot-check challenge is on screen. Please solve it in the browser window that just opened; the run continues by itself once the challenge clears.",
        "resume_selector": null,
        "timeout_ms": "{{captcha_timeout_ms}}"
      }
    ]
  },
  {
    "name": "detect_blockers_then_handoff",
    "description": "Reports what kind of wall the page is (CAPTCHA, bot-check, login wall, consent overlay, near-empty body) AND hands off to the person if it is a CAPTCHA. Use when you do not yet know why a site is failing: the probe result lands in the output JSON's `diagnostics` so the cause is recorded even when no human is around, while a solvable challenge still gets the chance to be solved. Solves nothing itself.",
    "action_type": null,
    "nav_params_schema": "{}",
    "steps": [
      {
        "action": "probe",
        "kind": "blockers",
        "label": "blockers"
      },
      {
        "action": "run_generic_action",
        "ref": "captcha_handoff"
      }
    ]
  },

  {
    "name": "diagnose_antibot",
    "description": "DIAGNOSTIC, not an action: identifies which anti-bot service is in play (Cloudflare, DataDome, PerimeterX/HUMAN, Imperva/Incapsula, Akamai) and reports WHERE each signal was found -- page title, body text, script/iframe src, or a DOM element. These services do not appear in one consistent place: Cloudflare alone can surface as a 'Just a moment...' title, a #cf-wrapper element, a /cdn-cgi/challenge-platform/ script, a Turnstile iframe, or only a Ray ID in the body, depending on the challenge type and how far it got. Crucially it separates `blocking` (the challenge IS the page) from `presentButNotBlocking` (a widget sits on an otherwise working page, e.g. a reCAPTCHA on a job-posting form) -- conflating those wrongly condemns a working recipe. Also reports automationSignals (navigator.webdriver, headless UA, missing plugins) so a refusal can be attributed to how the browser presents itself rather than to the site refusing automation outright. SOLVES AND EVADES NOTHING: when blocking is true the correct response is to mark the recipe \"blocked\" and run it attended, or tell the user -- never to work around the challenge.",
    "action_type": null,
    "nav_params_schema": "{}",
    "steps": [
      {
        "action": "probe",
        "kind": "antibot",
        "label": "antibot"
      }
    ]
  },
  {
    "name": "diagnose_empty_result",
    "description": "DIAGNOSTIC, not an action: works out WHY a record lookup came back empty, which is a heuristic that applies to any listing on any site. Distinguishes the three causes that need completely different responses -- the site itself says there are no matches (likelyCause genuinely_empty: the recipe is probably fine, re-check with a query that has results), repeated structure IS on the page so the card matcher missed it (records_present_selector_wrong), or almost nothing rendered at all (page_never_rendered: raise ready_timeout_ms, or it is behind a wall). Also runs the blocker check, since a wall is the other common cause. Guessing between these is expensive: a recipe gets re-derived from scratch when the real answer was 'that keyword has no jobs today'. This same sweep runs automatically on any failed run and is written to the capture's diagnostics.json, so reach for it explicitly when a run SUCCEEDS but returns fewer records than you expected.",
    "action_type": null,
    "nav_params_schema": "{\"record_nouns\":\"optional, comma-separated: what THIS site calls the things it lists ('jobs, openings, positions' / 'courses' / 'properties'). A PARAMETER on purpose -- that vocabulary belongs to the site, not to this action, and hard-coding it here would make a generic action secretly domain-specific. Defaults to the domain-neutral 'results, matches, items, records'.\"}",
    "steps": [
      {
        "action": "probe",
        "kind": "empty_state",
        "label": "empty",
        "record_nouns": "{{record_nouns}}"
      },
      {
        "action": "probe",
        "kind": "blockers",
        "label": "blockers"
      },
      {
        "action": "probe",
        "kind": "repeated_structure",
        "label": "cards"
      }
    ]
  }
];

module.exports = { BUILTIN_ACTIONS: withOverlayExtension(BUILTIN_ACTIONS) };
