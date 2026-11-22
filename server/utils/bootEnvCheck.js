// Boot env checks: refuses a Render boot whose NODE_ENV is not production or a production boot missing a required var, and lists the webhook and crypto secrets missing in production.
//
// Most security gates in this app open on any NODE_ENV other than exactly
// 'production' (the CORS localhost door, the encryption fail-closed, the
// Stripe test-mode fallbacks), so a Render deploy with NODE_ENV unset or
// mistyped would quietly run with them open. Render sets RENDER and
// RENDER_EXTERNAL_URL on every service, so either one marks a deployed box.
// The dev box and the gate worktree set neither and are untouched.
//
// The boot secrets below each fail closed on their own path (a webhook answers
// 4xx or 503, encryption refuses), so a missing one is reported, never fatal;
// the required list further down is fatal.
// Pure functions over an env object, so tests call them without booting.

// Production-only required env. These integrations have no safe degraded mode
// in prod: a missing one is a silent-failure trap (DB never connects, no
// email/SMS goes out, every file upload 500s), so the boot fails fast with the
// full list instead of surfacing hours later as scattered runtime errors. Dev
// is exempt (local work runs without Twilio/R2/etc). Optional integrations
// (Cal.com, Telegram, VAPID, Places) warn or fail closed on their own and are
// intentionally excluded. R2_* names are exactly what server/utils/storage.js
// reads. Moved here from server/index.js unchanged (2026-11-21).
const REQUIRED_PROD_ENV = [
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

const BOOT_SECRETS = [
  'STRIPE_WEBHOOK_SECRET',
  'RESEND_WEBHOOK_SECRET',
  'THUMBTACK_WEBHOOK_SECRET',
  'CAL_WEBHOOK_SECRET',
  'ENCRYPTION_KEY',
  'STRIPE_SECRET_KEY',
];

function onRender(env) {
  return Boolean(env.RENDER || env.RENDER_EXTERNAL_URL);
}

/** The FATAL message when this boot must refuse, else null. */
function renderEnvRefusal(env) {
  if (!onRender(env) || env.NODE_ENV === 'production') return null;
  const shown = env.NODE_ENV === undefined ? 'unset' : `"${env.NODE_ENV}"`;
  return `running on Render with NODE_ENV ${shown}; set NODE_ENV=production in the Render environment`;
}

/** The names in REQUIRED_PROD_ENV that are unset or empty. The caller gates on production and exits. */
function missingRequiredEnv(env) {
  return REQUIRED_PROD_ENV.filter((name) => !env[name]);
}

/** The names in BOOT_SECRETS that are unset or blank, in production only. */
function missingBootSecrets(env) {
  if (env.NODE_ENV !== 'production') return [];
  return BOOT_SECRETS.filter((name) => !String(env[name] || '').trim());
}

/**
 * Log each missing secret and, when Sentry is configured, report it at error
 * level. Called once per boot after Sentry.init; returns the names reported.
 */
function reportMissingBootSecrets(env, sentry, log = console.error) {
  const missing = missingBootSecrets(env);
  for (const name of missing) {
    const msg = `${name} is not set in production; the path that needs it fails closed until it is`;
    log(`[startup] ${msg}`);
    if (env.SENTRY_DSN_SERVER && sentry) {
      sentry.captureMessage(msg, { level: 'error', tags: { component: 'startup', subsystem: 'env' } });
    }
  }
  return missing;
}

module.exports = { BOOT_SECRETS, REQUIRED_PROD_ENV, renderEnvRefusal, missingRequiredEnv, missingBootSecrets, reportMissingBootSecrets };
