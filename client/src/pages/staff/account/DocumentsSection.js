import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../../utils/api';
import { useToast } from '../../../context/ToastContext';
import ReplaceConfirmModal from './ReplaceConfirmModal';

/**
 * DocumentsSection — staff portal v2 Account / Documents (spec §6.14).
 *
 * Mounted by AccountPage when `:section === 'documents'`. Renders three cards:
 *
 *   1. Reference   — Field Guide link out to the existing `/field-guide` route.
 *   2. My documents — W-9 row, IC Agreement row (NO replace), alcohol cert row.
 *   3. Other archives — Paystubs link → /pay.
 *
 * Data source: GET /api/me/documents →
 *   {
 *     w9: { present, filename },
 *     agreement: { present },
 *     alcohol_certification: { present, filename, expires_on }
 *   }
 *
 * The server NEVER projects raw R2 keys (see accountReads.js for the
 * rationale); presence + filename + (cert) expiry is all the UI needs.
 * "View" / "Download" actions are out of scope for this surface — that'd
 * be a future signed-URL flow per spec §6.14.
 *
 * `expires_on` shape: the server SELECTs `cp.alcohol_certification_expires_on`
 * (Postgres DATE) and JSON-serializes it. node-postgres surfaces DATE as
 * a JS Date, so JSON.stringify produces an ISO timestamp like
 * "2026-07-10T00:00:00.000Z" rather than the bare YYYY-MM-DD the route
 * comment implies. We accept either shape — first 10 chars of an ISO
 * timestamp IS the YYYY-MM-DD calendar day for any TZ-aware date the
 * server stores, so a `.slice(0, 10)` is sufficient.
 *
 * Replace flow: tapping Replace on the W-9 or alcohol-cert row opens the
 * ReplaceConfirmModal (a separate file). On success, the modal calls back
 * and we re-fetch /me/documents to pick up the new filename + expiry; we
 * also flash a green tag on the just-replaced row until the next render
 * cycle (matches the design source's "Replaced" affordance).
 *
 * IC Agreement is intentionally non-replaceable — it's the signed legal
 * doc. The server's DOC_TYPES whitelist rejects anything outside
 * {w9, alcohol_certification}, so even if a Replace button was wired up
 * for the agreement, the POST would 400.
 *
 * Async-state coverage (spec §6.1.5):
 *   - Loading: skeleton card while the GET resolves.
 *   - Error:   inline retry card for the GET; toast for upload failures
 *              (the modal owns inline error display for upload errors).
 *   - Empty:   per-row "Not on file" copy; legacy "no expiry" prompt.
 *   - Disabled: Replace button stays clickable but the modal handles the
 *              actual submit-blocked state.
 */

const FIELD_GUIDE_PATH = '/field-guide';
const PAY_PATH = '/pay';

// 60-day "expires soon" threshold per spec §6.14. Counted from today to
// expires_on in calendar days, both anchored to UTC midnight so a same-day
// expiry on the client's local time doesn't off-by-one against the server.
const EXPIRES_SOON_DAYS = 60;

// Compute the expiry state from an `expires_on` value the GET returned.
// Accepts:
//   - null / undefined           → 'unknown' (legacy row, no expiry on file)
//   - 'YYYY-MM-DD'               → that calendar day, UTC
//   - ISO timestamp string       → first 10 chars (the day in UTC)
//   - JS Date (defensive)        → toISOString().slice(0,10)
// Returns one of: 'unknown' | 'expired' | 'soon' | 'ok'. Computing in UTC
// keeps the day boundary stable across timezones — a cert that expires
// 2026-07-10 is "soon" everywhere through 2026-07-10 UTC, never partly
// expired in NY and partly fine in LA.
function expiryStateFor(rawExpiresOn) {
  const day = normalizeIsoDay(rawExpiresOn);
  if (!day) return 'unknown';
  const expiry = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(expiry.getTime())) return 'unknown';
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  if (expiry.getTime() < today.getTime()) return 'expired';
  const dayMs = 86400000;
  const daysLeft = Math.round((expiry.getTime() - today.getTime()) / dayMs);
  if (daysLeft <= EXPIRES_SOON_DAYS) return 'soon';
  return 'ok';
}

function normalizeIsoDay(raw) {
  if (!raw) return null;
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return null;
    return raw.toISOString().slice(0, 10);
  }
  if (typeof raw !== 'string') return null;
  // Either a plain YYYY-MM-DD or an ISO timestamp starting with one.
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  return null;
}

function formatExpiry(rawExpiresOn) {
  const day = normalizeIsoDay(rawExpiresOn);
  if (!day) return '';
  // Force the day-of-month into the user's locale month/day/year. UTC anchor
  // (T00:00:00Z) prevents the "Jul 9 in NY, Jul 10 in LA" off-by-one.
  const d = new Date(`${day}T00:00:00Z`);
  return d.toLocaleDateString(undefined, {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export default function DocumentsSection() {
  const navigate = useNavigate();
  const toast = useToast();

  const [docs, setDocs] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  // 'w9' | 'alcohol_certification' | null
  const [replacing, setReplacing] = useState(null);
  // Maps the doc id to true after a successful replace so the row can flash
  // a "Replaced" tag through the next render. Cleared by the user navigating
  // away and back (i.e. component remount).
  const [replacedIds, setReplacedIds] = useState({});

  const fetchDocs = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.get('/me/documents');
      setDocs(res.data || null);
    } catch (err) {
      setLoadError(err?.message || 'Could not load your documents.');
      setDocs(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchDocs(); }, [fetchDocs]);

  const alcoholExpiryState = useMemo(
    () => expiryStateFor(docs?.alcohol_certification?.expires_on),
    [docs]
  );

  function openReplace(docType) {
    setReplacing(docType);
  }

  function closeReplace() {
    setReplacing(null);
  }

  async function handleReplaced() {
    const justReplaced = replacing;
    setReplacing(null);
    if (justReplaced) {
      setReplacedIds((prev) => ({ ...prev, [justReplaced]: true }));
      toast.success(
        justReplaced === 'w9'
          ? 'W-9 replaced.'
          : 'Alcohol certification replaced.'
      );
    }
    // Re-fetch to pick up the new filename + (cert) expiry.
    await fetchDocs();
  }

  // ── Render: loading ─────────────────────────────────────────────────────
  if (loading && !docs) {
    return (
      <>
        <section className="sp-card" aria-busy="true">
          <div className="sp-card-head">
            <div className="sp-card-title">Reference</div>
          </div>
          <DocSkeleton rows={1} />
        </section>
        <section className="sp-card" aria-busy="true">
          <div className="sp-card-head">
            <div className="sp-card-title">My documents</div>
          </div>
          <DocSkeleton rows={3} />
        </section>
      </>
    );
  }

  // ── Render: hard error ──────────────────────────────────────────────────
  if (loadError && !docs) {
    return (
      <section className="sp-card">
        <div className="sp-card-head">
          <div className="sp-card-title">Documents</div>
        </div>
        <div className="sp-error-card" style={{ marginTop: 0 }}>
          <div className="sp-error-card-msg">
            <strong>Couldn’t load your documents.</strong>
            <div className="sp-error-card-sub">{loadError}</div>
          </div>
          <button type="button" className="sp-btn sp-btn-sm" onClick={fetchDocs}>
            Retry
          </button>
        </div>
      </section>
    );
  }

  const w9 = docs?.w9 || { present: false, filename: null };
  const agreement = docs?.agreement || { present: false };
  const cert = docs?.alcohol_certification || { present: false, filename: null, expires_on: null };

  return (
    <>
      <section className="sp-card">
        <div className="sp-card-head">
          <div>
            <div className="sp-card-title">Reference</div>
            <div className="sp-acc-section-sub">
              Org-wide. Pinned content for offline reading on event nights.
            </div>
          </div>
        </div>
        <div className="sp-doc">
          <div className="sp-doc-icon"><BookIcon size={14} /></div>
          <div className="sp-doc-l">
            <div className="sp-doc-title">
              Field Guide
              <span className="sp-doc-tag must-read">must-read</span>
            </div>
            <div className="sp-doc-sub">
              Bar setup, signature recipes, service SOPs, talking points.
            </div>
          </div>
          <div className="sp-doc-acts">
            <a
              className="sp-btn sp-btn-sm"
              href={FIELD_GUIDE_PATH}
              onClick={(e) => {
                // SPA-internal route — let React Router handle it for an
                // instant transition instead of a full reload.
                e.preventDefault();
                navigate(FIELD_GUIDE_PATH);
              }}
            >
              <ExternalIcon size={11} />
              View
            </a>
          </div>
        </div>
      </section>

      <section className="sp-card">
        <div className="sp-card-head">
          <div>
            <div className="sp-card-title">My documents</div>
            <div className="sp-acc-section-sub">
              Personal docs on file. Tap Replace to upload a new copy.
            </div>
          </div>
        </div>

        {/* W-9 row */}
        <DocRow
          icon={<BookIcon size={14} />}
          title="W-9"
          tags={[
            ...(w9.present ? [{ key: 'signed', label: 'signed' }] : []),
            ...(replacedIds.w9 ? [{ key: 'replaced', label: 'Replaced' }] : []),
          ]}
          sub={w9.present
            ? (w9.filename || 'On file with the org.')
            : 'Not on file.'}
          actions={(
            <button
              type="button"
              className="sp-btn sp-btn-sm"
              onClick={() => openReplace('w9')}
            >
              <PenIcon size={11} />
              Replace
            </button>
          )}
        />

        {/* IC Agreement row — NO replace, signed legal doc. */}
        <DocRow
          icon={<BookIcon size={14} />}
          title="Independent Contractor Agreement"
          tags={agreement.present ? [{ key: 'signed', label: 'signed' }] : []}
          sub={agreement.present
            ? 'Countersigned.'
            : 'Not signed yet — finish onboarding to upload.'}
          actions={null}
        />

        {/* Alcohol certification row */}
        <DocRow
          icon={<BookIcon size={14} />}
          title="Alcohol certification"
          tags={[
            ...(cert.present && alcoholExpiryState === 'ok'
              ? [{ key: 'signed', label: 'signed' }]
              : []),
            ...(alcoholExpiryState === 'soon'
              ? [{ key: 'expires-soon', label: 'Expires soon' }]
              : []),
            ...(alcoholExpiryState === 'expired'
              ? [{ key: 'expired', label: 'Expired' }]
              : []),
            ...(replacedIds.alcohol_certification
              ? [{ key: 'replaced', label: 'Replaced' }]
              : []),
          ]}
          sub={(() => {
            if (!cert.present) return 'Not on file.';
            if (alcoholExpiryState === 'unknown') {
              return 'On file — add an expiry on your next replace.';
            }
            const expStr = formatExpiry(cert.expires_on);
            const file = cert.filename || 'On file';
            return expStr ? `${file} · Expires ${expStr}` : file;
          })()}
          nudge={alcoholExpiryState === 'soon' ? (
            <div className="sp-doc-nudge">
              Heads up — your alcohol certification expires soon. Tap{' '}
              <strong>Replace</strong> to upload the renewed cert.
            </div>
          ) : null}
          actions={(
            <button
              type="button"
              className="sp-btn sp-btn-sm"
              onClick={() => openReplace('alcohol_certification')}
            >
              <PenIcon size={11} />
              Replace
            </button>
          )}
        />
      </section>

      <section className="sp-card">
        <div className="sp-card-head">
          <div className="sp-card-title">Other archives</div>
        </div>
        <button
          type="button"
          className="sp-doc-link"
          onClick={() => navigate(PAY_PATH)}
        >
          <DollarIcon size={14} />
          <div className="sp-doc-link-l">
            <div className="sp-doc-link-title">Paystubs</div>
            <div className="sp-doc-link-sub">PDF for every paid period.</div>
          </div>
          <ChevronRightIcon size={12} />
        </button>
      </section>

      {replacing && (
        <ReplaceConfirmModal
          docType={replacing}
          docLabel={replacing === 'w9' ? 'W-9' : 'alcohol certification'}
          onClose={closeReplace}
          onReplaced={handleReplaced}
        />
      )}
    </>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────

function DocRow({ icon, title, tags, sub, nudge, actions }) {
  return (
    <div className="sp-doc">
      <div className="sp-doc-icon">{icon}</div>
      <div className="sp-doc-l">
        <div className="sp-doc-title">
          {title}
          {(tags || []).map((t) => (
            <span key={t.key} className={`sp-doc-tag ${t.key}`}>{t.label}</span>
          ))}
        </div>
        {sub && <div className="sp-doc-sub">{sub}</div>}
        {nudge}
      </div>
      {actions && <div className="sp-doc-acts">{actions}</div>}
    </div>
  );
}

function DocSkeleton({ rows = 2 }) {
  return (
    <div aria-hidden="true" style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          style={{
            height: 56,
            borderRadius: 8,
            background: 'var(--sp-bg-2)',
            opacity: 0.5,
          }}
        />
      ))}
    </div>
  );
}

// ── Inline icons (Lucide-style 1.75 stroke, matches StaffShell) ─────────

function BookIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 4h11a4 4 0 0 1 4 4v13H8a4 4 0 0 1-4-4V4Z" />
      <path d="M4 4v13a4 4 0 0 1 4-4h11" />
    </svg>
  );
}

function PenIcon({ size = 11 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 20h4l10-10-4-4L4 16v4ZM14 6l4 4" />
    </svg>
  );
}

function ExternalIcon({ size = 11 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
    </svg>
  );
}

function DollarIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v18M16 7c0-1.7-1.8-3-4-3s-4 1.3-4 3 1.8 3 4 3 4 1.3 4 3-1.8 3-4 3-4-1.3-4-3" />
    </svg>
  );
}

function ChevronRightIcon({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}
