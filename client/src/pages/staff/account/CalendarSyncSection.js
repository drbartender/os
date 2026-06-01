import React, { useCallback, useEffect, useState } from 'react';
import api from '../../../utils/api';
import { useToast } from '../../../context/ToastContext';

/**
 * CalendarSyncSection — staff portal v2 Account / Calendar sync (spec §6.12).
 *
 * Mounted by AccountPage when `:section === 'calendar'`. Owns:
 *   - Subscribe buttons for Google / Apple / Outlook (deep links from feed_url).
 *   - Subscription URL block: read-only feed URL + Copy + Regenerate (modal).
 *   - "Last sync" sub-section: relative time + best-effort app chip OR an empty
 *     state when the calendar has never been pulled.
 *
 * Data source: GET /api/me/calendar-settings →
 *   {
 *     calendar_token,                // UUID
 *     calendar_token_created_at,
 *     last_ics_fetch_at,             // nullable — null when never synced
 *     calendar_subscribed_app,       // best-effort UA-detected string, nullable
 *     feed_url                       // server-composed full feed URL
 *   }
 *
 * Writes: POST /api/calendar/token/regenerate → { token, feed_url }. Confirms
 * via modal first because regenerating invalidates the OLD feed URL — any
 * calendar app already subscribed to the old URL will silently stop updating
 * until the user re-subscribes.
 *
 * Async-state coverage (spec §6.1.5):
 *   - Loading: skeleton card while the GET resolves.
 *   - Error:   inline retry card for the GET; toast for regenerate failures.
 *   - Empty:   null `last_ics_fetch_at` → "Not synced yet …" copy; the app-name
 *              chip is hidden when `calendar_subscribed_app` is null.
 *   - Disabled: Copy + Regenerate buttons flip to disabled-with-spinner-copy
 *               while their request is in flight.
 */

const SUBSCRIBE_OPTIONS = [
  {
    id: 'google',
    title: 'Add to Google Calendar',
    sub: 'One-tap subscription, web or app.',
    badge: 'G',
    badgeBg: '#4285F4',
  },
  {
    id: 'apple',
    title: 'Add to Apple Calendar',
    sub: 'iOS & macOS, opens Calendar.app.',
    badge: 'A',
    badgeBg: '#000',
  },
  {
    id: 'outlook',
    title: 'Add to Outlook',
    sub: 'Outlook for desktop or web.',
    badge: 'O',
    badgeBg: '#0078D4',
  },
];

// Replace the URL scheme with webcal://. iOS / macOS / Outlook all treat
// webcal:// as "open the OS calendar subscribe sheet, pre-filled with this
// URL." The underlying server is the same; the scheme just nudges the OS.
function toWebcalUrl(feedUrl) {
  if (!feedUrl) return null;
  return feedUrl.replace(/^https?:\/\//i, 'webcal://');
}

// Per spec §6.12: Google Calendar's add-by-URL flow accepts an encoded HTTPS
// feed URL on its `?cid=…` query param.
function googleCalendarSubscribeUrl(feedUrl) {
  if (!feedUrl) return null;
  return `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(feedUrl)}`;
}

function subscribeUrlFor(optionId, feedUrl) {
  if (!feedUrl) return null;
  if (optionId === 'google') return googleCalendarSubscribeUrl(feedUrl);
  // Apple + Outlook both subscribe cleanly via webcal://.
  return toWebcalUrl(feedUrl);
}

// Same pattern TipCardPage already uses for Copy. Centralised here so the
// older-browser/non-secure-context fallback stays consistent across the
// staff portal.
async function copyToClipboard(text, toast) {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    toast.success('Copied');
    return true;
  } catch (err) {
    toast.error("Couldn't copy. Long-press the URL to copy by hand.");
    return false;
  }
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Lightweight relative-time formatter for the Last-sync line. Avoids pulling
// a heavy date lib in just for this surface; matches the "synced 4 min ago"
// shape from the design source.
function relativeTime(iso) {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const delta = Date.now() - then;
  if (delta < MINUTE) return 'just now';
  if (delta < HOUR) {
    const m = Math.round(delta / MINUTE);
    return `${m} min ago`;
  }
  if (delta < DAY) {
    const h = Math.round(delta / HOUR);
    return `${h} hr ago`;
  }
  const d = Math.round(delta / DAY);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

// Compact absolute timestamp shown alongside the relative one so the user can
// see the exact wall-clock time on hover. Uses the browser's locale.
function absoluteTime(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  try {
    return new Date(t).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch (err) {
    return new Date(t).toISOString();
  }
}

export default function CalendarSyncSection() {
  const toast = useToast();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [copying, setCopying] = useState(false);
  const [regenModalOpen, setRegenModalOpen] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.get('/me/calendar-settings');
      setData(res.data);
    } catch (err) {
      setLoadError(err?.message || 'Could not load your calendar settings.');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchSettings(); }, [fetchSettings]);

  async function handleCopy() {
    if (!data?.feed_url || copying) return;
    setCopying(true);
    try {
      await copyToClipboard(data.feed_url, toast);
    } finally {
      setCopying(false);
    }
  }

  function openRegenModal() {
    if (regenerating) return;
    setRegenModalOpen(true);
  }

  function closeRegenModal() {
    if (regenerating) return;
    setRegenModalOpen(false);
  }

  async function confirmRegenerate() {
    if (regenerating) return;
    setRegenerating(true);
    try {
      const res = await api.post('/calendar/token/regenerate');
      // Server returns { token, feed_url }. Merge into local state so the
      // displayed URL flips immediately (and previously-cached last_ics_fetch
      // stays put — server has not cleared it on regenerate, only the URL).
      setData((prev) => ({
        ...(prev || {}),
        calendar_token: res.data?.token ?? prev?.calendar_token ?? null,
        feed_url: res.data?.feed_url ?? prev?.feed_url ?? null,
      }));
      setRegenModalOpen(false);
      toast.success('New subscription URL ready. Re-subscribe in your calendar app.');
    } catch (err) {
      toast.error(err?.message || 'Could not regenerate your subscription URL.');
    } finally {
      setRegenerating(false);
    }
  }

  // ── Render: loading ───────────────────────────────────────────────────
  if (loading && !data) {
    return (
      <section className="sp-card" aria-busy="true">
        <div className="sp-card-head">
          <div className="sp-card-title">Calendar sync</div>
        </div>
        <Skeleton />
      </section>
    );
  }

  // ── Render: hard error ────────────────────────────────────────────────
  if (loadError && !data) {
    return (
      <section className="sp-card">
        <div className="sp-card-head">
          <div className="sp-card-title">Calendar sync</div>
        </div>
        <div className="sp-error-card" style={{ marginTop: 0 }}>
          <div className="sp-error-card-msg">
            <strong>Couldn’t load your calendar settings.</strong>
            <div className="sp-error-card-sub">{loadError}</div>
          </div>
          <button type="button" className="sp-btn sp-btn-sm" onClick={fetchSettings}>
            Retry
          </button>
        </div>
      </section>
    );
  }

  const feedUrl = data?.feed_url || null;
  const lastFetchAt = data?.last_ics_fetch_at || null;
  const appName = data?.calendar_subscribed_app || null;

  return (
    <>
      <section className="sp-card">
        <div className="sp-card-head">
          <div>
            <div className="sp-card-title">Calendar sync</div>
            <div className="sp-acc-section-sub">
              Subscribe and confirmed shifts (plus T-3 BEO reminders) appear on
              your phone calendar automatically.
            </div>
          </div>
        </div>

        <div className="sp-cal-grid">
          {SUBSCRIBE_OPTIONS.map((opt) => {
            const href = subscribeUrlFor(opt.id, feedUrl);
            return (
              <a
                key={opt.id}
                className="sp-cal-opt"
                href={href || undefined}
                target="_blank"
                rel="noopener noreferrer"
                aria-disabled={href ? undefined : 'true'}
              >
                <span
                  className="sp-cal-opt-icon"
                  style={{ background: opt.badgeBg }}
                  aria-hidden="true"
                >
                  {opt.badge}
                </span>
                <span className="sp-cal-opt-l">
                  <span className="sp-cal-opt-title">{opt.title}</span>
                  <span className="sp-cal-opt-sub">{opt.sub}</span>
                </span>
                <ExternalIcon size={12} />
              </a>
            );
          })}
        </div>

        <div className="sp-subsection">Subscription URL</div>
        <div className="sp-feed-row">
          <div
            className="sp-feed-url sp-mono"
            title={feedUrl || ''}
          >
            {feedUrl || '—'}
          </div>
          <button
            type="button"
            className="sp-btn sp-btn-sm"
            onClick={handleCopy}
            disabled={!feedUrl || copying}
          >
            {copying ? 'Copying…' : 'Copy'}
          </button>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
          <button
            type="button"
            className="sp-btn sp-btn-sm sp-btn-ghost"
            onClick={openRegenModal}
            disabled={!feedUrl || regenerating}
          >
            Regenerate URL
          </button>
        </div>
        <div className="sp-form-foot">
          Refreshes every 5 minutes. Includes your confirmed shifts, plus an
          all-day reminder 3 days before any unconfirmed BEO. Past shifts roll
          off after 30 days.
        </div>

        <div className="sp-subsection">Last sync</div>
        {lastFetchAt ? (
          <div className="sp-cal-lastsync">
            <CheckIcon size={13} />
            <span>
              Last checked in{' '}
              <strong title={absoluteTime(lastFetchAt)}>
                {relativeTime(lastFetchAt)}
              </strong>
              {appName && (
                <>
                  {' · '}
                  <span
                    className="sp-chip neutral"
                    title="Detected from your calendar app's User-Agent. Best-effort — may be blank or wrong for uncommon clients."
                    style={{ marginLeft: 4 }}
                  >
                    {appName}
                  </span>
                </>
              )}
            </span>
          </div>
        ) : (
          <div className="sp-empty">
            <div className="sp-empty-title">Not synced yet</div>
            <div>
              Subscribe above, then your calendar app checks in periodically.
            </div>
          </div>
        )}
      </section>

      {regenModalOpen && (
        <RegenerateConfirmModal
          submitting={regenerating}
          onCancel={closeRegenModal}
          onConfirm={confirmRegenerate}
        />
      )}
    </>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────

function RegenerateConfirmModal({ submitting, onCancel, onConfirm }) {
  function handleKey(e) {
    if (e.key === 'Escape' && !submitting) onCancel();
  }
  return (
    <>
      <div className="sp-modal-scrim" onClick={onCancel} />
      <div
        className="sp-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sp-cal-regen-title"
        onKeyDown={handleKey}
      >
        <button
          type="button"
          className="sp-modal-close"
          onClick={onCancel}
          aria-label="Close"
          disabled={submitting}
        >
          ×
        </button>
        <div className="sp-modal-icon warn" aria-hidden="true">
          <WarnIcon size={20} />
        </div>
        <div id="sp-cal-regen-title" className="sp-modal-title">
          Regenerate subscription URL?
        </div>
        <div className="sp-modal-sub">
          Any calendar app already subscribed to your current URL will silently
          stop receiving updates. You’ll need to re-subscribe with the new URL
          on every device.
        </div>
        <div className="sp-modal-warn">
          Only do this if you think the old URL has been shared or seen by
          someone else.
        </div>
        <div className="sp-modal-acts">
          <button
            type="button"
            className="sp-btn sp-btn-block sp-btn-primary"
            onClick={onConfirm}
            disabled={submitting}
          >
            {submitting ? 'Regenerating…' : 'Regenerate URL'}
          </button>
          <button
            type="button"
            className="sp-btn sp-btn-block"
            onClick={onCancel}
            disabled={submitting}
          >
            Cancel
          </button>
        </div>
      </div>
    </>
  );
}

function Skeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem' }} aria-hidden="true">
      {Array.from({ length: 3 }).map((_, i) => (
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
      <div
        style={{
          height: 38,
          borderRadius: 6,
          background: 'var(--sp-bg-2)',
          opacity: 0.5,
          marginTop: 8,
        }}
      />
    </div>
  );
}

// ── Inline icons (Lucide-style 1.75 stroke, matches StaffShell) ─────────

function ExternalIcon({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      style={{ color: 'var(--sp-ink-3)', flexShrink: 0 }}
    >
      <path d="M14 3h7v7M10 14L21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
    </svg>
  );
}

function CheckIcon({ size = 13 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function WarnIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.4 0Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}
