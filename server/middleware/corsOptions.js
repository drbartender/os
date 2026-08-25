// Browser-facing CORS policy. Lives here rather than inline in server/index.js
// so it can be exercised without booting the app (index.js calls start() at
// load). index.js still owns the origin allowlist; this owns everything else.
//
// Browsers send an Origin header; we enforce an allowlist for those.
// Server-to-server callers (Stripe/Resend/Thumbtack webhooks, Render's health
// probe, uptime pingers) send no Origin header. They authenticate via their
// own signature/secret, not CORS, so they pass through with no
// Access-Control-Allow-Origin header at all.
function corsDelegate(isAllowedOrigin) {
  return (req, callback) => {
    if (!req.headers.origin) {
      return callback(null, { origin: false, credentials: false });
    }
    callback(null, {
      origin: (origin, cb) => {
        if (isAllowedOrigin(origin)) return cb(null, true);
        cb(new Error('Not allowed by CORS'));
      },
      credentials: true,
      // The portal (Vercel) and the API (Render) are different origins, and
      // Content-Disposition is not a CORS-safelisted response header: without
      // this, res.headers['content-disposition'] is undefined in every browser
      // and a file download cannot learn its own name or extension. Found
      // 2026-08-25 when a PNG bar menu saved as bar-menu.pdf on desktop.
      exposedHeaders: ['Content-Disposition'],
    });
  };
}

module.exports = { corsDelegate };
