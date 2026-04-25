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

const express = require('express');
const compression = require('compression');
const cors = require('cors');
const helmet = require('helmet');
const fileUpload = require('express-fileupload');
const path = require('path');
const { initDb } = require('./db');
const { auth } = require('./middleware/auth');
const { getSignedUrl } = require('./utils/storage');
const { AppError, ExternalServiceError } = require('./utils/errors');
const { processAutopayCharges, processEventCompletions } = require('./utils/balanceScheduler');
const { processScheduledAutoAssigns } = require('./utils/autoAssignScheduler');
const { processSequenceSteps, expireStaleQuoteDrafts } = require('./utils/emailSequenceScheduler');

// Startup guards — fail fast if critical env vars are missing
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error('FATAL: JWT_SECRET must be set and at least 32 characters');
  process.exit(1);
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
// editing this allowlist each time.
const isDev = process.env.NODE_ENV !== 'production';
const isAllowedOrigin = (origin) => {
  if (allowedOrigins.includes(origin)) return true;
  if (isDev && /^https?:\/\/localhost(:\d+)?$/.test(origin)) return true;
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
app.use('/api/payment', require('./routes/payment'));
app.use('/api/application', require('./routes/application'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/shifts', require('./routes/shifts'));
app.use('/api/drink-plans', require('./routes/drinkPlans'));
app.use('/api/cocktails', require('./routes/cocktails'));
app.use('/api/mocktails', require('./routes/mocktails'));
app.use('/api/proposals', require('./routes/proposals'));
app.use('/api/clients', require('./routes/clients'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/stripe', require('./routes/stripe'));
app.use('/api/calendar', require('./routes/calendar'));
app.use('/api/blog', require('./routes/blog'));
app.use('/api/client-auth', require('./routes/clientAuth'));
app.use('/api/client-portal', require('./routes/clientPortal'));
app.use('/api/email-marketing', require('./routes/emailMarketing'));
app.use('/api/email-marketing/webhook', require('./routes/emailMarketingWebhook'));
app.use('/api/public/reviews', require('./routes/publicReviews'));
app.use('/api/thumbtack', require('./routes/thumbtack'));
app.use('/api/invoices', require('./routes/invoices'));
app.use('/api/test-feedback', require('./routes/testFeedback'));

// Health check — must be registered BEFORE the React catch-all below
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Frontend is served separately on Vercel

// Global error handler — must be the last middleware
// eslint-disable-next-line no-unused-vars
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
    app.listen(PORT, () => {
      console.log(`✓ Server running on port ${PORT}`);

      // Schedulers run by default on the single primary instance. Set RUN_SCHEDULERS=false
      // on additional web instances to prevent duplicate Stripe charges / emails / writes.
      if (process.env.RUN_SCHEDULERS !== 'false') {
        // Autopay balance scheduler — check hourly for due balances
        setTimeout(processAutopayCharges, 30000); // initial run after 30s
        setInterval(processAutopayCharges, 60 * 60 * 1000); // then every hour

        // Auto-complete events — check hourly for ended, fully-paid events
        setTimeout(processEventCompletions, 45000); // initial run after 45s
        setInterval(processEventCompletions, 60 * 60 * 1000); // then every hour

        // Auto-assign scheduler — check hourly for shifts needing auto-assignment
        setTimeout(processScheduledAutoAssigns, 60000); // initial run after 60s
        setInterval(processScheduledAutoAssigns, 60 * 60 * 1000); // then every hour

        // Email sequence scheduler — check every 15 min for due drip steps
        setTimeout(processSequenceSteps, 90000); // initial run after 90s
        setInterval(processSequenceSteps, 15 * 60 * 1000); // then every 15 minutes

        // Quote draft cleanup — expire stale drafts daily
        setInterval(expireStaleQuoteDrafts, 24 * 60 * 60 * 1000);
        setTimeout(expireStaleQuoteDrafts, 120000); // initial run after 2 min

        console.log('[schedulers] started');
      } else {
        console.log('[schedulers] disabled via RUN_SCHEDULERS=false');
      }
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
