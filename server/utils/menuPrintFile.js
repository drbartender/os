// The ONE way a bar menu print file leaves the server. Both downloads stream
// through here: assigned staff on GET /api/shifts/:shiftId/menu-print
// (routes/eventDetails.js) and admin/manager on GET /api/proposals/:id/menu-print
// (routes/proposals/menuPrint.js). Each route keeps its own authorization and
// key lookup; the traversal guard, the R2 proxy and the caching headers live
// only here so the two cannot drift apart.
//
// It is also the ONE way the print key is set (spec 2026-10-01 section 8).
// setMenuPrintKey(executor, proposalId, key) runs the one UPDATE that posts a
// file (and clears menu_not_required) on the executor it is given: the pool for
// the manual upload (POST /api/proposals/:id/menu-print), the transaction client
// for Approve (POST /api/proposals/:id/menu-draft/approve). It never uploads and
// never fires duty reaccrual. reaccrueDuty(proposalId) re-reconciles the $5
// menu_print duty line; every caller fires it only AFTER its write is
// committed, so the accrual always reads the committed key.
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

/**
 * Post `key` as proposal `proposalId`'s print file on `executor` (the pool, or
 * a transaction client whose COMMIT the caller owns). Uploading a file
 * necessarily means a menu IS needed, so the flag is cleared in the same
 * statement and the tri-state cannot land in a contradictory place. Throws
 * NotFoundError when no row matched: a proposal deleted in between must not
 * report a posted file. Does not upload, and does not fire reaccrueDuty.
 */
async function setMenuPrintKey(executor, proposalId, key) {
  const upd = await executor.query(
    'UPDATE proposals SET menu_print_key = $1, menu_not_required = false WHERE id = $2',
    [key, proposalId]
  );
  if (!upd.rowCount) throw new NotFoundError('Proposal not found.');
  return { rowCount: upd.rowCount };
}

// Duty-pay reversal/derivation hook (spec 2026-08-06 §3.2): the $5 menu_print
// line keys on menu_print_key, so posting or unposting the file on a COMPLETED
// event must re-reconcile duty lines. Accrual is the reconciler and no-ops on
// non-completed proposals. Best-effort, off the response path, own connection.
function reaccrueDuty(proposalId) {
  setImmediate(() => {
    require('./payrollAccrual').maybeReaccrueForDuty(Number(proposalId))
      .catch((e) => {
        if (process.env.SENTRY_DSN_SERVER) {
          const Sentry = require('@sentry/node');
          Sentry.captureException(e, { tags: { route: 'menuPrint', step: 'duty_reaccrual' } });
        }
      });
  });
}

module.exports = { sendMenuPrintFile, setMenuPrintKey, reaccrueDuty };
