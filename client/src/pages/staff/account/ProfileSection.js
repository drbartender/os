import React, { useCallback, useEffect, useId, useMemo, useState } from 'react';
import api from '../../../utils/api';
import { useToast } from '../../../context/ToastContext';
import { formatPhoneInput, stripPhone } from '../../../utils/formatPhone';

/**
 * ProfileSection — staff portal v2 Account / Profile (spec §6.10).
 *
 * Mounted by AccountPage when `:section === 'profile'`. Owns the personal-info
 * form (preferred_name, address, emergency contact) and the email-change
 * REQUEST flow. Read-only legal_name with a help-link sub-row.
 *
 * Data source: GET /api/me/profile — returns
 *   {
 *     preferred_name, email, legal_name,
 *     phone, street_address, city, state, zip_code,
 *     emergency_contact_name, emergency_contact_phone, emergency_contact_relationship,
 *     pending_email_change: { new_email, expires_at } | null
 *   }
 *
 * Writes:
 *   - PATCH /api/me/profile  — non-email fields only. The server uses a strict
 *     allowlist; we mirror it here so an accidentally-added field on the client
 *     can't be quietly stripped. Sends ONLY changed-and-non-empty keys, plus
 *     intentional clears (where the user emptied a previously-set field).
 *   - POST  /api/me/request-email-change  — { new_email }. Guarded by the
 *     server's 3/24h rate limit and 409 in-use / already-pending checks.
 *   - POST  /api/me/cancel-pending-email-change  — no body.
 *
 * Email change is INTENTIONALLY a separate, asynchronous, modal-gated flow
 * (spec §6.10). A compromised session must not flip the login email instantly;
 * the new address must be verified via a link before users.email moves.
 *
 * Async-state coverage (spec §6.1.5):
 *   - Loading: skeleton card while the GET resolves.
 *   - Error:   inline retry card for the GET; toast for PATCH/email failures.
 *   - Empty:   N/A — all fields render with a placeholder when null.
 *   - Disabled: Save button disabled while submitting + when no changes;
 *               inputs stay enabled so the user can keep editing.
 */

const PHONE_HELPER = 'SMS reminders go here.';
const ADDRESS_HELPER = 'For 1099 forms in January.';
const PREFERRED_NAME_HELPER = 'Shown on the staff roster and to clients.';
const LEGAL_NAME_HELPER_PRE = 'Need to change your legal name? Email ';
const LEGAL_NAME_HELPER_POST = ' so we can re-issue your contractor agreement.';
const LEGAL_SUPPORT_EMAIL = 'staff@drbartender.com';
const LEGAL_SUPPORT_MAILTO = `mailto:${LEGAL_SUPPORT_EMAIL}`;

const ZIP_RE = /^\d{5}(-\d{4})?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const PROFILE_FIELDS = [
  'preferred_name', 'phone', 'street_address', 'city', 'state', 'zip_code',
  'emergency_contact_name', 'emergency_contact_phone', 'emergency_contact_relationship',
];

// Map a server profile payload → the local form state. Nulls become '' so
// controlled inputs don't warn. Phone is pretty-printed for display; we strip
// back to digits on PATCH so the server's E.164 validator is happy.
function profileToForm(p) {
  return {
    preferred_name: p?.preferred_name || '',
    phone: p?.phone ? formatPhoneInput(p.phone) : '',
    street_address: p?.street_address || '',
    city: p?.city || '',
    state: p?.state || '',
    zip_code: p?.zip_code || '',
    emergency_contact_name: p?.emergency_contact_name || '',
    emergency_contact_phone: p?.emergency_contact_phone ? formatPhoneInput(p.emergency_contact_phone) : '',
    emergency_contact_relationship: p?.emergency_contact_relationship || '',
  };
}

// Compare two form states and return the keys whose value differs after
// trim(). Empty-vs-empty is "no change" even if one was null on the server.
// This is what powers "Save is disabled until something actually changed".
function diffForm(current, baseline) {
  const out = [];
  for (const k of PROFILE_FIELDS) {
    if ((current[k] || '').trim() !== (baseline[k] || '').trim()) out.push(k);
  }
  return out;
}

export default function ProfileSection() {
  const toast = useToast();

  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [form, setForm] = useState(profileToForm(null));
  const [baseline, setBaseline] = useState(profileToForm(null));
  const [fieldErrors, setFieldErrors] = useState({});
  const [saving, setSaving] = useState(false);

  // Email change flow state.
  const [emailDraft, setEmailDraft] = useState('');
  const [emailModalOpen, setEmailModalOpen] = useState(false);
  const [emailSubmitting, setEmailSubmitting] = useState(false);
  const [emailError, setEmailError] = useState(null);
  const [cancellingPending, setCancellingPending] = useState(false);

  const fetchProfile = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.get('/me/profile');
      setProfile(res.data);
      const f = profileToForm(res.data);
      setForm(f);
      setBaseline(f);
      setEmailDraft(res.data?.email || '');
    } catch (err) {
      setLoadError(err?.message || 'Could not load your profile.');
      setProfile(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchProfile(); }, [fetchProfile]);

  const changedKeys = useMemo(() => diffForm(form, baseline), [form, baseline]);
  const hasChanges = changedKeys.length > 0;
  const pending = profile?.pending_email_change || null;

  const setField = (k, v) => {
    setForm((prev) => ({ ...prev, [k]: v }));
    if (fieldErrors[k]) {
      setFieldErrors((prev) => {
        const next = { ...prev };
        delete next[k];
        return next;
      });
    }
  };

  // Client-side validation — mirrors the server. Authoritative gate is the
  // server (we trust 400 responses to surface fieldErrors); this just keeps
  // the round-trip count down for the common cases.
  function validateForChanged(values, keys) {
    const errs = {};
    for (const k of keys) {
      const v = (values[k] || '').trim();
      if (k === 'phone' && v) {
        const digits = stripPhone(v);
        if (digits.length !== 10) errs.phone = 'Phone must be a valid 10-digit number';
      }
      if (k === 'emergency_contact_phone' && v) {
        const digits = stripPhone(v);
        if (digits.length !== 10) errs.emergency_contact_phone = 'Phone must be a valid 10-digit number';
      }
      if (k === 'zip_code' && v && !ZIP_RE.test(v)) {
        errs.zip_code = 'Must be 5 digits or 5+4 (e.g. 12345 or 12345-6789)';
      }
      if (['emergency_contact_name', 'emergency_contact_phone', 'emergency_contact_relationship'].includes(k) && v.length > 100) {
        errs[k] = 'Must be 100 chars or fewer';
      }
    }
    return errs;
  }

  async function handleSave(e) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    if (!hasChanges || saving) return;

    const errs = validateForChanged(form, changedKeys);
    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs);
      return;
    }

    setSaving(true);
    setFieldErrors({});

    // Build the body — only changed keys. Empty string → null (clear). Phones
    // strip to digits for the server's E.164/10-digit validator.
    const body = {};
    for (const k of changedKeys) {
      const raw = (form[k] || '').trim();
      if (k === 'phone' || k === 'emergency_contact_phone') {
        const digits = stripPhone(raw);
        body[k] = digits ? digits : null;
      } else {
        body[k] = raw ? raw : null;
      }
    }

    try {
      await api.patch('/me/profile', body);
      toast.success('Profile saved.');
      // Re-fetch so the canonical server-formatted values (e.g. trimmed)
      // become the new baseline. Keeps "has changes?" honest across saves.
      await fetchProfile();
    } catch (err) {
      if (err?.fieldErrors && typeof err.fieldErrors === 'object') {
        setFieldErrors(err.fieldErrors);
      }
      toast.error(err?.message || 'Could not save your profile.');
    } finally {
      setSaving(false);
    }
  }

  function openEmailModal() {
    setEmailError(null);
    setEmailDraft('');
    setEmailModalOpen(true);
  }

  function closeEmailModal() {
    if (emailSubmitting) return;
    setEmailModalOpen(false);
    setEmailError(null);
  }

  async function submitEmailChange() {
    const next = (emailDraft || '').trim();
    if (!next || !EMAIL_RE.test(next) || next.length > 254) {
      setEmailError('Please enter a valid email address.');
      return;
    }
    if (next.toLowerCase() === (profile?.email || '').toLowerCase()) {
      setEmailError('This is already your current email address.');
      return;
    }
    setEmailSubmitting(true);
    setEmailError(null);
    try {
      await api.post('/me/request-email-change', { new_email: next });
      // Success: server has created the pending row + emailed both addresses.
      toast.success(`Check ${next} for a verification link.`);
      setEmailModalOpen(false);
      // Re-fetch so the pending banner appears.
      await fetchProfile();
    } catch (err) {
      // 409 EMAIL_IN_USE, 409 ALREADY_PENDING, 400 validation, 429 rate limit.
      let msg = err?.message || 'Could not request an email change.';
      if (err?.status === 409 && err?.code === 'EMAIL_IN_USE') {
        msg = 'That email is already in use.';
      } else if (err?.status === 409 && err?.code === 'ALREADY_PENDING') {
        msg = 'A pending change to that email already exists. Cancel it first or pick a different address.';
      } else if (err?.status === 429) {
        msg = 'Too many email-change requests. Please try again tomorrow.';
      }
      setEmailError(msg);
    } finally {
      setEmailSubmitting(false);
    }
  }

  async function handleCancelPending() {
    if (cancellingPending) return;
    setCancellingPending(true);
    try {
      await api.post('/me/cancel-pending-email-change');
      toast.success('Pending email change cancelled.');
      await fetchProfile();
    } catch (err) {
      toast.error(err?.message || 'Could not cancel the pending change.');
    } finally {
      setCancellingPending(false);
    }
  }

  // ── Render: loading ────────────────────────────────────────────────────
  if (loading && !profile) {
    return (
      <section className="sp-card" aria-busy="true">
        <div className="sp-card-head">
          <div className="sp-card-title">Profile</div>
        </div>
        <Skeleton />
      </section>
    );
  }

  // ── Render: hard error ─────────────────────────────────────────────────
  if (loadError && !profile) {
    return (
      <section className="sp-card">
        <div className="sp-card-head">
          <div className="sp-card-title">Profile</div>
        </div>
        <div className="sp-error-card" style={{ marginTop: 0 }}>
          <div className="sp-error-card-msg">
            <strong>Couldn’t load your profile.</strong>
            <div className="sp-error-card-sub">{loadError}</div>
          </div>
          <button type="button" className="sp-btn sp-btn-sm" onClick={fetchProfile}>
            Retry
          </button>
        </div>
      </section>
    );
  }

  return (
    <>
      <section className="sp-card">
        <div className="sp-card-head">
          <div>
            <div className="sp-card-title">Profile</div>
            <div className="sp-acc-section-sub">
              Used on contracts, paystubs, and how clients see you on the roster.
            </div>
          </div>
          <button
            type="button"
            className="sp-btn sp-btn-sm sp-btn-primary"
            onClick={handleSave}
            disabled={!hasChanges || saving}
            title={!hasChanges ? 'No changes to save' : undefined}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>

        {pending && (
          <PendingEmailBanner
            newEmail={pending.new_email}
            onCancel={handleCancelPending}
            cancelling={cancellingPending}
          />
        )}

        <form onSubmit={handleSave} noValidate>
          <div className="sp-tf-row">
            <TextField
              label="Preferred name"
              value={form.preferred_name}
              onChange={(v) => setField('preferred_name', v)}
              sub={PREFERRED_NAME_HELPER}
              error={fieldErrors.preferred_name}
              autoComplete="given-name"
            />
            <div className="sp-tf">
              <span className="sp-tf-k">Legal name</span>
              <div className="sp-tf-input sp-tf-locked" aria-readonly="true">
                {profile?.legal_name || <span className="sp-tf-placeholder">— on file with staff@drbartender.com</span>}
                <LockIcon size={12} />
              </div>
              <span className="sp-tf-sub">
                {LEGAL_NAME_HELPER_PRE}
                <a className="sp-link" href={LEGAL_SUPPORT_MAILTO}>{LEGAL_SUPPORT_EMAIL}</a>
                {LEGAL_NAME_HELPER_POST}
              </span>
            </div>
          </div>

          <div className="sp-tf-row">
            <div className="sp-tf">
              <span className="sp-tf-k">Email</span>
              <div className="sp-tf-locked-row">
                <div className="sp-tf-input sp-tf-locked sp-mono" aria-readonly="true">
                  {profile?.email || '—'}
                </div>
                <button
                  type="button"
                  className="sp-btn sp-btn-sm"
                  onClick={openEmailModal}
                  disabled={!!pending}
                  title={pending ? 'A change is already pending verification' : 'Change email'}
                >
                  Change
                </button>
              </div>
              {pending ? (
                <span className="sp-tf-sub">
                  Pending verification — check <span className="sp-mono">{pending.new_email}</span>.
                </span>
              ) : (
                <span className="sp-tf-sub">
                  We’ll verify a new address before switching.
                </span>
              )}
            </div>
            <TextField
              label="Phone"
              type="tel"
              value={form.phone}
              onChange={(v) => setField('phone', formatPhoneInput(v))}
              mono
              sub={PHONE_HELPER}
              error={fieldErrors.phone}
              autoComplete="tel"
              inputMode="tel"
              placeholder="(555) 123-4567"
            />
          </div>

          <div className="sp-tf-row">
            <TextField
              label="Street address"
              value={form.street_address}
              onChange={(v) => setField('street_address', v)}
              error={fieldErrors.street_address}
              autoComplete="address-line1"
              wide
              sub={ADDRESS_HELPER}
            />
          </div>
          <div className="sp-tf-row">
            <TextField
              label="City"
              value={form.city}
              onChange={(v) => setField('city', v)}
              error={fieldErrors.city}
              autoComplete="address-level2"
            />
            <TextField
              label="State"
              value={form.state}
              onChange={(v) => setField('state', v.toUpperCase().slice(0, 2))}
              error={fieldErrors.state}
              autoComplete="address-level1"
              placeholder="IL"
            />
            <TextField
              label="ZIP"
              value={form.zip_code}
              onChange={(v) => setField('zip_code', v)}
              error={fieldErrors.zip_code}
              autoComplete="postal-code"
              inputMode="numeric"
              placeholder="60647"
            />
          </div>

          <div className="sp-subsection">Emergency contact</div>
          <div className="sp-tf-row">
            <TextField
              label="Name"
              value={form.emergency_contact_name}
              onChange={(v) => setField('emergency_contact_name', v)}
              error={fieldErrors.emergency_contact_name}
            />
            <TextField
              label="Phone"
              type="tel"
              value={form.emergency_contact_phone}
              onChange={(v) => setField('emergency_contact_phone', formatPhoneInput(v))}
              mono
              error={fieldErrors.emergency_contact_phone}
              inputMode="tel"
            />
            <TextField
              label="Relationship"
              value={form.emergency_contact_relationship}
              onChange={(v) => setField('emergency_contact_relationship', v)}
              error={fieldErrors.emergency_contact_relationship}
              placeholder="Parent, sibling, partner…"
            />
          </div>
        </form>
      </section>

      {emailModalOpen && (
        <ChangeEmailModal
          currentEmail={profile?.email || ''}
          value={emailDraft}
          onChange={setEmailDraft}
          submitting={emailSubmitting}
          error={emailError}
          onCancel={closeEmailModal}
          onSubmit={submitEmailChange}
        />
      )}
    </>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────

function TextField({
  label, value, onChange, type = 'text', sub, error, mono, wide,
  autoComplete, inputMode, placeholder,
}) {
  const fieldId = useId();
  const descId = (error || sub) ? `${fieldId}-d` : undefined;
  return (
    <div className={'sp-tf' + (wide ? ' sp-tf-wide' : '')}>
      <label className="sp-tf-k" htmlFor={fieldId}>{label}</label>
      <input
        id={fieldId}
        className={'sp-tf-input' + (mono ? ' sp-mono' : '') + (error ? ' has-error' : '')}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        inputMode={inputMode}
        placeholder={placeholder}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={descId}
      />
      {error
        ? <span className="sp-tf-error" id={descId}>{error}</span>
        : sub ? <span className="sp-tf-sub" id={descId}>{sub}</span> : null}
    </div>
  );
}

function PendingEmailBanner({ newEmail, onCancel, cancelling }) {
  return (
    <div className="sp-pending-banner" role="status">
      <div className="sp-pending-banner-l">
        <div className="sp-pending-banner-title">Pending verification</div>
        <div className="sp-pending-banner-msg">
          Check <span className="sp-mono">{newEmail}</span> for a link to confirm the change.
          Your current email stays active until you click it.
        </div>
      </div>
      <button
        type="button"
        className="sp-btn sp-btn-sm sp-btn-ghost"
        onClick={onCancel}
        disabled={cancelling}
      >
        {cancelling ? 'Cancelling…' : 'Cancel pending change'}
      </button>
    </div>
  );
}

function ChangeEmailModal({
  currentEmail, value, onChange, submitting, error, onCancel, onSubmit,
}) {
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
        aria-labelledby="sp-email-modal-title"
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
        <div className="sp-modal-icon" aria-hidden="true">
          <MailIcon size={20} />
        </div>
        <div id="sp-email-modal-title" className="sp-modal-title">Change your email?</div>
        <div className="sp-modal-sub">
          We’ll send a verification link to the new address. Your current login
          stays active until you click the link.
        </div>
        <div className="sp-modal-label">Current email</div>
        <div className="sp-mono" style={{ fontSize: 13, color: 'var(--sp-ink-2)' }}>
          {currentEmail || '—'}
        </div>
        <div className="sp-modal-label">New email</div>
        <input
          className="sp-modal-input sp-mono"
          type="email"
          autoComplete="email"
          aria-label="New email"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="you@newdomain.com"
          disabled={submitting}
          style={{ minHeight: 0, height: 40 }}
        />
        {error && <div className="sp-modal-error">{error}</div>}
        <div className="sp-modal-warn">
          You’ll be asked to sign back in with the new address once it’s verified.
        </div>
        <div className="sp-modal-acts">
          <button
            type="button"
            className="sp-btn sp-btn-block sp-btn-primary"
            onClick={onSubmit}
            disabled={submitting}
          >
            {submitting ? 'Sending link…' : 'Send verification link'}
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem' }} aria-hidden="true">
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          style={{
            height: 60,
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

function LockIcon({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      style={{ marginLeft: 'auto', color: 'var(--sp-ink-3)' }}
    >
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

function MailIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <polyline points="3 7 12 13 21 7" />
    </svg>
  );
}
