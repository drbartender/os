const rateLimit = require('express-rate-limit');

const publicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const publicReadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const signLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: { error: 'Too many signing attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Drink-plan PUTs autosave every 30 seconds, so a normal client racks up ~30
// requests per 15-minute window. publicLimiter (max=20) was rate-limiting
// real workflows. Key by token so one client can't drown another's budget.
const drinkPlanWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 80,
  keyGenerator: (req) => req.params?.token || req.ip,
  message: { error: 'Too many save attempts. Please try again in a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// The proposal "other options" comparison re-quotes on every extras toggle and
// every BYOB tier change, so a browsing client legitimately spends dozens of
// requests. It CANNOT share publicReadLimiter: that bucket is IP-keyed and is
// the same one the proposal page load and the Stripe publishable-key fetch draw
// on, so a curious client browsing combinations could exhaust it and then be
// told their proposal "was not found or has expired" on the next reload, with
// the payment form refusing to mount for the rest of the window. Browsing must
// never be able to spend the budget that paying depends on. Keyed by token,
// same reasoning as drinkPlanWriteLimiter above. Read-only and cheap server-side
// (three queries, then pure pricing), so the cap is generous.
const optionsQuoteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  keyGenerator: (req) => req.params?.token || req.ip,
  message: { error: 'Too many pricing requests. Please try again in a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// The switch WRITES the proposal (package, total, snapshot). Same token key as
// optionsQuoteLimiter so browsing can never spend this budget, but a write
// endpoint gets a tight cap: a real client switches a handful of times in a
// sitting, not 120.
const switchLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => req.params?.token || req.ip,
  message: { error: 'Too many changes at once. Please try again in a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// The proposal checkout (spec 2026-08-28 §3c). GET /t/:token, its /resolve,
// and POST /stripe/create-intent/:token all drew on publicLimiter, 20 per 15
// minutes PER IP: a page load spends three, every option/autopay/gratuity
// change spends one, a failed sign's recovery spends two. One real client
// retrying a blocked checkout (2026-08-28, proposal 774) spent about eighteen.
// Keyed by token, same law as optionsQuoteLimiter: browsing must never be able
// to spend the budget that paying depends on.
const proposalCheckoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  keyGenerator: (req) => req.params?.token || req.ip,
  message: { error: 'Too many requests. Please try again in a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// The post-checkout settle poll: thirteen reads at 1.5s while the webhook
// commits. Its own bucket so a settle can never spend the checkout's budget.
const proposalPollLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  keyGenerator: (req) => req.params?.token || req.ip,
  message: { error: 'Too many requests. Please try again in a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// IP ceiling for the token-keyed public money routes. The token keying above
// is deliberate and stays (browsing must never spend the budget paying depends
// on), but it means the KEY is client-supplied: a valid-format random UUID
// passes the requireUuidToken gate, mints its own fresh bucket, and costs a
// pool connection plus a FOR UPDATE round trip before it 404s. Token-keying
// alone therefore gives the public WRITE route a weaker per-IP ceiling than the
// public READ route beside it. This is a SECOND limiter chained in front, not a
// replacement, and it is deliberately generous: no real client, however many
// devices are on the proposal, comes near it, so a 429 here means spray.
const publicTokenIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: { error: 'Too many requests. Please try again in a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Logo upload/proxy is keyed by token AND much tighter than the autosave
// limiter — each POST writes up to 5 MB to R2 (paid storage), each GET
// proxies bytes through Node from R2 (paid egress). The previous shared
// publicReadLimiter (100/15min) let a single token burn ~500 MB of R2
// traffic per window; this cap keeps cost predictable while staying generous
// for legitimate "upload, preview, replace once, preview again" flows.
const logoUploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  keyGenerator: (req) => req.params?.token || req.ip,
  message: { error: 'Too many logo requests. Please try again in a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Client-portal writes (change-request calculate / create / cancel) are keyed by
// the authenticated client id so one client cannot exhaust another's budget.
const clientPortalWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req) => (req.user && req.user.id ? `cp-${req.user.id}` : req.ip),
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Admin proposal writes (POST /proposals, PATCH /:id/status) can fire client
// emails — every →sent transition emails the client. Keyed by user id, not IP,
// so an office NAT doesn't share a bucket. 10/min is still far above any human
// admin workflow (a person creating proposals one at a time never approaches
// it) while meaningfully capping the email-spam blast radius of a compromised
// admin token.
const adminWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req) => (req.user && req.user.id ? `admin-${req.user.id}` : req.ip),
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Global search (GET /api/admin/search) fires once per debounced keystroke in
// the command palette — the budget must be generous — but each call runs
// several cross-table LIKE scans, so a held key or scripted client shouldn't
// hammer it. 60/min keyed by user id covers real typing comfortably.
const adminSearchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: (req) => (req.user && req.user.id ? `search-${req.user.id}` : req.ip),
  message: { error: 'Too many searches. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Venue-name search proxy (Google Places). Unauthenticated: the quote wizard
// is public. A real search debounces to a handful of autocomplete calls plus
// one details call; 60/min per IP is generous for that and curbs scripted
// abuse of the (paid) Google quota.
const venueSearchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many venue searches. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Global ceiling across all IPs, so an IP-rotating attacker still hits a cap
// on the paid Google quota (same shared-bucket keyGenerator pattern). Sized for
// whole-site quote volume, not a single user; raise if real traffic nears it.
const venueSearchGlobalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  keyGenerator: () => 'venue-search-global',
  message: { error: 'Venue search is busy. Please try again shortly.' },
  standardHeaders: false,
  legacyHeaders: false,
});

// Cal.com webhook. The only legitimate caller is Cal.com itself, and even on a
// busy event day the burst stays well under this cap. Cost-per-invalid-request
// is an HMAC compute plus a Sentry warn, so the cap exists to bound that cost
// under flood. Skip in test env so the test suite does not trip the limit
// when many signed requests are dispatched in quick succession.
const calcomWebhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  message: { error: 'Too many webhook requests.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
});

// User-keyed limiter for the BEO read + acknowledge endpoints. Bartenders on a
// shared venue wifi / office NAT / CGNAT must not share a bucket, so this
// keys per req.user.id. 60 requests / 15 minutes is generous for a staffer
// refreshing while standing in a parking lot.
const beoReadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  keyGenerator: (req) => `beo-${req.user?.id || req.ip}`,
  standardHeaders: true,
  legacyHeaders: false,
});

// Email-change request limiter (spec §6.10). 3 pending requests per user per
// 24 hours. Prevents weaponized verification-email floods to a victim's inbox.
// Keyed per req.user.id (the auth middleware runs first so req.user is set);
// IP fallback covers the unauthenticated edge in dev tests.
// Skipped in NODE_ENV=test (matches calcomWebhookLimiter) so suite cases that
// fire many requests against one fixture user don't trip the bucket; the
// limiter itself is unit-tested by exercising the keyGenerator path elsewhere.
const emailChangeRequestLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 3,
  keyGenerator: (req) => `email-change-${req.user?.id || req.ip}`,
  message: { error: 'Too many email-change requests. Please try again tomorrow.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
});

// Email-change CONFIRM limiter (UNAUTHENTICATED — POST /api/me/confirm-email-change).
// The token is 256-bit so brute force is infeasible; this caps per-IP request
// volume so the endpoint can't be used as a cheap resource-exhaustion or
// enumeration surface. Keyed by IP (no authenticated user on this route).
const emailChangeConfirmLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  message: { error: 'Too many confirmation attempts. Please try again later.' },
});

// Staff service-extension requests (POST /api/service-extensions). Each accepted
// request fires a real client SMS + email and mints a payable invoice, so the
// budget is tight: 5 per hour is far above any legitimate on-site workflow (one
// event yields at most a couple of attempts). Keyed by the authenticated user
// id, not IP, because several staffers at one venue share the venue wifi / NAT;
// the limiter is attached AFTER `auth` on the route so req.user is set.
// Skipped in NODE_ENV=test (matches calcomWebhookLimiter) so the suite's several
// POSTs against one fixture user don't trip the bucket.
const serviceExtensionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => String(req.user?.id || req.ip),
  message: { error: 'Too many extension requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
});

// WebAuthn unlock + enrollment (mobile-admin spec 2026-08-13 section 8).
// Deliberately separate from the login authLimiter in routes/auth.js so
// biometric unlock retries neither ride nor exhaust the password-login
// lockout budget. IP-keyed because assert-options/assert-verify run
// unauthenticated (the phone is locked when they fire). Skipped under
// NODE_ENV=test (matches calcomWebhookLimiter) so the webauthn suite's many
// requests from one address do not trip the bucket.
const webauthnLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Too many unlock attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
});

module.exports = {
  publicLimiter,
  publicReadLimiter,
  signLimiter,
  drinkPlanWriteLimiter,
  optionsQuoteLimiter,
  switchLimiter,
  proposalCheckoutLimiter,
  proposalPollLimiter,
  publicTokenIpLimiter,
  logoUploadLimiter,
  clientPortalWriteLimiter,
  adminWriteLimiter,
  adminSearchLimiter,
  venueSearchLimiter,
  venueSearchGlobalLimiter,
  calcomWebhookLimiter,
  beoReadLimiter,
  emailChangeRequestLimiter,
  emailChangeConfirmLimiter,
  serviceExtensionLimiter,
  webauthnLimiter,
};
