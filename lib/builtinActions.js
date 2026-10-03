// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Regenerated from the generic_actions table by lib/exportBuiltins.js whenever
// a builtin changes. Edit one with:
//
//   node register.js '{"kind":"generic_action","name":"...","steps":[...],"note":"why"}'
//
// which runs the gate: the offline audits before and after, validation of the
// subactions it pulls in AND the dependents it could break, the test suites
// covering all of them, and a rollback if the change introduces a finding.
// Editing this file directly skips every one of those, and the next export
// overwrites it — test/guard.test.js fails on the drift in the meantime.
//
// It is still a FILE, not just a DB row, because data/*.db is gitignored: this
// is how the shared library reaches a fresh clone, and how a change to shared
// behaviour stays reviewable in a diff. It is the export, not the source.
//
// These are seeded into the DB on open (seedBuiltinActions in db.js), which
// validates each one and refuses to seed a builtin that would not run.

const BUILTIN_ACTIONS = [
  {
    "name": "captcha_handoff",
    "description": "Hands control to the PERSON when a CAPTCHA is blocking the page, and does nothing at all when one isn't. Never attempts to solve or bypass a challenge -- like a login handoff, the whole point is that a human does the part a bot must not. The pause is conditional (only_if_selector), so a run on a clean page is unaffected; when a challenge IS present the engine switches to a real visible browser window, the person solves it there, and the run resumes automatically once the challenge element disappears. Compose this at the top of any recipe for a site that intermittently challenges. For a site that challenges EVERY time, prefer marking the recipe status \"blocked\" -- that says a human is required every run, which is a property of the site, not something to paper over with a step.",
    "action_type": null,
    "nav_params_schema": "{\"captcha_timeout_ms\":\"optional ms to wait for the person (default 300000)\"}",
    "changeNote": "seeded from the original library, never edited through the gate",
    "changedAt": null,
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
    "name": "describe_form",
    "description": "DIAGNOSTIC, not an action: reports every form field on the page -- selector, type, label, placeholder, whether it is required and on what evidence (an HTML attribute or a marker in the label, since some sites only mark required-ness in label text), plus whether a file upload exists and which controls would submit. Returns the description in the output JSON diagnostics so a person can decide what to enter; fills in nothing and clicks nothing. Prefer this over diagnose_page on a form page. NEVER reports a field value, only that one is set.",
    "action_type": null,
    "nav_params_schema": "{}",
    "changeNote": "no behavioural change; re-stamping provenance because the prior note was left over from a gate test",
    "changedAt": "2026-09-28T02:46:30.905Z",
    "steps": [
      {
        "action": "probe",
        "kind": "forms",
        "label": "form"
      }
    ]
  },
  {
    "name": "detect_blockers_then_handoff",
    "description": "Reports what kind of wall the page is (CAPTCHA, bot-check, login wall, consent overlay, near-empty body) AND hands off to the person if it is a CAPTCHA. Use when you do not yet know why a site is failing: the probe result lands in the output JSON's `diagnostics` so the cause is recorded even when no human is around, while a solvable challenge still gets the chance to be solved. Solves nothing itself.",
    "action_type": null,
    "nav_params_schema": "{}",
    "changeNote": "seeded from the original library, never edited through the gate",
    "changedAt": null,
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
    "changeNote": "seeded from the original library, never edited through the gate",
    "changedAt": null,
    "steps": [
      {
        "action": "probe",
        "kind": "antibot",
        "label": "antibot"
      }
    ]
  },
  {
    "name": "diagnose_blockers",
    "description": "DIAGNOSTIC, not an action: reports whether the page is a wall rather than the content you asked for -- CAPTCHA (recaptcha/hcaptcha/turnstile frames or challenge text), bot-check/rate-limit text, a login wall (password field or sign-in prompt), a cookie/consent overlay, a scroll lock, or a near-empty body (an SPA that never hydrated). These failure modes are indistinguishable in a bare selector timeout, and telling them apart decides what to do next: solve nothing and back off, add a session/login, or dismiss an overlay. Changes nothing on the page.",
    "action_type": null,
    "nav_params_schema": "{}",
    "changeNote": "seeded from the original library, never edited through the gate",
    "changedAt": null,
    "steps": [
      {
        "action": "probe",
        "kind": "blockers",
        "label": "blockers"
      }
    ]
  },
  {
    "name": "diagnose_empty_result",
    "description": "DIAGNOSTIC, not an action: works out WHY a record lookup came back empty, which is a heuristic that applies to any listing on any site. Distinguishes the three causes that need completely different responses -- the site itself says there are no matches (likelyCause genuinely_empty: the recipe is probably fine, re-check with a query that has results), repeated structure IS on the page so the card matcher missed it (records_present_selector_wrong), or almost nothing rendered at all (page_never_rendered: raise ready_timeout_ms, or it is behind a wall). Also runs the blocker check, since a wall is the other common cause. Guessing between these is expensive: a recipe gets re-derived from scratch when the real answer was 'that keyword has no jobs today'. This same sweep runs automatically on any failed run and is written to the capture's diagnostics.json, so reach for it explicitly when a run SUCCEEDS but returns fewer records than you expected.",
    "action_type": null,
    "nav_params_schema": "{\"record_nouns\":\"optional, comma-separated: what THIS site calls the things it lists ('jobs, openings, positions' / 'courses' / 'properties'). A PARAMETER on purpose -- that vocabulary belongs to the site, not to this action, and hard-coding it here would make a generic action secretly domain-specific. Defaults to the domain-neutral 'results, matches, items, records'.\"}",
    "changeNote": "seeded from the original library, never edited through the gate",
    "changedAt": null,
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
  },
  {
    "name": "diagnose_page",
    "description": "DIAGNOSTIC, not an action: reports what is actually on the page without changing anything. Runs the blocker check (CAPTCHA, bot-check, login wall, consent overlay, near-empty body), the repeated-structure scan that proposes card_selector / card_anchor_text candidates, and a description of any form fields. Use it when building a new recipe or when an existing one returns zero results and you do not yet know why -- it answers 'what am I actually looking at' in one run instead of re-running with guesses. Results come back in the output JSON's `diagnostics` array, never as page changes. This same sweep runs automatically on any failed run and is written to the capture's diagnostics.json, so reach for this explicitly only when the run is NOT failing (a recipe that 'works' but returns the wrong thing).",
    "action_type": null,
    "nav_params_schema": "{}",
    "changeNote": "seeded from the original library, never edited through the gate",
    "changedAt": null,
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
    "name": "dismiss_overlay",
    "description": "DEFAULT overlay handler. Escalating ladder, cheapest/least-signalling rung first: (1) REMOVE the overlay container from the DOM -- sends no consent signal at all and needs no click; (2) if a banner is still there (its container was not one this recognizes), DECLINE it. The rungs compose without any conditional logic because each is already a no-op when nothing matches: if the remove clears the banner, the later click finds nothing. NEVER clicks Accept/Agree: auto-accepting across every site is the least privacy-preserving option and fills the saved session jar with that site's tracking cookies. A banner offering only Accept is left alone (the page usually still works; if it does not, the failure-diagnostics screenshot shows it). Use dismiss_overlay_accept only if a site genuinely gates content behind accepting. Never fails when there is no overlay. Worth knowing about remove-first: clicking Decline often writes that site's 'rejected' cookie, which with session persistence on can stop the banner reappearing on later runs, whereas removing the node writes nothing and pays the cost every run. Remove-first is still the default because it sends no consent signal either way and is faster when it works.",
    "action_type": null,
    "nav_params_schema": "{\"extra_overlay_selector\":\"optional CSS for a banner container this site uses that the built-in list does not recognise. Omit it and the step is skipped.\"}",
    "changeNote": "seeded from the original library, never edited through the gate",
    "changedAt": null,
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
        "action": "remove_element",
        "selector": "{{extra_overlay_selector}}",
        "optional_selector": true,
        "restore_scroll": true
      }
    ]
  },
  {
    "name": "dismiss_overlay_accept",
    "description": "OPT-IN variant: same ladder as dismiss_overlay, plus a final rung that clicks Accept/Agree. Escalating ladder, cheapest/least-signalling rung first: (1) REMOVE the overlay container from the DOM -- sends no consent signal at all and needs no click; (2) if a banner is still there (its container was not one this recognizes), DECLINE it; (3) only if it STILL will not go, accept it. The rungs compose without any conditional logic because each is already a no-op when nothing matches: if the remove clears the banner, the later click finds nothing. The decline pass is a separate earlier step rather than one combined selector list, because a selector list matches in DOM order, not in the order the selectors are written -- a combined list would accept or reject depending on the site's markup order. Verified with Accept placed BEFORE Reject in the markup: it still clicks Reject. Accepting sets that site's tracking cookies, which then persist into the saved session jar, so reach for this only when plain dismiss_overlay has been shown not to get through. Never fails when there is no overlay.",
    "action_type": null,
    "nav_params_schema": "{\"extra_overlay_selector\":\"optional CSS for a banner container this site uses that the built-in list does not recognise. Omit it and the step is skipped.\"}",
    "changeNote": "seeded from the original library, never edited through the gate",
    "changedAt": null,
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
      },
      {
        "action": "remove_element",
        "selector": "{{extra_overlay_selector}}",
        "optional_selector": true,
        "restore_scroll": true
      }
    ]
  },
  {
    "name": "expand_truncated_text",
    "description": "Best-effort: click a 'Show more' / 'See more' / 'Read more' control so deferred body text is in the DOM before extraction. Text/aria heuristics rather than per-site classes. Never fails when there is nothing to expand; runs up to 2 rounds for pages that reveal a second control after the first click. IMPORTANT -- verify a site actually needs this before composing it, because the common case does NOT. Most job boards clip a description VISUALLY (CSS max-height + a Show more button) while innerText already holds the full text, so extraction gets everything without clicking. Measured on linkedin.com job detail: a control run without this step returned a byte-identical 8502-char description, so it was dropped from that recipe -- it cost ~1-2s per fetch for zero gain. Use it only where a control run shows a genuinely SHORTER result without it (i.e. the text is lazily fetched, not just clipped).",
    "action_type": null,
    "nav_params_schema": "{}",
    "changeNote": "seeded from the original library, never edited through the gate",
    "changedAt": null,
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
    "name": "fill_application_form",
    "description": "DRY FILL of a form, built for job applications: takes the field list describe_form / describe_application_form returned (param `fields`) and an answer map keyed by each field's selector (param `answers`), fills text, textareas, selects, react-select style comboboxes, checkboxes and file uploads, and reports per described field filled / failed+reason / unfilled+reason in a top-level `fill` (contract fill_application_form/1, docs/fill-output.md). NEVER submits: no Enter key, no click on a submit control (refused structurally), no navigation. A login, CAPTCHA or bot wall stops it before anything is touched and reports status blocked-attn -- never a workaround. Also reports formChanged (live form hash vs the described one) so a stale packet goes back to review. Answers are never logged or echoed. Run open_apply_form first on boards whose form is behind a button, with an entry_selector that cannot match the submit control.",
    "action_type": null,
    "nav_params_schema": "{\"fields\":\"REQUIRED: the `fields` array from describe_application_form's forms diagnostic, unchanged (the whole forms object is accepted too)\",\"answers\":\"REQUIRED: object keyed by a field's described selector, value = string | number | boolean (checkbox/radio) | absolute file path (file). Pass via ./scrape.sh <target> @params.json, not on the command line.\"}",
    "changeNote": "PLAN-applications.md phase 1 (approved by Jacob 2026-10-03): the fill half of prepare-then-confirm. Generic because the fill logic is the same on every ATS; what differs per board is the field list (from describe) and how to reach the form (open_apply_form). Gated by test/fill.test.js against offline fixtures in test/fixtures/ats/ (Greenhouse now; Lever/Ashby slot in as fixtures).",
    "changedAt": "2026-10-03T19:38:01.994Z",
    "steps": [
      {
        "action": "fill_form",
        "fields": "{{fields}}",
        "answers": "{{answers}}"
      }
    ]
  },
  {
    "name": "infinite_scroll",
    "description": "Infinite-scroll pagination: scrolls to the bottom and waits for the site to append more results, repeated. New results pile up on the same page, so the normal end-of-run extraction reads all of them; no selector needed. For sites with a Next button use 'paginate' instead.",
    "action_type": null,
    "nav_params_schema": "{\"extra_pages\":\"number: how many scroll-and-wait rounds after the first screen (0/blank = none; capped at 50). Usually passed per call.\",\"wait_ms\":\"number, optional: pause after each scroll for new results to load (default 3000).\"}",
    "changeNote": "seeded from the original library, never edited through the gate",
    "changedAt": null,
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
    "name": "open_apply_form",
    "description": "Gets a job posting to the point where its application form is on screen, WITHOUT filling or submitting anything. Dismisses any consent overlay, clicks an 'Apply' entry point if one exists (optional -- wrapped in repeat/stop_if_missing, so it is a no-op on boards whose form is already inline), waits for the form to render, then dismisses again since some banners only appear after the click. The entry click waits up to 15s for the control to render (Lever's Apply link has been measured arriving ~5s in), so a board with an inline form spends those 15s waiting for nothing -- wall clock, not tokens. Derived from building three ATS recipes independently -- Greenhouse (form inline, no click needed), Lever and Ashby (form behind an Apply button) -- whose step lists differed only in wait duration and the Apply selector list. Pass settle_ms via `with` for a slow board. SAFETY: this opens a form, it never submits one. Nothing ever submits unattended: a step that clicks Submit/Send may exist only behind Jacob's explicit yes to a presented batch that listed that application (one yes covers exactly the batch shown), such as an attended handoff (prepare-then-confirm, CLAUDE.md). Pair it with describe_form to see what the form asks.",
    "action_type": null,
    "nav_params_schema": "{\"settle_ms\":\"optional ms to wait for the posting to render before looking for the entry control (default 2000)\",\"entry_selector\":\"optional: the control that opens the form. A PARAMETER because the wording belongs to the site, not to this action -- 'Apply' is job-board vocabulary, and the same shape serves 'Register', 'Enquire', 'Request a quote'. Defaults to a control containing the text 'Apply' that CANNOT submit a form: a button[type=button], an untyped button that no form owns (not inside a form, no form= attribute), or a link. A submit control -- type=submit, an untyped button inside a form, a form= button -- never matches the default, even when it reads 'Apply'. A caller-supplied entry_selector is used as given: keep it unable to match the submit control.\"}",
    "changeNote": "Entry click window 5s -> 15s (timeout: 15000). Live Lever 2026-10-03: the Apply link appeared 4.5-4.9s into the old 5s window on 2 runs and missed on 1, and a miss is silent (the click is optional, so describe reads the posting page: 0 fields, success:true). Wall clock is not a cost. Default selector unchanged (still cannot match a submit control, fd81cf2). Gated by test/fill.test.js: an entry control rendered 9s after load is clicked, and the same click with the old 5s window misses it (control).",
    "changedAt": "2026-10-03T23:46:35.985Z",
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
            "default_selector": "button[type=button]::-p-text(Apply), button:not([type]):not(form button):not([form])::-p-text(Apply), a::-p-text(Apply)",
            "stop_if_missing": true,
            "timeout": 15000
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
    "name": "paginate",
    "description": "Classic Next-button pagination: saves the current page's cards, clicks the site's Next control, waits for the next page, and repeats. Stops early when Next is missing or disabled (last page). Each page is collected before moving on, so it works when Next replaces the page's content. For infinite-scroll sites use 'infinite_scroll' instead. Listing recipes only (uses 'collect').",
    "action_type": null,
    "nav_params_schema": "{\"extra_pages\":\"number: how many more pages after the first (0/blank = first page only; capped at 50). Usually passed per call.\",\"next_selector\":\"CSS selector for the Next control. Usually set once per site via the step's 'with'.\",\"wait_ms\":\"number, optional: pause after each click for the next page to render (default 2500).\"}",
    "changeNote": "seeded from the original library, never edited through the gate",
    "changedAt": null,
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
    "name": "probe_card_anatomy",
    "description": "DIAGNOSTIC, not an action: reads what is INSIDE a card, to choose child_text field selectors. Pass the card container via `with`, e.g. {\"action\":\"run_generic_action\",\"ref\":\"probe_card_anatomy\",\"with\":{\"card_selector\":\"li.ais-Hits-item\"}}. Samples several cards and reports each text-bearing part with a selector, presentIn (how many of the sampled cards have it), maxPerCard (whether child_text needs a segment_index to pick which match), varies (per-card data vs a static label like 'Apply'), and text samples. Use a part with everyCard:true and varies:true as a child_text field; a part with everyCard:false is optional and must never be used as a positional anchor, which is the drift that made four recipes here report a wrong value instead of null. Prefers data-* attributes over class names for the same reason probe_card_candidates does -- a build-hashed class works today and breaks on the next deploy. Never reports the value of a form control. Changes nothing on the page.",
    "action_type": null,
    "nav_params_schema": "{\"card_selector\":\"string, REQUIRED: CSS selector for one card container -- what probe_card_candidates proposes as childSelector or stableHook, or an existing recipe's card_selector.\",\"max_cards\":\"number, optional (default 8, max 8): how many cards to sample. Sampling several is the point -- 'present in every card' cannot be seen from one.\"}",
    "changeNote": "New library action. probe_card_candidates finds the CARD; nothing read what was inside one, so choosing a child_text selector meant guessing and re-running. child_text is now the preferred field kind (positional_segment drifts: an optional badge shifts every index after it, and four recipes reported a wrong value that way), and this is what makes it choosable. Reports, across several cards, which selectors appear in EVERY card, how many times each appears per card, and whether their text varies -- the three facts that separate a field from an optional badge from a static label.",
    "changedAt": "2026-09-28T05:37:51.920Z",
    "steps": [
      {
        "action": "probe",
        "kind": "card_anatomy",
        "label": "card_anatomy",
        "card_selector": "{{card_selector}}",
        "max_cards": "{{max_cards}}"
      }
    ]
  },
  {
    "name": "probe_card_candidates",
    "description": "DIAGNOSTIC, not an action: scans for repeated sibling structures and reports the best card-container candidates, each with a count, average text length, how many contain links, a sample of the text, and the most repeated short line across members (a strong card_anchor_text candidate). Getting card_selector / card_anchor_text wrong is the most common reason a new listing recipe returns zero results, and this replaces guess-then-rerun. Prefer sharedLine as card_anchor_text when one is reported; auto-generated class names (Tailwind JIT and similar) make childSelector brittle. Changes nothing on the page.",
    "action_type": null,
    "nav_params_schema": "{\"min_group\":\"optional integer, minimum repeated siblings to count as a group (default 3)\"}",
    "changeNote": "seeded from the original library, never edited through the gate",
    "changedAt": null,
    "steps": [
      {
        "action": "probe",
        "kind": "repeated_structure",
        "label": "cards",
        "min_group": "{{min_group}}"
      }
    ]
  },
  {
    "name": "probe_card_match",
    "description": "DIAGNOSTIC, not an action: given values a recipe ALREADY produces, finds the selector inside each card whose text equals each one. For a MIGRATION this replaces reading probe_card_anatomy and deciding -- the answer is already known, so it is a search with a checkable result rather than a judgement. Pass the card container and a JSON object of {fieldName: [value per record, in record order]} via `with`, e.g. {\"action\":\"run_generic_action\",\"ref\":\"probe_card_match\",\"with\":{\"card_selector\":\"li.card\",\"expected\":\"{\\\"title\\\":[\\\"Engineer 0\\\",\\\"Engineer 1\\\"]}\"}}. Reports per field: the selector, `index` when it matches more than once per card (the segment_index child_text needs), matchedIn over the cards that COULD have matched, everyCard, and varies. Reports selector:null when no element's full text equals the value -- that means the value is derived (a regex, a substring, an attribute) and the current extract kind should stay, and returning null rather than the nearest thing is the point. Cheap because the filtering happens in the page against the values you already hold, so only matching elements ever cross out: a few hundred bytes where card_anatomy is ~15KB. Falls back to set-membership, and says so, when the page's card count no longer equals the number of records given. Never reports the value of a form control. Changes nothing on the page.",
    "action_type": null,
    "nav_params_schema": "{\"card_selector\":\"string, REQUIRED: CSS selector for one card container -- the recipe's own card_selector, since the point is to re-derive its fields.\",\"expected\":\"string, REQUIRED: JSON object of {fieldName: [value per record]}, in the order the records came back. Nulls are allowed and mark a card that legitimately lacks that field.\",\"max_cards\":\"number, optional (default 8, max 8): how many cards to sample. Several is the point -- 'every card' cannot be seen from one.\"}",
    "changeNote": "Adds the deterministic half of TODO 1a: for a migration the field values are already known, so choosing a child_text selector is a search with a checkable answer, not a judgement. Migrating builtin.com, nodesk.co, wellfound.com and ziprecruiter.com by hand meant reading 12-16 card_anatomy parts per site and deciding each one; every one of those decisions was mechanically derivable from output that already existed. Filtering inside the page against the known values is what makes it cheap (~200B vs card_anatomy's ~15KB) and what keeps it honest: it can only ever propose a selector that demonstrably reproduces a value you already had, and reports null instead of the nearest thing when none does.",
    "changedAt": "2026-09-28T07:18:51.879Z",
    "steps": [
      {
        "action": "probe",
        "kind": "card_match",
        "label": "card_match",
        "card_selector": "{{card_selector}}",
        "expected": "{{expected}}",
        "max_cards": "{{max_cards}}"
      }
    ]
  },
  {
    "name": "probe_pagination_controls",
    "description": "DIAGNOSTIC, not an action: reports HOW this page offers more results, which is the pagination_method decision and, for the paginate action, the next_selector it needs. Companion to probe_card_candidates -- that one proposes card_selector, this one proposes how to get more cards. Reports each control it finds as load_more (a button that appends in place), next_link (a link to the next page), numbered (a run of page-number links) or scroll_sentinel (an element whose name suggests a scroll loader watches it), each with a selector, its text, and whether it is visible and enabled. Also reports paging params already present in the URL, which are often simpler to use than clicking anything. `likely` names the mechanism ONLY when the evidence is unambiguous and is null otherwise -- in particular it CANNOT confirm infinite scroll: whether scrolling appends results is only knowable by scrolling, so a sentinel-shaped element is a hint and the way to settle it is to run the infinite_scroll action and see whether records increase. Takes no parameters. Changes nothing on the page.",
    "action_type": null,
    "nav_params_schema": "{}",
    "changeNote": "Proposes the pagination half of a listing recipe, which was pure guesswork. repeated_structure already proposes card_selector; nothing proposed pagination_method or the next_selector that `paginate` requires -- which is also why paginate is excluded from blind action trials, since it no-ops without a selector and records a misleading no_effect. The text vocabularies (load more / next, in four languages, since stepstone.de is German) live in failures.db as pagination_controls knowledge so meeting a new locale is a row, while the structural signals (rel=next, a run of numeric links) stay in code as markup facts. Deliberately does not claim infinite scroll: only scrolling can establish that, and guessing it would be the confidently-wrong answer this project keeps paying for.",
    "changedAt": "2026-09-29T04:38:36.433Z",
    "steps": [
      {
        "action": "probe",
        "kind": "pagination_controls",
        "label": "pagination_controls"
      }
    ]
  },
  {
    "name": "probe_selectors",
    "description": "DIAGNOSTIC, not an action: for each selector given, reports how many nodes match, how many are visible, and a text sample from the first. Use it to test candidate selectors in ONE run instead of editing the recipe and re-running per guess. Pass selectors as a comma-separated list via `with`, e.g. {\"action\":\"run_generic_action\",\"ref\":\"probe_selectors\",\"with\":{\"selectors\":\".job-card, [data-testid='result'], article\"}}. Plain CSS only -- this evaluates in page context, where Puppeteer's ::-p-text() custom selectors do not exist. Changes nothing on the page.",
    "action_type": null,
    "nav_params_schema": "{\"selectors\":\"required, comma-separated CSS selectors to test\"}",
    "changeNote": "seeded from the original library, never edited through the gate",
    "changedAt": null,
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
    "name": "remove_overlay",
    "description": "STRICT no-click variant: removes the overlay container from the DOM and does nothing else -- guaranteed never to click anything, for when a stray click might navigate or submit. dismiss_overlay already tries this same removal FIRST, so prefer that unless you specifically need the no-click guarantee. Also restores scrolling on body/html, which overlays commonly lock: removing the node alone leaves the page unscrollable and silently breaks a later scroll_bottom/infinite_scroll. Conservative by design -- it can miss a banner whose container it does not recognize, in which case dismiss_overlay's decline rung is what actually clears it. For a site whose overlay you have actually seen, compose a remove_element step directly with that exact selector. Never fails when nothing matches.",
    "action_type": null,
    "nav_params_schema": "{\"extra_overlay_selector\":\"optional CSS for a banner container this site uses that the built-in list does not recognise. Omit it and the step is skipped.\"}",
    "changeNote": "seeded from the original library, never edited through the gate",
    "changedAt": null,
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
        "action": "remove_element",
        "selector": "{{extra_overlay_selector}}",
        "optional_selector": true,
        "restore_scroll": true
      }
    ]
  }
];

module.exports = { BUILTIN_ACTIONS };
