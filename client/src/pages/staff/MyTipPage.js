import React, { useEffect, useState } from 'react';
import api from '../../utils/api';

const PAY_METHODS = [
  ['venmo', 'Venmo'],
  ['cashapp', 'Cash App'],
  ['paypal', 'PayPal'],
  ['check', 'Check'],
  ['direct_deposit', 'Direct deposit'],
  ['other', 'Other'],
];

export default function MyTipPage() {
  const [data, setData] = useState(null);
  const [tips, setTips] = useState([]);
  const [edit, setEdit] = useState({});
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.get('/me/tip-page').then(r => {
      setData(r.data);
      setEdit({
        preferred_name: r.data.preferred_name || '',
        venmo_handle: r.data.venmo_handle || '',
        cashapp_handle: r.data.cashapp_handle || '',
        paypal_url: r.data.paypal_url || '',
        preferred_payment_method: r.data.preferred_payment_method || '',
      });
    });
    api.get('/me/tips').then(r => setTips(r.data.tips || []));
  }, []);

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.patch('/me/tip-page', edit);
      const r = await api.get('/me/tip-page');
      setData(r.data);
    } finally {
      setSaving(false);
    }
  }

  function copyUrl() {
    if (!data || !data.url) return;
    navigator.clipboard.writeText(data.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (!data) return <p>Loading…</p>;

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: 24 }}>
      <h1>My Tip Page</h1>

      {/* URL + copy */}
      {data.url ? (
        <section style={{ marginBottom: 24 }}>
          <h2>Your tip page</h2>
          <code style={{ fontSize: 16 }}>{data.url}</code>
          <button onClick={copyUrl} style={{ marginLeft: 12 }}>
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </section>
      ) : (
        <p><em>Your tip page is not yet active. Complete onboarding first.</em></p>
      )}

      {/* Print card */}
      {data.has_stripe_link && data.url && (
        <section style={{ marginBottom: 24 }}>
          <h2>Print your QR card</h2>
          <p>
            Choose business card, 4×6, or 5×7 — your browser will open the print dialog
            with the right page size. Save as PDF and take it to any photo counter
            (Walmart, CVS, Walgreens) for same-day printing, ~$0.30. Or print at home.
          </p>
          <a href="/my-tip-page/print" className="btn-primary">Print my tip card</a>
        </section>
      )}

      {/* Stripe link not yet ready */}
      {!data.has_stripe_link && data.url && (
        <p><em>Your Stripe link isn't ready yet. Contact admin to generate it.</em></p>
      )}

      {/* Edit handles */}
      <section style={{ marginBottom: 24 }}>
        <h2>Edit my handles</h2>
        <form onSubmit={save}>
          <label>
            Preferred name{' '}
            <input required value={edit.preferred_name}
              onChange={e => setEdit(s => ({ ...s, preferred_name: e.target.value }))} />
          </label>

          <label>
            Venmo{' '}
            <input value={edit.venmo_handle}
              onChange={e => setEdit(s => ({ ...s, venmo_handle: e.target.value }))} />
          </label>

          <label>
            Cash App{' '}
            <input value={edit.cashapp_handle}
              onChange={e => setEdit(s => ({ ...s, cashapp_handle: e.target.value }))} />
          </label>

          <label>
            PayPal{' '}
            <input type="url" value={edit.paypal_url}
              onChange={e => setEdit(s => ({ ...s, paypal_url: e.target.value }))} />
          </label>

          <fieldset>
            <legend>Pay me out via</legend>
            {PAY_METHODS.map(([v, l]) => (
              <label key={v} style={{ display: 'block' }}>
                <input type="radio" name="ppm" value={v}
                  checked={edit.preferred_payment_method === v}
                  onChange={() => setEdit(s => ({ ...s, preferred_payment_method: v }))} />
                {' '}{l}
              </label>
            ))}
          </fieldset>

          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </form>

        <p style={{ fontSize: 14, color: '#888', marginTop: 8 }}>
          Stripe link: <strong>Managed by DRB.</strong> Contact admin to regenerate.
        </p>
      </section>

      {/* My tips */}
      <section>
        <h2>My tips</h2>
        <p>
          Tips received via your QR this month:
          {' '}<strong>${(data.tips_this_month_cents / 100).toFixed(2)}</strong>
        </p>
        <p style={{ fontSize: 14, color: '#888', fontStyle: 'italic' }}>
          These tips will be pooled with co-workers from each event and paid out via your next
          payroll. Final amount may differ from this total.
        </p>

        {tips.length === 0 ? (
          <p><em>No tips yet. Print your QR and bring it to your next event.</em></p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th align="left">Amount</th><th align="left">Date</th><th align="left">Source</th></tr></thead>
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
