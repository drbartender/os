require('dotenv').config();
const Sentry = require('@sentry/node');

if (process.env.SENTRY_DSN_SERVER) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN_SERVER,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: 0.1,
    beforeSend(event) {
      // Redact request body (passwords, tokens, PII)
      if (event.request?.data) event.request.data = '[redacted]';

      // Redact public token segments and query-string tokens from URLs
      const scrubUrl = (u) => {
        if (!u) return u;
        return String(u)
          .replace(/\/t\/[^/?#]+/g, '/t/[redacted]')
          .replace(/\/api\/public\/tip\/[^/?#]+/g, '/api/public/tip/[redacted]')
          .replace(/\/tip\/[^/?#]+/g, '/tip/[redacted]')
          .replace(/\/unsubscribe\/[^/?#]+/g, '/unsubscribe/[redacted]')
          .replace(/\/reset-password\/[^/?#]+/g, '/reset-password/[redacted]')
          .replace(/[?&]token=[^&]+/g, (m) => m[0] + 'token=[redacted]');
      };
      if (event.request?.url) event.request.url = scrubUrl(event.request.url);
      if (event.request?.query_string) {
        event.request.query_string = String(event.request.query_string).replace(/token=[^&]+/g, 'token=[redacted]');
      }

      // Drop request headers entirely — default scrub list misses x-thumbtack-secret etc.
      if (event.request) delete event.request.headers;

      // Scrub the route tag we set in the global error handler too
      if (event.tags?.route) event.tags.route = scrubUrl(event.tags.route);

      return event;
    },
  });
  console.log('Sentry server SDK initialized');
}

// Process-level safety net. A floating promise rejection used to take the whole
// process down (Node's default for unhandledRejection is to crash); here we
// convert it into a Sentry alert + log and KEEP the process alive so one stray
// rejection can't drop every in-flight request. uncaughtException leaves process
// state undefined, so we capture + log and still exit(1) (Node crashes anyway —
// we only add observability before it goes).
process.on('unhandledRejection', (reason) => {
  if (process.env.SENTRY_DSN_SERVER) {
    Sentry.captureException(reason, { tags: { kind: 'unhandledRejection' } });
  }
  console.error('Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  if (process.env.SENTRY_DSN_SERVER) {
    Sentry.captureException(err, { tags: { kind: 'uncaughtException' } });
  }
  console.error('Uncaught exception:', err);
  process.exit(1);
});

const express = require('express');
const compression = require('compression');
const cors = require('cors');
const helmet = require('helmet');
const fileUpload = require('express-fileupload');
const path = require('path');
const { initDb, pool } = require('./db');
const { auth } = require('./middleware/auth');
const { getSignedUrl } = require('./utils/storage');
const { AppError, ExternalServiceError } = require('./utils/errors');
const { processAutopayCharges, processEventCompletions } = require('./utils/balanceScheduler');
const { processScheduledAutoAssigns } = require('./utils/autoAssignScheduler');
const { processSequenceSteps, expireStaleQuoteDrafts } = require('./utils/emailSequenceScheduler');
const { dispatchPending } = require('./utils/scheduledMessageDispatcher');

// Startup guards — fail fast if critical env vars are missing
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error('FATAL: JWT_SECRET must be set and at least 32 characters');
  process.exit(1);
}

// Production-only required-env assertion. These integrations have no safe
// degraded mode in prod — a missing one is a silent-failure trap (DB never
// connects, no email/SMS goes out, every file upload 500s). Fail fast at boot
// with the full list instead of surfacing hours later as scattered runtime
// errors. Dev is exempt (local work runs without Twilio/R2/etc). Optional
// integrations (Cal.com, Telegram, VAPID, Places) warn or fail closed on their
// own and are intentionally excluded. R2_* names are exactly what
// server/utils/storage.js reads.
if (process.env.NODE_ENV === 'production') {
  const requiredEnv = [
    'DATABASE_URL',
    'RESEND_API_KEY',
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_PHONE_NUMBER',
    'R2_ACCOUNT_ID',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'R2_BUCKET_NAME',
  ];
  const missing = requiredEnv.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    console.error(`FATAL: missing required env vars in production: ${missing.join(', ')}`);
    process.exit(1);
  }
}

// Cal.com webhook secret presence check. Emits a one-shot warning so the
// missed-config alarm fires even when no Cal.com traffic hits the endpoint.
if (!process.env.CAL_WEBHOOK_SECRET) {
  const msg = 'CAL_WEBHOOK_SECRET is not set; Cal.com webhook will return 503 on every request';
  console.warn(`[startup] ${msg}`);
  try {
    const Sentry = require('@sentry/node');
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureMessage(msg, { level: 'warning', tags: { component: 'startup', subsystem: 'calcom' } });
    }
  } catch (_) { /* sentry optional in dev */ }
}

// Thumbtack email-harvester agent secret presence check. The agent routes fail
// closed (401) in every environment when this is unset; warn at startup so the
// missed config is visible even before any agent traffic arrives.
if (!process.env.THUMBTACK_AGENT_SECRET) {
  const msg = 'THUMBTACK_AGENT_SECRET is not set; Thumbtack email-harvester agent routes will reject every request (fail closed)';
  console.warn(`[startup] ${msg}`);
  try {
    const Sentry = require('@sentry/node');
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureMessage(msg, { level: 'warning', tags: { component: 'startup', subsystem: 'thumbtack-harvester' } });
    }
  } catch (_) { /* sentry optional in dev */ }
}

const app = express();
app.set('trust proxy', 1); // Required for Render/Heroku reverse proxies (rate limiter, IP detection)
const PORT = process.env.PORT || 5000;

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://js.stripe.com"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https://*.r2.cloudflarestorage.com", "https://i.imgur.com", "https://*.public.blob.vercel-storage.com"],
      connectSrc: ["'self'", "https://api.stripe.com", "https://nominatim.openstreetmap.org"],
      frameSrc: ["https://js.stripe.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// Gzip compression for all responses
app.use(compression());

// Middleware — allow requests from public site, admin, hiring, and staff subdomains
const allowedOrigins = [
  process.env.CLIENT_URL || 'http://localhost:3000',
  'https://drbartender.com',
  'https://www.drbartender.com',
  'https://admin.drbartender.com',
  'https://hiring.drbartender.com',
  'https://staff.drbartender.com',
].filter(Boolean);

// In development, allow any http://localhost:<port> so the dev server can run
// on alternate ports (e.g. 3010 when 3000 is taken by another project) without
// editing this allowlist each time. Gate is an explicit positive match — a typo'd
// NODE_ENV (e.g. 'staging', 'prod', or unset) closes the localhost door instead
// of opening it. Restricted to http only — CRA/Vite dev servers don't serve https.
// Strictly 'development'. NODE_ENV='test' or unset would otherwise open the
// localhost door on a misconfigured Render deploy.
const isDev = process.env.NODE_ENV === 'development';
const isAllowedOrigin = (origin) => {
  if (allowedOrigins.includes(origin)) return true;
  if (isDev && /^http:\/\/(?:[a-z0-9-]+\.)?localhost(:\d+)?$/.test(origin)) return true;
  return false;
};

// CORS: browsers send an Origin header; we enforce an allowlist for those.
// Server-to-server callers (Stripe/Resend/Thumbtack webhooks, Render's health probe,
// uptime pingers) send no Origin header — they authenticate via their own signature/secret,
// not CORS — so we pass those through with no Access-Control-Allow-Origin header.
app.use(cors((req, callback) => {
  if (!req.headers.origin) {
    return callback(null, { origin: false, credentials: false });
  }
  callback(null, {
    origin: (origin, cb) => {
      if (isAllowedOrigin(origin)) return cb(null, true);
      cb(new Error('Not allowed by CORS'));
    },
    credentials: true,
  });
}));

// Stripe webhook needs raw body — must be registered BEFORE express.json()
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));

// Resend webhook needs raw body for svix signature verification — also BEFORE express.json()
app.use('/api/email-marketing/webhook/resend', express.raw({ type: 'application/json' }));

// Cal.com webhook needs raw body for HMAC-SHA256 signature verification, also BEFORE express.json()
app.use('/api/calcom/webhook', express.raw({ type: 'application/json', limit: '256kb' }));

// Blog admin can post TipTap-inlined images that approach 10MB; scope the big
// limit to the blog route only. Everything else uses the 1MB default.
app.use('/api/blog', express.json({ limit: '10mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(fileUpload({
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE) || 10 * 1024 * 1024 },
  abortOnLimit: true,
  useTempFiles: false
}));

// Protected file access — admin and managers only. Returns a short-lived signed
// R2 URL in JSON rather than 302-redirecting, because a cross-origin XHR that
// follows a redirect to R2 trips CORS (R2 has no CORS headers for our origin)
// and surfaces as "Network error" in the client. The client opens the returned
// URL in a new tab (see AdminApplicationDetail / AdminUserDetail).
app.get('/api/files/:filename', auth, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') {
    return res.status(403).json({ error: 'Access denied' });
  }
  // path.basename strips any directory traversal attempts (e.g. "../../etc/passwd")
  const filename = path.basename(req.params.filename);
  try {
    const url = await getSignedUrl(filename);
    res.json({ url });
  } catch (err) {
    console.error('File access error:', err);
    res.status(404).json({ error: 'File not found' });
  }
});

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/progress', require('./routes/progress'));
app.use('/api/agreement', require('./routes/agreement'));
app.use('/api/contractor', require('./routes/contractor'));
// Email-change confirm — UNAUTHENTICATED by design (spec section 6.10:
// possession of the email-link token proves intent, not the JWT). Mounted
// BEFORE me.js so the inner `router.use(auth)` on me.js never fires for
// `/confirm-email-change`. emailChange.js has no other routes, so any other
// /api/me/* path falls through to me.js / staffPortal.js as usual.
app.use('/api/me', require('./routes/emailChange'));
app.use('/api/me', require('./routes/me'));
// Staff portal redesign endpoints — mounted AFTER me.js so any future path
// collision lets me.js win. Today's me.js owns /tip-page, /tips,
// /notification-preferences; this router owns the rest.
app.use('/api/me', require('./routes/staffPortal'));
app.use('/api/payment', require('./routes/payment'));
app.use('/api/application', require('./routes/application'));
// Thumbtack email-harvester agent API (spec 2026-06-16). Mounted BEFORE the
// general /api/admin router so the agent-secret paths match here first and never
// hit the admin router's JWT auth (the agent presents no JWT).
app.use('/api/admin/thumbtack', require('./routes/thumbtackAgent'));
app.use('/api/admin/packages', require('./routes/packages'));
app.use('/api/admin', require('./routes/admin'));
// Admin one-click cover-swap routes (spec section 6.5). Lives at /api/admin
// so the routing-table audit lines up with the other admin surfaces. JWT
// swap-token + auth + admin-role guard is inside the router.
app.use('/api/admin', require('./routes/adminCoverSwaps'));
app.use('/api/shifts', require('./routes/shifts'));
// Staff portal Drop / Cover marketplace endpoints (spec §6.5). Mounted AFTER
// routes/shifts.js so the existing shifts.js routes have first-match priority
// (Express matches by route specificity, but both routers share the
// /api/shifts prefix and the same path segments need predictable ordering).
// The new endpoints (/requests/:id/drop, /request-cover, /claim-cover,
// /emergency-drop) are unique paths not already in shifts.js, so they fall
// through to this router. Task 27's staff-facing DELETE wins by being added
// to the existing shifts.js handler instead (role-aware: staff = pending-only
// gate, admin = unrestricted) — no path collision here.
app.use('/api/shifts', require('./routes/staffShiftActions'));
// Regenerate mounts BEFORE the flat drink-plans router: its single specific
// POST (/:id/shopping-list/regenerate) has no method+path overlap there, and
// unmatched requests fall through (potions plan, lane C).
app.use('/api/drink-plans', require('./routes/drinkPlans/regenerate'));
app.use('/api/drink-plans', require('./routes/drinkPlans'));
app.use('/api/drink-plans', require('./routes/drinkPlanConsult'));
app.use('/api/comms', require('./routes/comms'));
app.use('/api/beo', require('./routes/beo'));
app.use('/api/cocktails', require('./routes/cocktails'));
app.use('/api/mocktails', require('./routes/mocktails'));
app.use('/api/potions', require('./routes/potions'));
app.use('/api/proposals', require('./routes/proposals'));
app.use('/api/clients', require('./routes/clients'));
app.use('/api/venues', require('./routes/venues'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/stripe', require('./routes/stripe'));
app.use('/api/stripe-payouts', require('./routes/stripePayouts'));
app.use('/api/calendar', require('./routes/calendar'));
app.use('/api/blog', require('./routes/blog'));
app.use('/api/calcom', require('./routes/calcom'));
app.use('/api/client-auth', require('./routes/clientAuth'));
app.use('/api/client-portal', require('./routes/clientPortal'));
app.use('/api/email-marketing', require('./routes/emailMarketing'));
app.use('/api/email-marketing/webhook', require('./routes/emailMarketingWebhook'));
app.use('/api/public/reviews', require('./routes/publicReviews'));
app.use('/api/public/tip', require('./routes/publicTip'));
app.use('/api/public/feedback', require('./routes/publicFeedback'));
app.use('/api/thumbtack', require('./routes/thumbtack'));
app.use('/api/sms', require('./routes/sms'));
app.use('/api/telegram', require('./routes/telegram'));
app.use('/api/voice/lead', require('./routes/voiceLeadCall')); // more specific mount first
app.use('/api/voice', require('./routes/voice'));
app.use('/api/invoices', require('./routes/invoices'));

// Health check — must be registered BEFORE the React catch-all below.
// Probes the DB (Render's health probe + uptime pingers hit this): a SELECT 1
// raced against a ~2s timeout. DB reachable -> 200 {status:'ok'}; a DB error or
// a probe that outlives the timeout -> 503 {status:'degraded'} so the platform
// can pull an instance whose DB link has gone dark.
app.get('/api/health', async (req, res) => {
  try {
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('health timeout')), 2000)),
    ]);
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(503).json({ status: 'degraded' });
  }
});

// Frontend is served separately on Vercel

// Global error handler — must be the last middleware
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err instanceof AppError) {
    // External-service failures (Stripe / R2 / Twilio / Resend / Nominatim) MUST land in Sentry
    // so we hear about provider outages without waiting for user reports. Other AppError
    // subclasses are user-facing validation/auth/conflict errors — not Sentry-worthy.
    if (err instanceof ExternalServiceError && process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(err.originalError || err, {
        tags: {
          service: err.service,
          route: req.originalUrl,
          method: req.method,
          code: err.code,
        },
        user: req.user ? { id: req.user.id, role: req.user.role } : undefined,
      });
    }
    const body = { error: err.message, code: err.code };
    if (err.fieldErrors) body.fieldErrors = err.fieldErrors;
    return res.status(err.statusCode).json(body);
  }

  // Unknown error — Sentry + log + generic 500
  if (process.env.SENTRY_DSN_SERVER) {
    Sentry.captureException(err, {
      user: req.user ? { id: req.user.id, role: req.user.role } : undefined,
      tags: { route: req.originalUrl, method: req.method },
    });
  }
  console.error('Unhandled error:', err);

  res.status(500).json({
    error: 'An unexpected error occurred. Please try again.',
    code: 'INTERNAL_ERROR',
  });
});

async function start() {
  try {
    await initDb();
    const server = app.listen(PORT, () => {
      console.log(`✓ Server running on port ${PORT}`);

      // Schedulers fire only when NODE_ENV=production. They send real emails
      // (Resend) and SMS (Twilio) against the shared Neon DB; if a dev server
      // also runs them, it iterates the same scheduled_messages rows as prod
      // and burns through provider allotments. Local opt-in: RUN_SCHEDULERS=true
      // (e.g. testing one handler against a scratch row). Multi-instance prod:
      // RUN_SCHEDULERS=false on a secondary web instance to prevent duplicate
      // runs (single-instance prod keeps the default).
      const isProd = process.env.NODE_ENV === 'production';
      const globalScheduleDisabled =
        process.env.RUN_SCHEDULERS === 'false' ||
        (!isProd && process.env.RUN_SCHEDULERS !== 'true');
      function enabled(envVar) {
        if (globalScheduleDisabled) return false;
        return process.env[envVar] !== 'false';
      }

      const {
        wrapScheduler,
        startStaleSchedulerMonitor,
        clearHealthRow,
      } = require('./utils/schedulerHealth');

      // Autopay balance scheduler — check hourly for due balances
      if (enabled('RUN_AUTOPAY_SCHEDULER')) {
        const wrapped = wrapScheduler('autopay', 3600, processAutopayCharges);
        setTimeout(wrapped, 30000);
        setInterval(wrapped, 60 * 60 * 1000);
      } else if (!globalScheduleDisabled) {
        clearHealthRow('autopay'); // disabled via per-scheduler flag; clear stale-monitor row
      }

      // Auto-complete events — check hourly for ended, fully-paid events
      if (enabled('RUN_AUTOCOMPLETE_SCHEDULER')) {
        const wrapped = wrapScheduler('autocomplete', 3600, processEventCompletions);
        setTimeout(wrapped, 45000);
        setInterval(wrapped, 60 * 60 * 1000);
      } else if (!globalScheduleDisabled) {
        clearHealthRow('autocomplete');
      }

      // Auto-assign scheduler — check hourly for shifts needing auto-assignment
      if (enabled('RUN_AUTO_ASSIGN_SCHEDULER')) {
        const wrapped = wrapScheduler('auto_assign', 3600, processScheduledAutoAssigns);
        setTimeout(wrapped, 60000);
        setInterval(wrapped, 60 * 60 * 1000);
      } else if (!globalScheduleDisabled) {
        clearHealthRow('auto_assign');
      }

      // Email sequence scheduler — check every 15 min for due drip steps
      if (enabled('RUN_SEQUENCE_SCHEDULER')) {
        const wrapped = wrapScheduler('email_sequence', 900, processSequenceSteps);
        setTimeout(wrapped, 90000);
        setInterval(wrapped, 15 * 60 * 1000);
      } else if (!globalScheduleDisabled) {
        clearHealthRow('email_sequence');
      }

      // Quote draft cleanup — expire stale drafts daily
      if (enabled('RUN_QUOTE_DRAFT_CLEANUP_SCHEDULER')) {
        const wrapped = wrapScheduler('quote_draft_cleanup', 86400, expireStaleQuoteDrafts);
        setTimeout(wrapped, 120000);
        setInterval(wrapped, 24 * 60 * 60 * 1000);
      } else if (!globalScheduleDisabled) {
        clearHealthRow('quote_draft_cleanup');
      }

      // Webhook events prune — drop webhook_events rows older than 30 days
      if (enabled('RUN_WEBHOOK_EVENTS_PRUNE_SCHEDULER')) {
        const { pruneOldWebhookEvents } = require('./utils/webhookEventsPruneScheduler');
        const wrapped = wrapScheduler('webhook_events_prune', 3600, async () => {
          const n = await pruneOldWebhookEvents();
          if (n > 0) console.log(`[webhook_events_prune] deleted ${n} expired rows`);
        });
        setTimeout(wrapped, 30000);
        setInterval(wrapped, 60 * 60 * 1000);
      } else if (!globalScheduleDisabled) {
        clearHealthRow('webhook_events_prune');
      }

      // Pending-email-change cleanup — daily purge of consumed + long-expired rows
      // (spec §6.10 step 10).
      if (enabled('RUN_PENDING_EMAIL_CLEANUP_SCHEDULER')) {
        const { purgeExpiredPendingEmailChanges } = require('./utils/pendingEmailChangeCleanup');
        const wrapped = wrapScheduler('pending_email_cleanup', 86400, purgeExpiredPendingEmailChanges);
        setTimeout(wrapped, 200000);
        setInterval(wrapped, 24 * 60 * 60 * 1000);
      } else if (!globalScheduleDisabled) {
        clearHealthRow('pending_email_cleanup');
      }

      // Stripe payout sweep — daily mirror heal (webhook misses, pending bucket, re-match)
      if (enabled('RUN_STRIPE_PAYOUT_SWEEP_SCHEDULER')) {
        const { sweep } = require('./utils/stripePayoutSync');
        const wrapped = wrapScheduler('stripe_payout_sweep', 86400, sweep);
        setTimeout(wrapped, 240000);
        setInterval(wrapped, 24 * 60 * 60 * 1000);
      } else if (!globalScheduleDisabled) {
        clearHealthRow('stripe_payout_sweep');
      }

      // Refund pending sweep — 15-min heal of stranded 'pending' proposal_refunds
      // rows (adopt via Stripe refunds.list, else mark failed after a 30-min age gate) — B6
      if (enabled('RUN_REFUND_PENDING_SWEEP_SCHEDULER')) {
        const { sweepStalePendingRefunds } = require('./utils/refundSweepScheduler');
        const wrapped = wrapScheduler('refund_pending_sweep', 900, sweepStalePendingRefunds);
        setTimeout(wrapped, 180000);
        setInterval(wrapped, 15 * 60 * 1000);
      } else if (!globalScheduleDisabled) {
        clearHealthRow('refund_pending_sweep');
      }

      // VA calling maintenance (spec §Components-7 + §Security-9): hourly prune
      // of expired pending_call + aged-out call_audit/telegram_update rows, plus
      // a ~6h Telegram webhook heartbeat (re-arms a silently-disabled webhook so
      // outbound calling is never dead-until-noticed).
      if (enabled('RUN_VA_CALLING_SCHEDULER')) {
        const {
          pruneVaCallingRows,
          checkTelegramWebhookHealth,
        } = require('./utils/vaCallingScheduler');

        const wrappedPrune = wrapScheduler('va_calling_prune', 3600, async () => {
          const n = await pruneVaCallingRows();
          if (n > 0) console.log(`[va_calling_prune] deleted ${n} expired/old rows`);
        });
        setTimeout(wrappedPrune, 210000); // stagger off the other prune jobs
        setInterval(wrappedPrune, 60 * 60 * 1000);

        const wrappedHealth = wrapScheduler(
          'va_calling_webhook_health',
          21600, // 6h expected interval
          checkTelegramWebhookHealth
        );
        setTimeout(wrappedHealth, 240000);
        setInterval(wrappedHealth, 6 * 60 * 60 * 1000);
      } else if (!globalScheduleDisabled) {
        clearHealthRow('va_calling_prune');
        clearHealthRow('va_calling_webhook_health');
      }

      // Presence tracker: stale-desk nudge + auto-flip sweep (spec 2026-07-02).
      if (enabled('RUN_PRESENCE_SCHEDULER')) {
        const { sweepPresence } = require('./utils/presenceScheduler');
        const wrapped = wrapScheduler('presence', 900, sweepPresence);
        setTimeout(wrapped, 270000); // stagger off the other jobs
        setInterval(wrapped, 15 * 60 * 1000);
      } else if (!globalScheduleDisabled) {
        clearHealthRow('presence');
      }

      // Pre-event reminder handlers (event_week_reminder, long_lead_t30_recap).
      // Must register before the dispatcher's first tick so it can resolve them.
      require('./utils/preEventHandlers').registerAll();

      // Plan 2d: register the marketing/retention dispatcher handlers (drip,
      // new_year_hello, six_months_out, retention_nudge, review_request).
      // Synchronous, like registerAll() above; must run before the dispatcher's
      // first tick so it can resolve these message types.
      require('./utils/marketingHandlers').registerMarketingHandlers();

      // Comms Phase 3: client-facing scheduled SMS handlers.
      require('./utils/dripSmsHandlers').registerDripSmsHandlers();
      require('./utils/drinkPlanNudge').registerDrinkPlanNudgeHandlers();
      require('./utils/balanceSmsHandlers').registerBalanceSmsHandlers();
      require('./utils/eventEveSms').registerEventEveHandler();

      // Phase 4a: register the staff-shift SMS handlers (shift_reminder,
      // staff_thank_you). Synchronous; must run before the dispatcher's first
      // tick so it can resolve these staff message types.
      require('./utils/staffShiftHandlers').registerStaffShiftHandlers();

      // cc-import: post-event wrap-up email handler (admin-triggered bulk send
      // for imported Check Cherry events). Synchronous; must run before the
      // dispatcher's first tick so it can resolve post_event_wrap_up_email rows.
      require('./utils/ccWrapUpHandler').registerCcWrapUpHandler();

      // BEO unack nudge handler. Fires the staffBeoNudgeSms reminder ~3 days
      // before each unacked event for every approved staffer. Synchronous;
      // must run before the dispatcher's first tick.
      require('./utils/beoHandlers').registerBeoHandlers();

      // Enhancement Lab follow-up handler (planner v2): the +36h post-submit
      // nudge scheduled by drink-plan submit. Synchronous; must run before the
      // dispatcher's first tick so it can resolve lab_followup rows.
      require('./utils/labFollowupHandler').registerLabFollowupHandler();

      // Scheduled-messages dispatcher — every 5 min, picks up pending rows
      if (enabled('RUN_MESSAGE_DISPATCHER_SCHEDULER')) {
        const wrapped = wrapScheduler('message_dispatcher', 300, dispatchPending);
        setTimeout(wrapped, 180000); // initial fire 3 min after boot — stagger from other schedulers
        setInterval(wrapped, 5 * 60 * 1000);
      } else if (!globalScheduleDisabled) {
        clearHealthRow('message_dispatcher');
      }

      // Start the staleness monitor (runs every 15 min, no per-scheduler toggle)
      if (!globalScheduleDisabled) {
        startStaleSchedulerMonitor();
        console.log('[schedulers] started with per-scheduler controls');
      } else if (process.env.RUN_SCHEDULERS === 'false') {
        console.log('[schedulers] disabled via RUN_SCHEDULERS=false');
      } else {
        console.log(
          `[schedulers] disabled: NODE_ENV='${process.env.NODE_ENV || ''}' is not 'production'. ` +
          `Set RUN_SCHEDULERS=true to fire them locally.`
        );
      }
    });

    // Graceful shutdown. Render sends SIGTERM on deploy/scale-down, then hard-
    // kills after a grace window. Stop accepting new connections, let in-flight
    // requests drain (server.close), close the pool, then exit clean. The unref'd
    // hard-timeout is the backstop: a wedged request can't outlive Render's kill
    // window and strand the shutdown.
    process.on('SIGTERM', () => {
      console.log('SIGTERM received — draining connections and shutting down');
      const hardExit = setTimeout(() => {
        console.error('Graceful shutdown timed out — forcing exit');
        process.exit(1);
      }, 15000);
      hardExit.unref();
      server.close(async () => {
        try {
          await pool.end();
        } catch (err) {
          console.error('Error closing pool during shutdown:', err);
        }
        process.exit(0);
      });
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
