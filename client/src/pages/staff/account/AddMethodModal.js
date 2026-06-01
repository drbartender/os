import React, { useCallback, useEffect, useState } from 'react';
import api from '../../../utils/api';
import { useToast } from '../../../context/ToastContext';

/**
 * AddMethodModal — staff portal v2 Account / Payment methods (spec §6.11).
 *
 * Two-step modal:
 *   1. Pick a category → pick a method.
 *      Tip-eligible: Venmo, Cash App, PayPal, Zelle.
 *      Payroll only: Direct deposit, Check by mail.
 *   2. Input form for the picked method.
 *      - Tip-eligible: single handle text input.
 *      - Direct deposit: routing + account inputs.
 *      - Check: no input — confirm and submit (PUT /preferred-payment-method).
 *
 * Card is intentionally not listed — it's the always-on conceptual row.
 *
 * On submit the modal calls the right endpoint and hands the resulting
 * server payload back to the parent via `onSuccess(kind, data)`. Per spec
 * §6.11 PII rules:
 *   - Bank fields go in PATCH /me/payment-methods. The server validates
 *     ABA + length, encrypts, and projects only last-4 back.
 *   - The handle PATCH endpoint validates the handle shape; bad input
 *     surfaces a 400 with `fieldErrors`, which we render inline.
 *   - The check option does NOT go through PATCH (no handle to add). It
 *     calls PUT /me/preferred-payment-method directly.
 *
 * Inline state coverage: disabled buttons + 'Adding…' spinner copy while
 * a request is in flight; field errors surface under the relevant input;
 * non-field errors toast.
 */

const TIP_OPTIONS = [
  { kind: 'venmo',   label: 'Venmo',    icon: 'V', tone: 'venmo',   placeholder: '@username' },
  { kind: 'cashapp', label: 'Cash App', icon: '$', tone: 'cashapp', placeholder: '$cashtag' },
  { kind: 'paypal',  label: 'PayPal',   icon: 'P', tone: 'paypal',  placeholder: 'paypal.me/you' },
  { kind: 'zelle',   label: 'Zelle',    icon: 'Z', tone: 'zelle',   placeholder: 'Email or phone' },
];

const PAYROLL_OPTIONS = [
  {
    kind: 'direct_deposit',
    label: 'Direct deposit',
    icon: '§',
    tone: 'bank',
    sub: 'Routing + account, encrypted at rest',
  },
  {
    kind: 'check',
    label: 'Check by mail',
    icon: '✉',
    tone: 'bank',
    sub: 'Mailed to your address on file',
  },
];

const ALL_OPTIONS = [...TIP_OPTIONS, ...PAYROLL_OPTIONS];

// Map a picked-kind onto the server PATCH body key. (Direct deposit uses two
// keys, handled separately inside submit().)
const KIND_TO_FIELD = {
  venmo: 'venmo_handle',
  cashapp: 'cashapp_handle',
  paypal: 'paypal_url',
  zelle: 'zelle_handle',
};

export default function AddMethodModal({ methods, onClose, onSuccess }) {
  const toast = useToast();

  const [picked, setPicked] = useState(null); // method kind
  const [handle, setHandle] = useState('');
  const [routing, setRouting] = useState('');
  const [account, setAccount] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});

  const option = picked ? ALL_OPTIONS.find((o) => o.kind === picked) : null;

  // Escape closes the modal (unless we're mid-submit).
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && !submitting) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, submitting]);

  // PII discipline: when the user backs out of a picked option, scrub the
  // typed value from component state immediately. We never want a freshly-
  // typed routing number lingering when the modal closes via Cancel.
  const goBack = useCallback(() => {
    if (submitting) return;
    setPicked(null);
    setHandle('');
    setRouting('');
    setAccount('');
    setFieldErrors({});
  }, [submitting]);

  const closeAll = useCallback(() => {
    if (submitting) return;
    setPicked(null);
    setHandle('');
    setRouting('');
    setAccount('');
    setFieldErrors({});
    onClose();
  }, [submitting, onClose]);

  const submit = useCallback(async () => {
    if (!picked || submitting) return;
    setFieldErrors({});

    // Check has no handle — route through PUT /preferred-payment-method.
    if (picked === 'check') {
      setSubmitting(true);
      try {
        const res = await api.put('/me/preferred-payment-method', { method: 'check' });
        // Hand a minimal payload back that mirrors a payment-methods shape so
        // the parent can patch state without re-fetching.
        onSuccess('check', {
          ...(methods || {}),
          preferred_payment_method: res?.data?.preferred_payment_method ?? 'check',
        });
        // PII discipline: clear submitting state but skip locals (nothing
        // sensitive was typed for check).
      } catch (err) {
        if (err?.fieldErrors && typeof err.fieldErrors === 'object') {
          setFieldErrors(err.fieldErrors);
        } else {
          toast.error(err?.message || 'Could not set check as your payroll route.');
        }
      } finally {
        setSubmitting(false);
      }
      return;
    }

    // Direct deposit — PATCH both fields.
    if (picked === 'direct_deposit') {
      const r = (routing || '').trim();
      const a = (account || '').trim();
      if (!r || !a) {
        setFieldErrors({
          ...(r ? {} : { routing_number: 'Routing number is required.' }),
          ...(a ? {} : { account_number: 'Account number is required.' }),
        });
        return;
      }
      setSubmitting(true);
      try {
        const res = await api.patch('/me/payment-methods', {
          routing_number: r,
          account_number: a,
        });
        // PII discipline: clear the freshly-typed plaintext before unmounting.
        setRouting('');
        setAccount('');
        onSuccess('direct_deposit', res.data);
      } catch (err) {
        if (err?.fieldErrors && typeof err.fieldErrors === 'object') {
          setFieldErrors(err.fieldErrors);
        } else {
          // PII discipline: a non-validation failure (network / 5xx) must not
          // leave the freshly-typed routing/account plaintext in component state.
          setRouting('');
          setAccount('');
          toast.error(err?.message || 'Could not save direct deposit.');
        }
      } finally {
        setSubmitting(false);
      }
      return;
    }

    // Tip-eligible — single handle PATCH.
    const field = KIND_TO_FIELD[picked];
    if (!field) return;
    const value = (handle || '').trim();
    if (!value) {
      setFieldErrors({ [field]: 'Handle is required.' });
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.patch('/me/payment-methods', { [field]: value });
      setHandle('');
      onSuccess(picked, res.data);
    } catch (err) {
      if (err?.fieldErrors && typeof err.fieldErrors === 'object') {
        setFieldErrors(err.fieldErrors);
      } else {
        toast.error(err?.message || 'Could not add the method.');
      }
    } finally {
      setSubmitting(false);
    }
  }, [picked, submitting, handle, routing, account, methods, onSuccess, toast]);

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && picked && picked !== 'check' && !submitting) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <>
      <div className="sp-modal-scrim" onClick={closeAll} />
      <div
        className="sp-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sp-add-method-title"
        onKeyDown={onKeyDown}
      >
        <button
          type="button"
          className="sp-modal-close"
          onClick={closeAll}
          aria-label="Close"
          disabled={submitting}
        >
          ×
        </button>
        <div className="sp-modal-icon" aria-hidden="true">
          <PlusIcon size={20} />
        </div>
        <div id="sp-add-method-title" className="sp-modal-title">
          {picked ? option.label : 'Add a payment method'}
        </div>

        {!picked && (
          <>
            <div className="sp-modal-sub">
              Pick what you want to add. Card payments are always on.
            </div>

            <div className="sp-pm-cat-k">Tip-eligible</div>
            <div className="sp-pm-cat">
              {TIP_OPTIONS.map((o) => {
                const alreadyOnFile = isOnFile(o.kind, methods);
                return (
                  <button
                    key={o.kind}
                    type="button"
                    className="sp-pm-cat-opt"
                    onClick={() => setPicked(o.kind)}
                    disabled={alreadyOnFile}
                    title={alreadyOnFile ? 'Already on file. Edit it from the methods list.' : undefined}
                  >
                    <div className={`sp-pm-icon ${o.tone}`} aria-hidden="true">{o.icon}</div>
                    <span>{o.label}{alreadyOnFile ? ' · on file' : ''}</span>
                  </button>
                );
              })}
            </div>

            <div className="sp-pm-cat-k">Payroll only</div>
            <div className="sp-pm-cat">
              {PAYROLL_OPTIONS.map((o) => {
                const alreadyOnFile = isOnFile(o.kind, methods);
                return (
                  <button
                    key={o.kind}
                    type="button"
                    className="sp-pm-cat-opt"
                    onClick={() => setPicked(o.kind)}
                    disabled={alreadyOnFile && o.kind !== 'check'}
                    title={
                      alreadyOnFile && o.kind !== 'check'
                        ? 'Already on file. Edit it from the methods list.'
                        : undefined
                    }
                  >
                    <div className={`sp-pm-icon ${o.tone}`} aria-hidden="true">{o.icon}</div>
                    <div className="sp-pm-cat-l">
                      <span>{o.label}</span>
                      <span className="sp-pm-cat-sub">{o.sub}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </>
        )}

        {picked && picked !== 'check' && picked !== 'direct_deposit' && (
          <>
            <div className="sp-modal-sub">Type carefully — typos are not our liability.</div>
            <div className="sp-modal-label">{option.label} handle</div>
            <input
              className="sp-modal-input sp-mono"
              autoFocus
              placeholder={option.placeholder}
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              disabled={submitting}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={!!fieldErrors[KIND_TO_FIELD[picked]]}
              style={{ minHeight: 0, height: 40 }}
            />
            {fieldErrors[KIND_TO_FIELD[picked]] && (
              <div className="sp-modal-error">{fieldErrors[KIND_TO_FIELD[picked]]}</div>
            )}
          </>
        )}

        {picked === 'direct_deposit' && (
          <>
            <div className="sp-modal-sub">
              Both fields are encrypted at rest. Once saved we’ll show you only the last 4 digits — full numbers never leave our server.
            </div>
            <div className="sp-modal-label">Routing number</div>
            <input
              className="sp-modal-input sp-mono"
              autoFocus
              placeholder="9-digit routing"
              value={routing}
              onChange={(e) => setRouting(e.target.value)}
              disabled={submitting}
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={!!fieldErrors.routing_number}
              style={{ minHeight: 0, height: 40 }}
            />
            {fieldErrors.routing_number && (
              <div className="sp-modal-error">{fieldErrors.routing_number}</div>
            )}
            <div className="sp-modal-label">Account number</div>
            <input
              className="sp-modal-input sp-mono"
              placeholder="Account number"
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              disabled={submitting}
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={!!fieldErrors.account_number}
              style={{ minHeight: 0, height: 40 }}
            />
            {fieldErrors.account_number && (
              <div className="sp-modal-error">{fieldErrors.account_number}</div>
            )}
          </>
        )}

        {picked === 'check' && (
          <div className="sp-modal-sub">
            Mailed to the address on your profile. Update there if it’s changed.
            Setting this routes payroll to Check.
          </div>
        )}

        {picked && (
          <div className="sp-modal-acts">
            <button
              type="button"
              className="sp-btn sp-btn-block sp-btn-primary"
              onClick={submit}
              disabled={submitting}
            >
              {submitting
                ? (picked === 'check' ? 'Setting…' : 'Adding…')
                : (picked === 'check' ? 'Set Check as payroll' : `Add ${option.label.toLowerCase()}`)}
            </button>
            <button
              type="button"
              className="sp-btn sp-btn-block"
              onClick={goBack}
              disabled={submitting}
            >
              ← Back
            </button>
          </div>
        )}
      </div>
    </>
  );
}

// Mirrors PaymentMethodsSection.handlePresent. Duplicated here so the modal
// stays standalone (no circular import — the section also exports its
// helper, but pulling it in would create a self-mounting cycle).
function isOnFile(kind, methods) {
  if (!methods) return false;
  switch (kind) {
    case 'venmo':   return !!methods.venmo_handle;
    case 'cashapp': return !!methods.cashapp_handle;
    case 'paypal':  return !!methods.paypal_url;
    case 'zelle':   return !!methods.zelle_handle;
    case 'direct_deposit':
      return !!methods.routing_number_last4 && !!methods.account_number_last4;
    default: return false;
  }
}

function PlusIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
