import React, { useEffect, useState } from 'react';
import api from '../../../../utils/api';
import { PUBLIC_SITE_URL } from '../../../../utils/constants';
import Icon from '../../../../components/adminos/Icon';
import StatusChip from '../../../../components/adminos/StatusChip';

// Admin per-contractor Tip Page management.
//
// Reads tip-page state straight from the `payment` row already loaded by the
// parent (`GET /admin/users/:id` returns `payment_profiles.*`), so no dedicated
// detail endpoint is needed. After every mutation we re-fetch via the parent's
// reload callback so the parent stays the source of truth.

const PAY_METHODS = [
  ['venmo', 'Venmo'],
  ['cashapp', 'Cash App'],
  ['paypal', 'PayPal'],
  ['check', 'Check'],
  ['direct_deposit', 'Direct deposit'],
  ['other', 'Other'],
];

export default function TipPageTab({ userId, payment, profile, onChanged }) {
  const [edit, setEdit] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // Reset the edit buffer whenever a fresh payment row arrives (e.g. after save)
  useEffect(() => { setEdit({}); }, [payment?.updated_at, payment?.user_id]);

  const url = payment?.tip_page_token
    ? `${PUBLIC_SITE_URL}/tip/${payment.tip_page_token}`
    : null;
  const active = !!payment?.tip_page_active;
  const stripeUrl = payment?.stripe_payment_link_url || null;
  const venmo = payment?.venmo_handle || '';
  const cashapp = payment?.cashapp_handle || '';
  const paypal = payment?.paypal_url || '';
  const payMethod = payment?.preferred_payment_method || '';

  const run = async (fn) => {
    setBusy(true);
    setErr('');
    try {
      await fn();
      if (onChanged) await onChanged();
    } catch (e) {
      setErr(e.message || 'Action failed.');
    } finally {
      setBusy(false);
    }
  };

  const regenerate = () => {
    if (!window.confirm('This retires the current Stripe link. Customers mid-payment may see an error. Continue?')) return;
    run(() => api.post(`/admin/contractors/${userId}/tip-page/regenerate-stripe`));
  };

  const rotateToken = () => {
    if (!window.confirm(
      'WARNING: This issues a NEW public URL and a NEW Stripe link. Printed QR cards using the OLD URL will STOP WORKING IMMEDIATELY. ' +
      'Any payment sessions in flight on the old link will likely fail. ' +
      'Use only when the existing URL is compromised (printed card was photographed, screenshot leaked, etc.). ' +
      'Continue?'
    )) return;
    run(() => api.post(`/admin/contractors/${userId}/tip-page/rotate-token`));
  };

  const generate = () => run(() => api.post(`/admin/contractors/${userId}/tip-page/generate-stripe`));

  const deactivate = () => {
    if (!window.confirm('Deactivate this tip page? The public URL will stop working.')) return;
    run(() => api.post(`/admin/contractors/${userId}/tip-page/deactivate`));
  };

  const activate = () => run(() => api.post(`/admin/contractors/${userId}/tip-page/activate`));

  const saveEdits = () => {
    if (Object.keys(edit).length === 0) return;
    run(async () => {
      await api.patch(`/admin/contractors/${userId}/tip-page`, edit);
      setEdit({});
    });
  };

  const editChanged = Object.keys(edit).length > 0;
  const displayName = profile?.preferred_name || 'this contractor';

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px', gap: 'var(--gap)' }}>
      {/* Main column */}
      <div className="vstack" style={{ gap: 'var(--gap)' }}>
        {err && <div className="chip danger">{err}</div>}

        {/* Page status */}
        <div className="card">
          <div className="card-head">
            <h3>Tip page</h3>
            <StatusChip kind={active ? 'ok' : 'danger'}>{active ? 'Active' : 'Inactive'}</StatusChip>
          </div>
          <div className="card-body">
            <dl className="dl">
              <dt>Public URL</dt>
              <dd>
                {url
                  ? <a href={url} target="_blank" rel="noopener noreferrer" className="mono">{url}</a>
                  : <span className="muted tiny">No tip page token yet — generate a Stripe link to provision one.</span>}
              </dd>
              <dt>Stripe link</dt>
              <dd>
                {stripeUrl
                  ? <a href={stripeUrl} target="_blank" rel="noopener noreferrer">View on Stripe</a>
                  : <StatusChip kind="danger">Missing</StatusChip>}
              </dd>
            </dl>
          </div>
        </div>

        {/* Handles */}
        <div className="card">
          <div className="card-head">
            <h3>Handles (admin override)</h3>
            {editChanged && (
              <div className="hstack" style={{ gap: 4 }}>
                <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setEdit({})}>Reset</button>
                <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={saveEdits}>
                  {busy ? 'Saving…' : 'Save'}
                </button>
              </div>
            )}
          </div>
          <div className="card-body">
            <p className="tiny muted" style={{ marginBottom: 12 }}>
              These appear as alternative tip options on {displayName}'s public tip page. Stripe is always primary.
            </p>
            <div className="vstack" style={{ gap: 10 }}>
              <div>
                <div className="meta-k" style={{ marginBottom: 4 }}>Venmo handle</div>
                <input
                  className="input"
                  placeholder="@username"
                  value={edit.venmo_handle ?? venmo}
                  onChange={(e) => setEdit(s => ({ ...s, venmo_handle: e.target.value }))}
                />
              </div>
              <div>
                <div className="meta-k" style={{ marginBottom: 4 }}>Cash App handle</div>
                <input
                  className="input"
                  placeholder="$cashtag"
                  value={edit.cashapp_handle ?? cashapp}
                  onChange={(e) => setEdit(s => ({ ...s, cashapp_handle: e.target.value }))}
                />
              </div>
              <div>
                <div className="meta-k" style={{ marginBottom: 4 }}>PayPal URL</div>
                <input
                  className="input"
                  placeholder="https://paypal.me/username"
                  value={edit.paypal_url ?? paypal}
                  onChange={(e) => setEdit(s => ({ ...s, paypal_url: e.target.value }))}
                />
              </div>
              <div>
                <div className="meta-k" style={{ marginBottom: 4 }}>Payroll method (how DRB pays them)</div>
                <select
                  className="input"
                  value={edit.preferred_payment_method ?? payMethod}
                  onChange={(e) => setEdit(s => ({ ...s, preferred_payment_method: e.target.value }))}
                >
                  <option value="">— not set —</option>
                  {PAY_METHODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Sidebar — actions */}
      <div className="vstack" style={{ gap: 'var(--gap)' }}>
        <div className="card">
          <div className="card-head"><h3>Stripe link</h3></div>
          <div className="card-body vstack" style={{ gap: 8 }}>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={busy || !!stripeUrl}
              onClick={generate}
              title={stripeUrl ? 'A Stripe link already exists — use Regenerate to rotate it.' : ''}
            >
              <Icon name="plus" size={11} />Generate Stripe link
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy || !stripeUrl}
              onClick={regenerate}
            >
              Regenerate Stripe link
            </button>
            <p className="tiny muted" style={{ marginTop: 4 }}>
              Regenerate retires the current Payment Link and creates a new one. The QR token (printed signage URL) does not change.
            </p>
          </div>
        </div>

        <div className="card">
          <div className="card-head"><h3>Page status</h3></div>
          <div className="card-body vstack" style={{ gap: 8 }}>
            {active ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                style={{ color: 'hsl(var(--danger-h) var(--danger-s) 65%)' }}
                disabled={busy}
                onClick={deactivate}
              >
                Deactivate tip page
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={busy || !payment?.tip_page_token}
                onClick={activate}
              >
                <Icon name="check" size={11} />Activate tip page
              </button>
            )}
            <p className="tiny muted">
              Deactivating disables the public URL and pauses the Stripe link. Reactivating restores both — the token (and printed QR) is preserved.
            </p>
          </div>
        </div>

        {/* Emergency rotation — visually separated to discourage accidental clicks. */}
        <div className="card">
          <div className="card-head"><h3>Emergency rotation</h3></div>
          <div className="card-body vstack" style={{ gap: 8 }}>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ color: 'hsl(var(--danger-h) var(--danger-s) 65%)' }}
              disabled={busy || !payment?.tip_page_token}
              onClick={rotateToken}
            >
              Rotate URL (new token + Stripe link)
            </button>
            <p className="tiny muted">
              Issues a fresh public URL AND fresh Stripe link. Old printed QRs stop working. Use only if the existing URL is compromised — otherwise prefer Regenerate Stripe link, which preserves the token.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
