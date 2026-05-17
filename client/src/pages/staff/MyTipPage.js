import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';
import './MyTipPage.css';

const PAY_METHODS = [
  ['venmo', 'Venmo'],
  ['cashapp', 'Cash App'],
  ['paypal', 'PayPal'],
  ['check', 'Check'],
  ['direct_deposit', 'Direct deposit'],
  ['other', 'Other'],
];
const METHOD_LABEL = Object.fromEntries(PAY_METHODS);

export default function MyTipPage() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [tips, setTips] = useState([]);
  const [loadErr, setLoadErr] = useState(false);
  const [edit, setEdit] = useState(null);          // null until loaded
  const [savingHandles, setSavingHandles] = useState(false);
  const [savingMethod, setSavingMethod] = useState(false);
  const [editingMethod, setEditingMethod] = useState(false);
  const [copied, setCopied] = useState(false);

  function hydrate(d) {
    setData(d);
    setEdit({
      preferred_name: d.preferred_name || '',
      venmo_handle: d.venmo_handle || '',
      cashapp_handle: d.cashapp_handle || '',
      paypal_url: d.paypal_url || '',
      preferred_payment_method: d.preferred_payment_method || '',
    });
  }

  useEffect(() => {
    api.get('/me/tip-page')
      .then(r => hydrate(r.data))
      .catch(() => { setLoadErr(true); toast.error("Couldn't load your tip page. Try refreshing."); });
    api.get('/me/tips')
      .then(r => setTips(r.data.tips || []))
      .catch(() => { /* tips are secondary; page still usable */ });
    // toast is stable from the provider; adding it would retrigger on hot-reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveHandles(e) {
    e.preventDefault();
    setSavingHandles(true);
    try {
      await api.patch('/me/tip-page', {
        preferred_name: edit.preferred_name,
        venmo_handle: edit.venmo_handle,
        cashapp_handle: edit.cashapp_handle,
        paypal_url: edit.paypal_url,
      });
      const r = await api.get('/me/tip-page');
      hydrate(r.data);
      toast.success('Saved.');
    } catch (err) {
      toast.error(err?.message || "Couldn't save. Try again.");
    } finally {
      setSavingHandles(false);
    }
  }

  async function saveMethod() {
    setSavingMethod(true);
    try {
      await api.patch('/me/tip-page', { preferred_payment_method: edit.preferred_payment_method });
      const r = await api.get('/me/tip-page');
      hydrate(r.data);
      setEditingMethod(false);
      toast.success('Payout method updated.');
    } catch (err) {
      toast.error(err?.message || "Couldn't update. Try again.");
    } finally {
      setSavingMethod(false);
    }
  }

  function copyUrl() {
    if (!data?.url) return;
    navigator.clipboard.writeText(data.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (loadErr && !data) {
    return (
      <div className="mtp">
        <div className="mtp-state">Couldn't load your tip page. Refresh the page to try again.</div>
      </div>
    );
  }
  if (!data || !edit) {
    return <div className="mtp"><div className="mtp-state">Loading your tip page…</div></div>;
  }

  const previewMethods = [
    edit.venmo_handle && ['Venmo', `@${edit.venmo_handle}`],
    edit.cashapp_handle && ['Cash App', `$${edit.cashapp_handle}`],
    edit.paypal_url && ['PayPal', edit.paypal_url.replace(/^https?:\/\//, '')],
    data.has_stripe_link && ['Credit Card', 'Apple Pay · Google Pay'],
  ].filter(Boolean);

  return (
    <div className="mtp">
      <h1>My Tip Page</h1>
      <p className="mtp-sub">Your tips, your handles, your money — manage it all here.</p>

      {/* ── Your tip page ── */}
      <section className="mtp-card">
        <h2><span>Your tip page</span><span className="mtp-kicker">Public</span></h2>
        {data.url ? (
          <>
            <div className="mtp-url">
              <code>{data.url}</code>
              <button type="button" className="mtp-btn" onClick={copyUrl}>
                {copied ? 'Copied!' : 'Copy link'}
              </button>
            </div>
            <ul className="mtp-preview-list">
              {previewMethods.length === 0 ? (
                <li className="mtp-empty">No tip options yet — add a handle below and it appears here.</li>
              ) : previewMethods.map(([label, sub]) => (
                <li key={label}><span>{label}</span><span style={{ color: 'var(--mtp-muted)' }}>{sub}</span></li>
              ))}
            </ul>
            {data.has_stripe_link ? (
              <div className="mtp-row-actions">
                <Link to="/my-tip-page/print" className="mtp-btn">Print my QR card</Link>
              </div>
            ) : (
              <p className="mtp-note">Your card-payment link isn't ready yet — contact an admin to generate it. Your other handles still work.</p>
            )}
          </>
        ) : (
          <p className="mtp-note">Your tip page isn't active yet. Finish onboarding and an admin will switch it on.</p>
        )}
      </section>

      {/* ── How you get paid ── */}
      <section className="mtp-card">
        <h2><span>How you get paid</span><span className="mtp-kicker">Payroll</span></h2>
        {editingMethod ? (
          <>
            <div className="mtp-field">
              <label htmlFor="mtp-method">Pay me out via</label>
              <select
                id="mtp-method"
                value={edit.preferred_payment_method}
                onChange={e => setEdit(s => ({ ...s, preferred_payment_method: e.target.value }))}
              >
                <option value="">Select a method…</option>
                {PAY_METHODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div className="mtp-row-actions">
              <button type="button" className="mtp-btn" disabled={savingMethod || !edit.preferred_payment_method} onClick={saveMethod}>
                {savingMethod ? 'Saving…' : 'Save method'}
              </button>
              <button
                type="button"
                className="mtp-btn ghost"
                disabled={savingMethod}
                onClick={() => { setEditingMethod(false); setEdit(s => ({ ...s, preferred_payment_method: data.preferred_payment_method || '' })); }}
              >
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            <p style={{ margin: 0, fontSize: '1.05rem' }}>
              {data.preferred_payment_method
                ? <strong>{METHOD_LABEL[data.preferred_payment_method] || data.preferred_payment_method}</strong>
                : <span style={{ color: 'var(--mtp-muted)' }}>No payout method on file yet.</span>}
            </p>
            <div className="mtp-row-actions">
              <button type="button" className="mtp-btn ghost" onClick={() => setEditingMethod(true)}>
                {data.preferred_payment_method ? 'Change payout method' : 'Set payout method'}
              </button>
            </div>
          </>
        )}
        <div className="mtp-reassure">
          <span aria-hidden="true">🔒</span>
          <span>This is how Dr. Bartender sends your wages and pooled tips. Encrypted, never shared outside DRB.</span>
        </div>
      </section>

      {/* ── Tip handles ── */}
      <section className="mtp-card">
        <h2><span>Tip handles</span><span className="mtp-kicker">Optional</span></h2>
        <p className="mtp-note" style={{ marginTop: 0, marginBottom: 14 }}>
          These only affect your public tip page and printed QR card. Add, change, or
          clear them anytime — leaving one blank simply hides it.
        </p>
        <form onSubmit={saveHandles}>
          <div className="mtp-field">
            <label htmlFor="mtp-name">Preferred name</label>
            <input id="mtp-name" required value={edit.preferred_name}
              onChange={e => setEdit(s => ({ ...s, preferred_name: e.target.value }))} />
          </div>
          <div className="mtp-field">
            <label htmlFor="mtp-venmo">Venmo handle</label>
            <input id="mtp-venmo" placeholder="yourname" value={edit.venmo_handle}
              onChange={e => setEdit(s => ({ ...s, venmo_handle: e.target.value }))} />
          </div>
          <div className="mtp-field">
            <label htmlFor="mtp-cashapp">Cash App handle</label>
            <input id="mtp-cashapp" placeholder="yourname" value={edit.cashapp_handle}
              onChange={e => setEdit(s => ({ ...s, cashapp_handle: e.target.value }))} />
          </div>
          <div className="mtp-field">
            <label htmlFor="mtp-paypal">PayPal URL</label>
            <input id="mtp-paypal" placeholder="paypal.me/yourname" value={edit.paypal_url}
              onChange={e => setEdit(s => ({ ...s, paypal_url: e.target.value }))} />
          </div>
          <div className="mtp-row-actions">
            <button type="submit" className="mtp-btn" disabled={savingHandles}>
              {savingHandles ? 'Saving…' : 'Save handles'}
            </button>
          </div>
        </form>
      </section>

      {/* ── Tips earned ── */}
      <section className="mtp-card">
        <h2><span>Tips earned</span><span className="mtp-kicker">This month</span></h2>
        <p className="mtp-tips-total">${((data.tips_this_month_cents || 0) / 100).toFixed(2)}</p>
        <p className="mtp-note">
          Only the Credit Card path goes through Stripe and shows here. Venmo, Cash App,
          and PayPal taps go straight to your account, so they aren't counted. Stripe
          tips are pooled with co-workers per event and paid out via your next payroll —
          the final amount may differ.
        </p>
        {tips.length === 0 ? (
          <p className="mtp-note" style={{ marginTop: 12 }}>No card tips yet. Print your QR and bring it to your next event.</p>
        ) : (
          <table className="mtp-table">
            <thead><tr><th>Amount</th><th>Date</th><th>Source</th></tr></thead>
            <tbody>
              {tips.map(t => (
                <tr key={t.id}>
                  <td>${(t.amount_cents / 100).toFixed(2)}</td>
                  <td>{new Date(t.tipped_at).toLocaleString()}</td>
                  <td>via Stripe</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
