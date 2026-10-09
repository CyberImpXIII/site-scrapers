// Baseline signatures for the things that wall a page: anti-bot services,
// login walls, consent overlays.
//
// This is the SEED, not the whole set. These rows are loaded into
// the failures store's `blocker_signatures` table, and new ones discovered while
// troubleshooting are added there (`node failures.js add-signature`) without
// touching this file. A signature that turns out to be general gets promoted
// back into this baseline so a fresh clone has it.
//
// Why not a static array in probes.js: this is exactly the knowledge that
// grows. Anti-bot vendors change their markup, new services appear, and a
// site occasionally needs a signature nobody has seen before. A literal
// frozen in library code means every discovery requires editing and shipping
// code, and means anything learned in one session is lost. Same split already
// used for the failure taxonomy (lib/failureTypes.js) and the generic action
// library (lib/builtinActions.js): code carries the baseline so a clone
// works, the DB carries the baseline plus what has been learned.
//
// where_seen values:
//   title     — regex against document.title
//   body      — regex against body innerText
//   resource  — regex against script/iframe/link URLs
//   dom       — CSS selector; a match also contributes its visible area, which
//               is how "the challenge IS the page" is told from "a widget sits
//               on a working page"
//
// blocking_weight: 2 = this signal alone means the page is walled (a challenge
// title, an explicit refusal). 1 = corroborating only; on its own it may be a
// widget on an otherwise fine page. A reCAPTCHA iframe is the classic 1 —
// jobspresso.co embeds one for its job-posting form while serving content
// perfectly.

const BLOCKER_SIGNATURES = [
  // --- Cloudflare ---------------------------------------------------------
  ['cloudflare', 'title', 'just a moment|attention required|checking your browser', 'i', 2],
  ['cloudflare', 'dom', '#cf-wrapper, #challenge-running, #challenge-form, #cf-please-wait, .cf-browser-verification, #cf-challenge-running', null, 2],
  ['cloudflare', 'resource', '\\/cdn-cgi\\/challenge-platform\\/|challenges\\.cloudflare\\.com', 'i', 2],
  ['cloudflare', 'body', 'ray id|enable javascript and cookies to continue', 'i', 1],
  ['cloudflare', 'body', 'verif(y|ying) you are human|additional verification required', 'i', 2],

  // --- DataDome -----------------------------------------------------------
  ['datadome', 'title', 'verification required', 'i', 2],
  ['datadome', 'dom', '#datadome, [class*="ddm-" i], #dd_captcha', null, 2],
  ['datadome', 'resource', 'captcha-delivery\\.com|datadome', 'i', 2],
  ['datadome', 'body', 'blocked by datadome', 'i', 2],

  // --- PerimeterX / HUMAN -------------------------------------------------
  ['perimeterx_human', 'title', 'pardon our interruption|access to this page has been denied', 'i', 2],
  ['perimeterx_human', 'dom', '#px-captcha, [id^="px-"]', null, 2],
  ['perimeterx_human', 'resource', 'px-cdn|perimeterx|captcha\\.px', 'i', 1],
  ['perimeterx_human', 'body', 'pardon our interruption', 'i', 2],

  // --- Imperva / Incapsula ------------------------------------------------
  ['imperva_incapsula', 'title', 'request unsuccessful|incapsula', 'i', 2],
  ['imperva_incapsula', 'dom', '#distilIdentificationBlock, [id*="incapsula" i]', null, 2],
  ['imperva_incapsula', 'resource', '_incapsula_resource|imperva|distil', 'i', 1],
  ['imperva_incapsula', 'body', 'incident id|powered by imperva', 'i', 1],

  // --- Akamai -------------------------------------------------------------
  ['akamai', 'title', 'access denied', 'i', 2],
  ['akamai', 'resource', 'akam\\/|akamai', 'i', 1],
  ['akamai', 'body', "reference #\\d|you don't have permission to access", 'i', 2],

  // --- Standalone challenge widgets ---------------------------------------
  // Weight 1 throughout: a challenge widget is frequently embedded in a form
  // on a page that works fine.
  ['captcha_widget', 'resource', 'recaptcha|hcaptcha|turnstile|arkoselabs|funcaptcha', 'i', 1],
  ['captcha_widget', 'dom', '.g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey]', null, 1],
  ['captcha_widget', 'body', 'are you a robot|complete the security check', 'i', 2],

  // --- Not anti-bot, but still a wall -------------------------------------
  ['login_wall', 'dom', 'input[type="password"]', null, 1],
  ['login_wall', 'body', 'sign in to continue|log in to continue|please sign in|members only', 'i', 2],
  ['rate_limit', 'body', 'unusual traffic|automated queries|too many requests|rate limit', 'i', 2],
  ['rate_limit', 'title', 'too many requests', 'i', 2],
];

// Services whose presence, when BLOCKING, means the recipe itself may be fine
// and the obstacle is the site. Used to decide whether a failed run is a
// candidate for the attended test rather than for re-derivation.
const WALL_SERVICES = [
  'cloudflare',
  'datadome',
  'perimeterx_human',
  'imperva_incapsula',
  'akamai',
  'captcha_widget',
  'login_wall',
  'rate_limit',
];

module.exports = { BLOCKER_SIGNATURES, WALL_SERVICES };
