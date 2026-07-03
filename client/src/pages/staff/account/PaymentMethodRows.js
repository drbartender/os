import React from 'react';

/**
 * PaymentMethodRows — row sub-components for PaymentMethodsSection (spec §6.11).
 *
 * Extracted so PaymentMethodsSection stays in the file-size sweet spot. Each
 * row owns its own visual layout; the parent owns the data fetch + state.
 *
 * PII discipline:
 *   - Direct-deposit row shows `••••<last4>` only. We never receive the full
 *     routing/account from the server — only `_last4` strings. The edit form
 *     starts empty by design (no pre-fill possible).
 *   - We never log or analytics-emit handle / bank values.
 */

// Per-method display metadata. Icon glyphs + tone classes match TipCardPage
// + the existing .sp-pm-icon family in index.css.
export const METHOD_META = {
  venmo:          { label: 'Venmo',          icon: 'V',      tone: 'venmo' },
  cashapp:        { label: 'Cash App',       icon: '$',      tone: 'cashapp' },
  paypal:         { label: 'PayPal',         icon: 'P',      tone: 'paypal' },
  zelle:          { label: 'Zelle',          icon: 'Z',      tone: 'zelle' },
  direct_deposit: { label: 'Direct deposit', icon: '§', tone: 'bank' },
  check:          { label: 'Check by mail',  icon: '✉', tone: 'bank' },
};

// Build the human identifier for a method, given the GET /payment-methods
// payload. Last-4-only for direct deposit (full account never leaves the
// server). Returns '' for cases that haven't been set up.
export function methodIdentifier(method, methods) {
  if (!methods) return '';
  switch (method) {
    case 'venmo':
      return methods.venmo_handle ? `@${methods.venmo_handle}` : '';
    case 'cashapp':
      return methods.cashapp_handle ? `$${methods.cashapp_handle}` : '';
    case 'paypal':
      return methods.paypal_url
        ? String(methods.paypal_url).replace(/^https?:\/\//, '')
        : '';
    case 'zelle':
      return methods.zelle_handle || '';
    case 'direct_deposit':
      return methods.account_number_last4
        ? `••••${methods.account_number_last4}`
        : '';
    case 'check':
      return 'address on file';
    default:
      return '';
  }
}

// Conceptual card row — always-on. Spec §6.11: non-editable, non-removable,
// "Always on" chip. Settles through the platform.
export function CardAlwaysOnRow() {
  return (
    <div className="sp-pm always-on">
      <div className="sp-pm-icon card" aria-hidden="true">◎</div>
      <div className="sp-pm-l">
        <div className="sp-pm-k">
          Card payments
          <span className="sp-pm-onchip">Always on</span>
        </div>
        <div className="sp-pm-sub">Apple Pay · Google Pay · credit & debit</div>
      </div>
    </div>
  );
}

export function TipMethodRow({
  kind, methods, isPreferred,
  editing, editErrors, editPlaceholder,
  onEditStart, onEditCancel, onEditChange, onEditSubmit,
  onRemove, onSetPreferred,
  busyEdit, busyRemove, busyPreferred,
}) {
  const meta = METHOD_META[kind];
  const identifier = methodIdentifier(kind, methods);
  // PayPal's column is `paypal_url`; surface either field-error key.
  const errorKey = `${kind}_handle`;
  const paypalErrorKey = kind === 'paypal' ? 'paypal_url' : errorKey;
  const inlineError = editErrors[paypalErrorKey] || editErrors[errorKey];

  return (
    <div className={'sp-pm' + (isPreferred ? ' preferred' : '')}>
      <div className={`sp-pm-icon ${meta.tone}`} aria-hidden="true">{meta.icon}</div>
      <div className="sp-pm-l">
        <div className="sp-pm-k">
          {meta.label}
          {isPreferred && <span className="sp-pm-pref-chip">Preferred for payroll</span>}
        </div>
        {editing ? (
          <div className="sp-pm-edit-row">
            <input
              className="sp-pm-input sp-mono"
              autoFocus
              aria-label={`${meta.label} handle`}
              value={editing.value || ''}
              onChange={(e) => onEditChange(e.target.value)}
              placeholder={editPlaceholder}
              disabled={busyEdit}
              aria-invalid={inlineError ? 'true' : undefined}
              autoComplete="off"
              spellCheck={false}
            />
            {inlineError && <div className="sp-pm-edit-error">{inlineError}</div>}
          </div>
        ) : (
          <div className="sp-pm-v sp-mono">
            {identifier || <em className="sp-tf-sub">no handle set</em>}
          </div>
        )}
      </div>
      <div className="sp-pm-acts">
        {editing ? (
          <>
            <button
              type="button"
              className="sp-btn sp-btn-sm sp-btn-primary"
              onClick={onEditSubmit}
              disabled={busyEdit}
            >
              {busyEdit ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              className="sp-btn sp-btn-sm sp-btn-ghost"
              onClick={onEditCancel}
              disabled={busyEdit}
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            {!isPreferred && (
              <button
                type="button"
                className="sp-btn sp-btn-sm"
                onClick={onSetPreferred}
                disabled={busyPreferred || !identifier}
                title={identifier ? 'Route payroll here' : 'Add a handle before setting it as preferred'}
              >
                {busyPreferred ? 'Setting…' : 'Set as preferred'}
              </button>
            )}
            <button
              type="button"
              className="sp-btn sp-btn-sm sp-btn-ghost"
              onClick={onEditStart}
              title="Edit"
              aria-label={`Edit ${meta.label}`}
              disabled={busyRemove}
            >
              <PenIcon size={11} />
            </button>
            <button
              type="button"
              className="sp-btn sp-btn-sm sp-btn-ghost sp-pm-del"
              onClick={onRemove}
              title="Remove"
              aria-label={`Remove ${meta.label}`}
              disabled={busyRemove}
            >
              {busyRemove ? <Spinner size={11} /> : <XIcon size={11} />}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function DirectDepositRow({
  methods, isPreferred,
  editing, editErrors,
  onEditStart, onEditCancel, onEditChange, onEditSubmit,
  onRemove, onSetPreferred,
  busyEdit, busyRemove, busyPreferred,
}) {
  const meta = METHOD_META.direct_deposit;
  const identifier = methodIdentifier('direct_deposit', methods);

  return (
    <div className={'sp-pm' + (isPreferred ? ' preferred' : '')}>
      <div className={`sp-pm-icon ${meta.tone}`} aria-hidden="true">{meta.icon}</div>
      <div className="sp-pm-l">
        <div className="sp-pm-k">
          {meta.label}
          {isPreferred && <span className="sp-pm-pref-chip">Preferred for payroll</span>}
        </div>
        {editing ? (
          <div className="sp-pm-edit-grid">
            <input
              className="sp-pm-input sp-mono"
              autoFocus
              aria-label="Routing number"
              value={editing.routing || ''}
              onChange={(e) => onEditChange({ routing: e.target.value })}
              placeholder="9-digit routing"
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              disabled={busyEdit}
              aria-invalid={editErrors.routing_number ? 'true' : undefined}
            />
            {editErrors.routing_number && (
              <div className="sp-pm-edit-error">{editErrors.routing_number}</div>
            )}
            <input
              className="sp-pm-input sp-mono"
              aria-label="Account number"
              value={editing.account || ''}
              onChange={(e) => onEditChange({ account: e.target.value })}
              placeholder="Account number"
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              disabled={busyEdit}
              aria-invalid={editErrors.account_number ? 'true' : undefined}
            />
            {editErrors.account_number && (
              <div className="sp-pm-edit-error">{editErrors.account_number}</div>
            )}
            <div className="sp-pm-edit-note">
              Re-enter both. Saved numbers are encrypted and never sent back to your device.
            </div>
          </div>
        ) : (
          <div className="sp-pm-v sp-mono">
            {identifier || <em className="sp-tf-sub">no bank info on file</em>}
          </div>
        )}
      </div>
      <div className="sp-pm-acts">
        {editing ? (
          <>
            <button
              type="button"
              className="sp-btn sp-btn-sm sp-btn-primary"
              onClick={onEditSubmit}
              disabled={busyEdit}
            >
              {busyEdit ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              className="sp-btn sp-btn-sm sp-btn-ghost"
              onClick={onEditCancel}
              disabled={busyEdit}
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            {!isPreferred && (
              <button
                type="button"
                className="sp-btn sp-btn-sm"
                onClick={onSetPreferred}
                disabled={busyPreferred || !identifier}
                title={identifier ? 'Route payroll here' : 'Add routing + account before setting it as preferred'}
              >
                {busyPreferred ? 'Setting…' : 'Set as preferred'}
              </button>
            )}
            <button
              type="button"
              className="sp-btn sp-btn-sm sp-btn-ghost"
              onClick={onEditStart}
              title="Edit"
              aria-label="Edit direct deposit"
              disabled={busyRemove}
            >
              <PenIcon size={11} />
            </button>
            <button
              type="button"
              className="sp-btn sp-btn-sm sp-btn-ghost sp-pm-del"
              onClick={onRemove}
              title="Remove"
              aria-label="Remove direct deposit"
              disabled={busyRemove}
            >
              {busyRemove ? <Spinner size={11} /> : <XIcon size={11} />}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function CheckRow({ isPreferred, onSetPreferred, onRemove, busyPreferred }) {
  const meta = METHOD_META.check;
  return (
    <div className={'sp-pm' + (isPreferred ? ' preferred' : '')}>
      <div className={`sp-pm-icon ${meta.tone}`} aria-hidden="true">{meta.icon}</div>
      <div className="sp-pm-l">
        <div className="sp-pm-k">
          {meta.label}
          {isPreferred && <span className="sp-pm-pref-chip">Preferred for payroll</span>}
        </div>
        <div className="sp-pm-v">Mailed to your address on file.</div>
      </div>
      <div className="sp-pm-acts">
        {!isPreferred ? (
          <button
            type="button"
            className="sp-btn sp-btn-sm"
            onClick={onSetPreferred}
            disabled={!!busyPreferred}
          >
            {busyPreferred ? 'Setting…' : 'Set as preferred'}
          </button>
        ) : (
          <button
            type="button"
            className="sp-btn sp-btn-sm sp-btn-ghost sp-pm-del"
            onClick={onRemove}
            title="Stop routing payroll to check"
            aria-label="Remove check as preferred"
            disabled={!!busyPreferred}
          >
            {busyPreferred ? <Spinner size={11} /> : <XIcon size={11} />}
          </button>
        )}
      </div>
    </div>
  );
}

// ── Inline icons (Lucide-style 1.75 stroke, matches StaffShell). ─────────

function PenIcon({ size = 11 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 20h4l10-10-4-4L4 16v4ZM14 6l4 4" />
    </svg>
  );
}

function XIcon({ size = 11 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6l-12 12" />
    </svg>
  );
}

function Spinner({ size = 11 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" aria-hidden="true"
      style={{ animation: 'sp-spin 0.9s linear infinite' }}>
      <path d="M21 12a9 9 0 1 1-9-9" />
    </svg>
  );
}
