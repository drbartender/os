import React, { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../../../utils/api';
import { useToast } from '../../../context/ToastContext';
import IOSCoachmark from './IOSCoachmark';

/**
 * NotificationsSection — staff portal v2 Account / Notifications (spec §6.13).
 *
 * Mounted by AccountPage when `:section === 'notifications'`. Owns the 8×3
 * matrix of category × channel toggles plus the SMS kill-switch indicator and
 * the critical-path guard.
 *
 * Data source: GET /api/me/staff-notifications →
 *   {
 *     prefs: {
 *       channels: { <category>: ['push' | 'sms' | 'email', ...] },
 *       quiet_hours: null
 *     },
 *     comms: { sms_enabled, email_enabled, ... }
 *   }
 *
 * Writes: PATCH /api/me/staff-notifications
 *   body { channels: { <changedCategory>: [channels...] } }
 *   PARTIAL — only the categories whose channel set actually changed go in
 *   the body. The server merges via jsonb_set so omitted categories keep
 *   their stored value.
 *
 * Phase A (this implementation):
 *   - The Push column is gated OFF site-wide. Every Push toggle is rendered
 *     disabled with a "Coming in v1.5" tooltip. The saved Push preference
 *     value is still shown (so the toggle visually reflects what it WOULD
 *     be once Push activates in Phase B / Task 54), and Push values are
 *     preserved across PATCH round-trips.
 *   - IOSCoachmark is imported as a no-op stub. Phase B will swap in the
 *     real Add-to-Home-Screen walkthrough.
 *
 * Critical-path guard (§6.13). Three categories — beo_finalized,
 * schedule_change, payday — MUST individually retain at least one channel.
 * The server enforces this with a 400 `_form` error; this component
 * pre-empts the round trip with an inline per-row error AND blocks the save
 * for any combined-state that would 400. If the server rejects anyway
 * (race with a concurrent save from another device), the server message is
 * surfaced via toast.
 *
 * SMS kill-switch indicator (§6.13). `users.communication_preferences.sms_enabled`
 * is flipped by the STOP / START SMS keyword flow at server/utils/smsInbound.js
 * (NOT by anything in this UI). When `comms.sms_enabled === false` the
 * server-side notificationChannelResolver silently strips 'sms' from every
 * resolved channel set, so a saved SMS=ON preference does NOT actually
 * deliver. We mirror that visually: every SMS toggle is rendered with a
 * strikethrough + tooltip "Global SMS is off (you replied STOP). Reply
 * START to your last Dr Bartender text to re-enable." We do NOT auto-flip
 * the saved value — just indicate the override, so the preference is
 * restored intact the moment the staffer texts START.
 *
 * Async-state coverage (spec §6.1.5):
 *   - Loading: skeleton matrix while the GET resolves.
 *   - Error:   inline retry card for the GET; toast for PATCH failures.
 *   - Empty:   N/A — server returns a default prefs object even on first load.
 *   - Disabled: Save button disabled while submitting OR no changes OR any
 *               critical row would be left empty.
 */

// Single source of truth for the 8 categories. Order = render order in the
// matrix; copy is verbatim from the spec §6.13 table.
const CATEGORIES = [
  {
    id: 'shift_offered',
    label: 'New shifts I qualify for',
    sub: 'Open shifts that match my role.',
  },
  {
    id: 'shift_decided',
    label: 'Request approved or denied',
    sub: 'Decision on a shift I requested.',
  },
  {
    id: 'cover_needed',
    label: 'Cover needed',
    sub: 'A teammate is looking for someone to cover their shift.',
  },
  {
    id: 'beo_finalized',
    label: 'BEO ready to confirm',
    sub: 'A BEO is locked and waiting for my confirm.',
  },
  {
    id: 'beo_reminder_t3',
    label: '3 days out reminder',
    sub: "Auto SMS if I haven’t confirmed an upcoming BEO.",
  },
  {
    id: 'schedule_change',
    label: 'Schedule changes',
    sub: 'Date, time, or location changed on a confirmed shift.',
  },
  {
    id: 'payday',
    label: 'Payday',
    sub: 'When a paystub posts and a payout is sent.',
  },
  {
    id: 'tip_received',
    label: 'Tips received',
    sub: 'Customer used my QR card. Push only by default.',
  },
];

// Order matters: render columns left → right.
const CHANNELS = ['push', 'sms', 'email'];

// Mirror of server/utils/notificationChannelResolver.js DEFAULT_CHANNELS — the
// fallback used when a category key is missing from the user's stored prefs
// (e.g., a future category added to schema before backfill). The resolver
// applies the same defaults server-side, so the UI matches what would
// actually be delivered.
const DEFAULT_CHANNELS = Object.freeze({
  shift_offered:   ['push', 'sms', 'email'],
  shift_decided:   ['push', 'sms'],
  cover_needed:    ['push'],
  beo_finalized:   ['push', 'sms', 'email'],
  beo_reminder_t3: ['push', 'sms'],
  schedule_change: ['push', 'sms', 'email'],
  payday:          ['sms', 'email'],
  tip_received:    ['push'],
});

// Critical-path categories (§6.13). Each MUST individually retain ≥1 channel
// in the saved state. Mirrors notificationChannelResolver.CRITICAL_CATEGORIES
// + the per-category server check in PATCH /api/me/staff-notifications.
const CRITICAL_CATEGORIES = new Set(['beo_finalized', 'schedule_change', 'payday']);

const PUSH_DISABLED_TOOLTIP = 'Coming in v1.5';
const SMS_KILL_SWITCH_TOOLTIP =
  'Global SMS is off (you replied STOP). Reply START to your last Dr Bartender text to re-enable.';
const CRITICAL_FOOTER =
  "Critical-path messages — BEO finalized, schedule changes, payday — can’t be fully muted. " +
  "We’ll deliver them through whatever channel is still on.";
const CRITICAL_ROW_ERROR =
  'Critical messages need at least one channel. Turn one on first.';

// Server prefs.channels → local matrix state. Missing keys fall back to the
// documented defaults so the UI matches what the resolver would deliver.
function prefsToMatrix(prefs) {
  const incoming = prefs?.channels || {};
  const out = {};
  for (const cat of CATEGORIES) {
    const stored = Array.isArray(incoming[cat.id]) ? incoming[cat.id] : null;
    const arr = stored !== null ? stored : DEFAULT_CHANNELS[cat.id];
    out[cat.id] = {
      push:  arr.includes('push'),
      sms:   arr.includes('sms'),
      email: arr.includes('email'),
    };
  }
  return out;
}

// Local row state → the array shape the server PATCH expects.
function rowToChannelArray(row) {
  // Order matches CHANNELS (push, sms, email) — kept deterministic so server
  // logs and ad-hoc diffs are diffable.
  const out = [];
  for (const ch of CHANNELS) if (row[ch]) out.push(ch);
  return out;
}

// Categories whose channel set differs from baseline. Compared by the
// sorted-array string form so toggle order doesn't create a false diff.
function diffMatrix(current, baseline) {
  const changed = [];
  for (const cat of CATEGORIES) {
    const a = JSON.stringify(rowToChannelArray(current[cat.id]).slice().sort());
    const b = JSON.stringify(rowToChannelArray(baseline[cat.id]).slice().sort());
    if (a !== b) changed.push(cat.id);
  }
  return changed;
}

// Rows that would, after the user's edits, be left with zero channels AND are
// in CRITICAL_CATEGORIES. These block the save (server would reject too).
function criticalEmptyRows(matrix) {
  const empties = [];
  for (const cat of CATEGORIES) {
    if (!CRITICAL_CATEGORIES.has(cat.id)) continue;
    const row = matrix[cat.id] || {};
    if (!row.push && !row.sms && !row.email) empties.push(cat.id);
  }
  return empties;
}

export default function NotificationsSection() {
  const toast = useToast();

  const [comms, setComms] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [matrix, setMatrix] = useState(prefsToMatrix(null));
  const [baseline, setBaseline] = useState(prefsToMatrix(null));
  const [saving, setSaving] = useState(false);

  // Phase A: IOSCoachmark is a stub that never opens. Wiring is left in
  // place so Phase B (Task 54) can flip the trigger without touching the
  // caller. The Push column being permanently disabled means there's no
  // user action that opens this in Phase A.
  const [coachmarkOpen, setCoachmarkOpen] = useState(false);

  const fetchPrefs = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.get('/me/staff-notifications');
      const m = prefsToMatrix(res.data?.prefs);
      setMatrix(m);
      setBaseline(m);
      setComms(res.data?.comms || {});
    } catch (err) {
      setLoadError(err?.message || 'Could not load your notification settings.');
      setComms(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchPrefs(); }, [fetchPrefs]);

  const smsKillSwitchOn = comms?.sms_enabled === false;
  const changedCategories = useMemo(() => diffMatrix(matrix, baseline), [matrix, baseline]);
  const hasChanges = changedCategories.length > 0;
  const criticalEmpties = useMemo(() => criticalEmptyRows(matrix), [matrix]);
  const criticalEmptySet = useMemo(() => new Set(criticalEmpties), [criticalEmpties]);

  // Toggle handler. Push column is gated off in Phase A: ignore clicks at
  // the data level too (the disabled attribute already blocks the click,
  // but a defense-in-depth no-op here means a future styling change can't
  // accidentally let Push flip on without the Phase B routing being live).
  const toggleChannel = (catId, channel) => {
    if (channel === 'push') return;
    setMatrix((prev) => {
      const row = prev[catId] || { push: false, sms: false, email: false };
      return { ...prev, [catId]: { ...row, [channel]: !row[channel] } };
    });
  };

  async function handleSave() {
    if (!hasChanges || saving) return;
    if (criticalEmpties.length > 0) return; // disabled-button safety net

    // Build the partial PATCH body — only changed categories ride along.
    const body = { channels: {} };
    for (const catId of changedCategories) {
      body.channels[catId] = rowToChannelArray(matrix[catId]);
    }

    setSaving(true);
    try {
      const res = await api.patch('/me/staff-notifications', body);
      // Server returns the full merged prefs — sync baseline so the next
      // diff is honest. If the server omits the body for any reason, fall
      // back to treating the just-sent state as canonical.
      const next = res.data?.prefs ? prefsToMatrix(res.data.prefs) : matrix;
      setMatrix(next);
      setBaseline(next);
      toast.success('Notification settings saved.');
    } catch (err) {
      // Server may also reject with the _form critical-path error if a
      // concurrent save from another device flipped a sibling category.
      // Surface gracefully — the inline guard handles the common case, this
      // covers the race.
      const formErr = err?.fieldErrors?._form;
      const msg = formErr || err?.message || 'Could not save your notification settings.';
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  // ── Render: loading ─────────────────────────────────────────────────────
  if (loading && !comms) {
    return (
      <section className="sp-card" aria-busy="true">
        <div className="sp-card-head">
          <div className="sp-card-title">Notifications</div>
        </div>
        <Skeleton />
      </section>
    );
  }

  // ── Render: hard error ──────────────────────────────────────────────────
  if (loadError && !comms) {
    return (
      <section className="sp-card">
        <div className="sp-card-head">
          <div className="sp-card-title">Notifications</div>
        </div>
        <div className="sp-error-card" style={{ marginTop: 0 }}>
          <div className="sp-error-card-msg">
            <strong>Couldn&rsquo;t load your notification settings.</strong>
            <div className="sp-error-card-sub">{loadError}</div>
          </div>
          <button type="button" className="sp-btn sp-btn-sm" onClick={fetchPrefs}>
            Retry
          </button>
        </div>
      </section>
    );
  }

  const saveDisabled = !hasChanges || saving || criticalEmpties.length > 0;
  const saveTitle = !hasChanges
    ? 'No changes to save'
    : criticalEmpties.length > 0
      ? CRITICAL_ROW_ERROR
      : undefined;

  return (
    <>
      <section className="sp-card">
        <div className="sp-card-head">
          <div>
            <div className="sp-card-title">Notifications</div>
            <div className="sp-acc-section-sub">
              Pick how I hear from you. SMS goes to your mobile, email to your
              inbox, push to the staff app on your phone (coming in v1.5).
            </div>
          </div>
          <button
            type="button"
            className="sp-btn sp-btn-sm sp-btn-primary"
            onClick={handleSave}
            disabled={saveDisabled}
            title={saveTitle}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>

        {smsKillSwitchOn && (
          <div className="sp-push-banner denied" role="status">
            <WarnIcon size={14} />
            <div>
              <div className="sp-push-banner-t">
                <strong>SMS is off.</strong>
              </div>
              <div className="sp-notif-banner-sub">
                You replied STOP to a Dr Bartender text. Reply START to your
                last text to re-enable. Your saved SMS picks below are kept
                so they come back the moment you opt back in.
              </div>
            </div>
          </div>
        )}

        <div className="sp-notif-head" role="presentation">
          <div />
          <div className="sp-notif-channel">Push</div>
          <div className="sp-notif-channel">SMS</div>
          <div className="sp-notif-channel">Email</div>
        </div>

        {CATEGORIES.map((cat) => {
          const row = matrix[cat.id] || { push: false, sms: false, email: false };
          const isCriticalEmpty = criticalEmptySet.has(cat.id);
          return (
            <div
              key={cat.id}
              className={'sp-notif-row' + (isCriticalEmpty ? ' has-error' : '')}
            >
              <div className="sp-notif-l">
                <div className="sp-notif-title">{cat.label}</div>
                <div className="sp-notif-sub">{cat.sub}</div>
                {isCriticalEmpty && (
                  <div className="sp-notif-row-err">{CRITICAL_ROW_ERROR}</div>
                )}
              </div>
              <ChannelToggle
                value={row.push}
                onChange={() => toggleChannel(cat.id, 'push')}
                disabled
                title={PUSH_DISABLED_TOOLTIP}
                ariaLabel={`Push for ${cat.label} (coming in v1.5)`}
              />
              <ChannelToggle
                value={row.sms}
                onChange={() => toggleChannel(cat.id, 'sms')}
                overridden={smsKillSwitchOn}
                title={smsKillSwitchOn ? SMS_KILL_SWITCH_TOOLTIP : undefined}
                ariaLabel={`SMS for ${cat.label}`}
              />
              <ChannelToggle
                value={row.email}
                onChange={() => toggleChannel(cat.id, 'email')}
                ariaLabel={`Email for ${cat.label}`}
              />
            </div>
          );
        })}

        <div className="sp-form-foot">{CRITICAL_FOOTER}</div>
      </section>

      <IOSCoachmark
        open={coachmarkOpen}
        onClose={() => setCoachmarkOpen(false)}
      />
    </>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────

function ChannelToggle({ value, onChange, disabled, overridden, title, ariaLabel }) {
  const cls =
    'sp-toggle'
    + (value ? ' on' : '')
    + (disabled ? ' disabled' : '')
    + (overridden ? ' sp-toggle-overridden' : '');
  return (
    <button
      type="button"
      className={cls}
      onClick={() => { if (!disabled) onChange(); }}
      aria-pressed={value}
      aria-disabled={disabled ? 'true' : undefined}
      aria-label={ariaLabel}
      title={title}
      disabled={disabled}
    >
      <span className="sp-toggle-thumb" />
    </button>
  );
}

function Skeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem' }} aria-hidden="true">
      <div
        style={{
          height: 28,
          borderRadius: 6,
          background: 'var(--sp-bg-2)',
          opacity: 0.5,
        }}
      />
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          style={{
            height: 48,
            borderRadius: 6,
            background: 'var(--sp-bg-2)',
            opacity: 0.5,
          }}
        />
      ))}
    </div>
  );
}

// ── Inline icons (Lucide-style 1.75 stroke, matches StaffShell) ──────────

function WarnIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.4 0Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}
