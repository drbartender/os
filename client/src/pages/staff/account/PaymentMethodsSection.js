import React, { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../../../utils/api';
import { useToast } from '../../../context/ToastContext';
import AddMethodModal from './AddMethodModal';
import {
  METHOD_META,
  methodIdentifier,
  CardAlwaysOnRow,
  TipMethodRow,
  DirectDepositRow,
  CheckRow,
} from './PaymentMethodRows';

/**
 * PaymentMethodsSection — staff portal v2 Account / Payment methods (spec §6.11).
 *
 * Mounted by AccountPage when `:section === 'payments'`. Owns:
 *   - Top "Payroll routes to …" pill (with [Change] that scrolls to the methods list).
 *   - Methods-on-file list:
 *       * Card payments — conceptual always-on row, NO DB field. Rendered
 *         client-side as a constant so the UI matches the printed tip card
 *         and the public chooser page; settles through the platform.
 *       * Tip-eligible (Venmo / Cash App / PayPal / Zelle) — editable handle,
 *         Set as preferred, Remove.
 *       * Payroll-only (Direct deposit / Check) — Direct deposit shows masked
 *         last-4 (server never returns full numbers); Check has no handle.
 *   - "Add a method" button → AddMethodModal.
 *   - Verbatim footer disclaimer.
 *
 * Data source: GET /api/me/payment-methods, returning
 *   {
 *     preferred_payment_method,                  // 'venmo' | 'cashapp' | 'paypal'
 *                                                // | 'zelle' | 'direct_deposit'
 *                                                // | 'check' | null
 *     venmo_handle, cashapp_handle, paypal_url, zelle_handle,
 *     routing_number_last4, account_number_last4,  // LAST 4 ONLY — full numbers
 *                                                  // never leave the server.
 *     payment_username,
 *   }
 *
 * Writes:
 *   - PATCH /api/me/payment-methods  — partial map from the server allowlist:
 *       { venmo_handle?, cashapp_handle?, paypal_url?, zelle_handle?,
 *         routing_number?, account_number?, payment_username? }
 *     null/'' clears a field. The server validates handles, validates ABA
 *     routing + 4-17 digit account, encrypts bank fields, and returns the
 *     re-projected GET shape plus `preferred_cleared: bool` (true when
 *     clearing a handle auto-NULLed the preferred target).
 *   - PUT  /api/me/preferred-payment-method  — { method }, where method is
 *     one of {venmo, cashapp, paypal, zelle, direct_deposit, check} or null.
 *
 * PII discipline:
 *   - Bank routing/account NEVER come back full from the server. We display
 *     only last4 (e.g. "••••4321"). We never reconstruct full numbers and
 *     never log handle/bank values. No analytics/Sentry breadcrumbs on
 *     these field values.
 *   - PATCH bodies carry full plaintext only when the user (re-)entered the
 *     value. Editing direct deposit therefore means typing fresh numbers
 *     because pre-fill is impossible (we never had the full value).
 *   - After PATCH submit we clear the input from local state so the value
 *     doesn't linger in the React tree.
 *
 * Async-state coverage (spec §6.1.5):
 *   - Loading: skeleton card.
 *   - Error:   inline retry card.
 *   - Empty:   GET returns synthetic empty shape for new hires → "No methods
 *              yet. Tap Add a method below to start."
 *   - Disabled: per-row buttons spin and disable while a mutation is in flight;
 *               Set-as-preferred is disabled (with tooltip) for any method
 *               whose handle isn't on file (server rejects, but the client-side
 *               disabled state keeps the round-trip clean).
 *
 * Acceptance check (spec §6.11): adding Venmo → setting as preferred → clearing
 * the handle flips the top pill to "No payroll method set." The server tells us
 * this via `preferred_cleared: true` on the clearing PATCH; we apply the
 * server's updated preferred (NULL) straight into local state.
 */

// Tip-eligible handle keys, in the order the methods list renders them.
const TIP_ELIGIBLE_METHODS = ['venmo', 'cashapp', 'paypal', 'zelle'];

// Mirrors the server's eligibility check.
function handlePresent(method, methods) {
  if (!methods) return false;
  switch (method) {
    case 'venmo':   return !!methods.venmo_handle;
    case 'cashapp': return !!methods.cashapp_handle;
    case 'paypal':  return !!methods.paypal_url;
    case 'zelle':   return !!methods.zelle_handle;
    case 'direct_deposit':
      return !!methods.routing_number_last4 && !!methods.account_number_last4;
    case 'check':   return true;
    default:        return false;
  }
}

// Placeholder copy reused between PaymentMethodsSection (inline edit) and
// AddMethodModal so both surfaces hint with the same shape.
function inlinePlaceholder(kind) {
  switch (kind) {
    case 'venmo':   return '@username';
    case 'cashapp': return '$cashtag';
    case 'paypal':  return 'paypal.me/you';
    case 'zelle':   return 'Email or phone';
    default:        return '';
  }
}

export default function PaymentMethodsSection() {
  const toast = useToast();

  const [methods, setMethods] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  // Active per-row state (inline edit on tip-eligible rows + direct-deposit).
  // For tip-eligible: { kind: 'venmo'|'cashapp'|'paypal'|'zelle', value: string }
  // For direct deposit: { kind: 'direct_deposit', routing: string, account: string }
  const [editing, setEditing] = useState(null);
  const [editErrors, setEditErrors] = useState({});
  // Per-row spinner gates. Track by method token; preferred has its own gate.
  const [busyEdit, setBusyEdit] = useState(null);     // 'venmo' | … | 'direct_deposit'
  const [busyRemove, setBusyRemove] = useState(null); // same
  const [busyPreferred, setBusyPreferred] = useState(null);
  const [addOpen, setAddOpen] = useState(false);

  const fetchMethods = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.get('/me/payment-methods');
      setMethods(res.data || {});
    } catch (err) {
      setLoadError(err?.message || 'Could not load your payment methods.');
      setMethods(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchMethods(); }, [fetchMethods]);

  const preferred = methods?.preferred_payment_method || null;

  // Apply the GET-shape returned by PATCH straight into local state. The
  // server projects in the same shape it returns on GET, plus the
  // `preferred_cleared: bool` signal — we strip that here. We spread the
  // returned keys over prev so a partial caller (the AddMethodModal's
  // synthetic 'check' success) can pass a small object without nuking other
  // keys; PATCH responses are full-shape so they overwrite cleanly.
  const applyServerState = useCallback((data) => {
    if (!data) return;
    setMethods((prev) => {
      const { preferred_cleared: _preferredCleared, ...rest } = data;
      return { ...prev, ...rest };
    });
  }, []);

  // ── Edit / remove / set-preferred handlers ─────────────────────────────

  const startEdit = useCallback((kind) => {
    setEditErrors({});
    if (kind === 'direct_deposit') {
      // We never had the full routing/account values — only last4. The user
      // must re-enter both to update either. Empty inputs by design.
      setEditing({ kind, routing: '', account: '' });
    } else {
      setEditing({ kind, value: '' });
    }
  }, []);

  const cancelEdit = useCallback(() => {
    setEditing(null);
    setEditErrors({});
  }, []);

  const submitEdit = useCallback(async () => {
    if (!editing || busyEdit) return;
    const { kind } = editing;

    const body = {};
    if (kind === 'direct_deposit') {
      const routing = (editing.routing || '').trim();
      const account = (editing.account || '').trim();
      if (!routing || !account) {
        setEditErrors({
          ...(routing ? {} : { routing_number: 'Routing number is required.' }),
          ...(account ? {} : { account_number: 'Account number is required.' }),
        });
        return;
      }
      body.routing_number = routing;
      body.account_number = account;
    } else {
      const value = (editing.value || '').trim();
      if (!value) {
        setEditErrors({ [`${kind}_handle`]: 'Handle is required.' });
        return;
      }
      if (kind === 'venmo') body.venmo_handle = value;
      else if (kind === 'cashapp') body.cashapp_handle = value;
      else if (kind === 'paypal') body.paypal_url = value;
      else if (kind === 'zelle') body.zelle_handle = value;
    }

    setBusyEdit(kind);
    setEditErrors({});

    try {
      const res = await api.patch('/me/payment-methods', body);
      applyServerState(res.data);
      // PII discipline: clear the freshly-typed plaintext from component
      // state immediately. The server holds the canonical (encrypted) record.
      setEditing(null);
      toast.success(`${METHOD_META[kind]?.label || 'Method'} updated.`);
    } catch (err) {
      if (err?.fieldErrors && typeof err.fieldErrors === 'object') {
        setEditErrors(err.fieldErrors);
      } else if (kind === 'direct_deposit') {
        // PII discipline: a non-validation failure (network / 5xx) must not
        // leave the freshly-typed routing/account plaintext lingering in the
        // editing state. Close the edit; the user re-enters on retry.
        setEditing(null);
      }
      toast.error(err?.message || 'Could not save the change.');
    } finally {
      setBusyEdit(null);
    }
  }, [editing, busyEdit, applyServerState, toast]);

  const removeMethod = useCallback(async (kind) => {
    if (busyRemove) return;
    setBusyRemove(kind);
    try {
      const body = {};
      if (kind === 'venmo') body.venmo_handle = null;
      else if (kind === 'cashapp') body.cashapp_handle = null;
      else if (kind === 'paypal') body.paypal_url = null;
      else if (kind === 'zelle') body.zelle_handle = null;
      else if (kind === 'direct_deposit') {
        body.routing_number = null;
        body.account_number = null;
      } else {
        return; // 'check' has no removable handle data
      }
      const res = await api.patch('/me/payment-methods', body);
      applyServerState(res.data);
      // Close any open edit form for the row we just cleared.
      if (editing?.kind === kind) setEditing(null);
      if (res?.data?.preferred_cleared) {
        toast.success('Method removed. Payroll routing was cleared.');
      } else {
        toast.success('Method removed.');
      }
    } catch (err) {
      toast.error(err?.message || 'Could not remove the method.');
    } finally {
      setBusyRemove(null);
    }
  }, [busyRemove, editing, applyServerState, toast]);

  const setPreferred = useCallback(async (method) => {
    if (busyPreferred) return;
    // Use a stable sentinel for the null case so the busy gate still works.
    setBusyPreferred(method ?? '__null__');
    try {
      const res = await api.put('/me/preferred-payment-method', { method });
      const next = res?.data?.preferred_payment_method ?? method ?? null;
      setMethods((prev) => ({
        ...(prev || {}),
        preferred_payment_method: next,
      }));
      if (next) {
        const label = METHOD_META[next]?.label || next;
        toast.success(`Payroll routes to ${label}.`);
      } else {
        toast.success('Payroll routing cleared.');
      }
    } catch (err) {
      toast.error(err?.message || 'Could not set preferred method.');
    } finally {
      setBusyPreferred(null);
    }
  }, [busyPreferred, toast]);

  // ── Add-modal success ──────────────────────────────────────────────────

  const handleAddSuccess = useCallback((kind, data) => {
    if (data) applyServerState(data);
    setAddOpen(false);
    const label = METHOD_META[kind]?.label || 'Method';
    toast.success(`${label} added.`);
  }, [applyServerState, toast]);

  // Which methods already have data on file? Drives the methods-list render
  // order and the "Set as preferred" disabled state.
  const onFile = useMemo(() => {
    const out = new Set();
    if (!methods) return out;
    for (const m of [...TIP_ELIGIBLE_METHODS, 'direct_deposit']) {
      if (handlePresent(m, methods)) out.add(m);
    }
    // 'check' is rendered only when it's the active preferred (no handle to
    // hold otherwise; spec §6.11 lists Check under "Set-preferred only").
    if (preferred === 'check') out.add('check');
    return out;
  }, [methods, preferred]);

  const hasAnyMethodOnFile = onFile.size > 0;

  // ── Loading ────────────────────────────────────────────────────────────
  if (loading && !methods) {
    return (
      <section className="sp-card" aria-busy="true">
        <div className="sp-card-head">
          <div className="sp-card-title">Payment methods</div>
        </div>
        <Skeleton />
      </section>
    );
  }

  // ── Hard error ─────────────────────────────────────────────────────────
  if (loadError && !methods) {
    return (
      <section className="sp-card">
        <div className="sp-card-head">
          <div className="sp-card-title">Payment methods</div>
        </div>
        <div className="sp-error-card" style={{ marginTop: 0 }}>
          <div className="sp-error-card-msg">
            <strong>Couldn’t load your payment methods.</strong>
            <div className="sp-error-card-sub">{loadError}</div>
          </div>
          <button type="button" className="sp-btn sp-btn-sm" onClick={fetchMethods}>
            Retry
          </button>
        </div>
      </section>
    );
  }

  // ── Normal render ──────────────────────────────────────────────────────

  const preferredMeta = preferred ? METHOD_META[preferred] : null;
  const preferredIdentifier = preferred ? methodIdentifier(preferred, methods) : '';

  const scrollToList = () => {
    const el = document.getElementById('sp-payroll-picker');
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  };

  return (
    <section className="sp-card">
      <div className="sp-card-head">
        <div>
          <div className="sp-card-title">Payment methods</div>
          <div className="sp-acc-section-sub">
            Where payroll lands and which handles your QR tip card offers guests.
          </div>
        </div>
      </div>

      {/* Top route pill */}
      <div className="sp-payroll-route">
        <div className="sp-payroll-route-l">
          <div className="sp-payroll-route-k">Payroll routes to</div>
          <div className="sp-payroll-route-v">
            {preferred ? (
              <>
                <span
                  className={`sp-pm-icon ${preferredMeta?.tone || 'bank'}`}
                  aria-hidden="true"
                  style={{
                    width: 22, height: 22, fontSize: 11,
                    marginRight: 6, verticalAlign: 'middle',
                    display: 'inline-grid',
                  }}
                >
                  {preferredMeta?.icon || '·'}
                </span>
                <strong>{preferredMeta?.label || preferred}</strong>
                {preferredIdentifier && (
                  <>
                    {' · '}
                    <span className="sp-mono">{preferredIdentifier}</span>
                  </>
                )}
              </>
            ) : (
              'No payroll method set.'
            )}
          </div>
        </div>
        <button type="button" className="sp-btn sp-btn-sm" onClick={scrollToList}>
          Change
        </button>
      </div>

      <div className="sp-subsection">Methods on file</div>

      <div id="sp-payroll-picker" className="sp-pm-list">
        {/* Conceptual card row — always rendered, non-editable, non-removable */}
        <CardAlwaysOnRow />

        {!hasAnyMethodOnFile && (
          <div className="sp-empty" style={{ padding: '1rem 0.4rem' }}>
            <div className="sp-empty-title">No methods on file yet.</div>
            <div>Tap “Add a method” below to add a tip handle or payroll route.</div>
          </div>
        )}

        {/* Tip-eligible rows — only render the ones with handles on file */}
        {TIP_ELIGIBLE_METHODS.filter((m) => onFile.has(m)).map((m) => (
          <TipMethodRow
            key={m}
            kind={m}
            methods={methods}
            isPreferred={preferred === m}
            editing={editing?.kind === m ? editing : null}
            editErrors={editing?.kind === m ? editErrors : {}}
            editPlaceholder={inlinePlaceholder(m)}
            onEditStart={() => startEdit(m)}
            onEditCancel={cancelEdit}
            onEditChange={(v) => setEditing({ kind: m, value: v })}
            onEditSubmit={submitEdit}
            onRemove={() => removeMethod(m)}
            onSetPreferred={() => setPreferred(m)}
            busyEdit={busyEdit === m}
            busyRemove={busyRemove === m}
            busyPreferred={busyPreferred === m}
          />
        ))}

        {/* Direct deposit row — render whenever bank info is on file */}
        {onFile.has('direct_deposit') && (
          <DirectDepositRow
            methods={methods}
            isPreferred={preferred === 'direct_deposit'}
            editing={editing?.kind === 'direct_deposit' ? editing : null}
            editErrors={editing?.kind === 'direct_deposit' ? editErrors : {}}
            onEditStart={() => startEdit('direct_deposit')}
            onEditCancel={cancelEdit}
            onEditChange={(patch) => setEditing((prev) =>
              ({ ...(prev || { kind: 'direct_deposit' }), ...patch }))}
            onEditSubmit={submitEdit}
            onRemove={() => removeMethod('direct_deposit')}
            onSetPreferred={() => setPreferred('direct_deposit')}
            busyEdit={busyEdit === 'direct_deposit'}
            busyRemove={busyRemove === 'direct_deposit'}
            busyPreferred={busyPreferred === 'direct_deposit'}
          />
        )}

        {/* Check row — rendered only when it's the active preferred */}
        {onFile.has('check') && (
          <CheckRow
            isPreferred={preferred === 'check'}
            onSetPreferred={() => setPreferred('check')}
            onRemove={() => {
              // Removing 'check' = clear preferred. No PATCH needed; we route
              // through the same PUT endpoint with method=null. busyPreferred
              // doubles as the busy gate for both Set and Remove on check.
              if (preferred === 'check') setPreferred(null);
            }}
            busyPreferred={busyPreferred === 'check' || busyPreferred === '__null__'}
          />
        )}
      </div>

      <button
        type="button"
        className="sp-btn sp-btn-block sp-pm-add"
        onClick={() => setAddOpen(true)}
      >
        <PlusIcon size={12} />
        Add a method
      </button>

      <div className="sp-form-foot sp-pm-disclaimer">
        Card payments settle through Dr. Bartender and show up as card tips on
        your paystub. It’s your responsibility to enter handles correctly.
        Payments sent to typos are not our liability.
      </div>

      {addOpen && (
        <AddMethodModal
          methods={methods}
          onClose={() => setAddOpen(false)}
          onSuccess={handleAddSuccess}
        />
      )}
    </section>
  );
}

function Skeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }} aria-hidden="true">
      {Array.from({ length: 3 }).map((_, i) => (
        <div
          key={i}
          style={{
            height: 64,
            borderRadius: 8,
            background: 'var(--sp-bg-2)',
            border: '1px solid var(--sp-line-1)',
            opacity: 0.5,
          }}
        />
      ))}
    </div>
  );
}

function PlusIcon({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
