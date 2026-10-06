// The ONE way a bar menu print file leaves the server. Both downloads stream
// through here: assigned staff on GET /api/shifts/:shiftId/menu-print
// (routes/eventDetails.js) and admin/manager on GET /api/proposals/:id/menu-print
// (routes/proposals/menuPrint.js). Each route keeps its own authorization and
// key lookup; the traversal guard, the R2 proxy and the caching headers live
// only here so the two cannot drift apart.
const crypto = require('crypto');
const { Readable, pipeline } = require('stream');
const { NotFoundError, ExternalServiceError } = require('./errors');
const { getSignedUrl } = require('./storage');

/**
 * Stream proposal `proposalId`'s menu print file (R2 object `key`) to `res`.
 * Throws NotFoundError when there is no key or the key fails the guard, and
 * ExternalServiceError when R2 is unreachable or answers non-2xx, all BEFORE
 * any header is set, so the global error middleware can still answer cleanly.
 */
async function sendMenuPrintFile(res, proposalId, key) {
  if (!key) throw new NotFoundError('No menu print file for this event.');
  // Path-traversal guard. Keys are server-generated under menu-print/<id>/, so
  // pin BOTH the per-proposal prefix and reject any traversal segment: a prefix
  // check alone would accept `menu-print/../<anything>` and, worse, would let a
  // key belonging to one proposal be served under another.
  const expectedPrefix = `menu-print/${proposalId}/`;
  if (!key.startsWith(expectedPrefix) || key.includes('..') || key.includes('//')) {
    throw new NotFoundError('No menu print file for this event.');
  }

  const url = await getSignedUrl(key);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  let upstream;
  try {
    upstream = await fetch(url, { signal: ac.signal });
  } catch (err) {
    throw new ExternalServiceError('r2', err, 'Menu file is temporarily unavailable.');
  } finally {
    clearTimeout(timer);
  }
  if (!upstream.ok) {
    // Drop R2's error body rather than leaving it buffered until GC; its text
    // is never forwarded (the client only ever sees the fixed message).
    if (upstream.body) upstream.body.cancel().catch(() => {});
    throw new ExternalServiceError('r2', new Error(`Upstream returned ${upstream.status}`), 'Menu file is temporarily unavailable.');
  }
  const ext = (key.split('.').pop() || 'pdf').replace(/[^a-z0-9]/gi, '');
  res.set('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
  res.set('Content-Disposition', `attachment; filename="bar-menu-${proposalId}.${ext}"`);
  // no-cache, not max-age: this URL is stable but the object behind it is
  // replaceable (a re-upload mints a new key and repoints the column). Caching
  // for an hour would hand a staffer yesterday's menu to print and carry to the
  // venue with no signal anything was wrong. ETag lets the browser revalidate
  // cheaply; the key changes on every upload, so its digest is a free correct
  // validator (the key itself stays server-side).
  res.set('Cache-Control', 'private, no-cache');
  res.set('ETag', `"${crypto.createHash('sha256').update(key).digest('hex').slice(0, 32)}"`);
  // Stream, never buffer: a print-resolution file can run to the 10MB upload
  // cap, and holding it whole in memory per download is the failure mode.
  // pipeline (not pipe) tears down BOTH sides: a mid-stream R2 error destroys
  // the socket (headers are gone, a failed download is the honest outcome),
  // and a client disconnect destroys the R2 stream so the upstream fetch
  // cannot linger until its own socket timeout.
  const len = upstream.headers.get('content-length');
  if (len) res.set('Content-Length', len);
  pipeline(Readable.fromWeb(upstream.body), res, () => {});
}

module.exports = { sendMenuPrintFile };
