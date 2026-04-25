import React, { useState } from 'react';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';
import InvoiceDropdown from '../../components/InvoiceDropdown';
import Icon from '../../components/adminos/Icon';
import StatusChip from '../../components/adminos/StatusChip';
import { fmt$cents } from '../../components/adminos/format';

// Self-contained payment panel for ProposalDetail's right rail.
// Owns: balance due date editor, charge-balance button, payment-link generation,
// record-payment form, invoice list + create form. Calls onUpdate after any
// mutation that changes proposal state so the parent can reload.
export default function ProposalDetailPaymentPanel({ proposal, onUpdate }) {
  const toast = useToast();

  const totalPrice = Number(proposal.total_price || 0);
  const amountPaid = Number(proposal.amount_paid || 0);
  const balanceDue = totalPrice - amountPaid;
  const isFullyPaid = ['balance_paid', 'confirmed', 'completed'].includes(proposal.status);
  const isDepositPaid = proposal.status === 'deposit_paid';
  const canGeneratePaymentLink = !['deposit_paid', 'balance_paid', 'confirmed', 'completed'].includes(proposal.status);
  const canRecordPayment = !['balance_paid', 'confirmed', 'completed'].includes(proposal.status);

  // Balance due date
  const [balanceDueDate, setBalanceDueDate] = useState(
    proposal.balance_due_date ? proposal.balance_due_date.slice(0, 10) : ''
  );
  const [savingDueDate, setSavingDueDate] = useState(false);

  // Charge balance (autopay)
  const [chargingBalance, setChargingBalance] = useState(false);
  const [chargeResult, setChargeResult] = useState('');

  // Generate payment link
  const [paymentLinkUrl, setPaymentLinkUrl] = useState('');
  const [generatingLink, setGeneratingLink] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [linkError, setLinkError] = useState('');

  // Record outside payment
  const [showRecordPayment, setShowRecordPayment] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [paymentPaidInFull, setPaymentPaidInFull] = useState(false);
  const [recordingPayment, setRecordingPayment] = useState(false);

  // Invoices
  const [invoiceRefreshKey, setInvoiceRefreshKey] = useState(0);
  const [showCreateInvoice, setShowCreateInvoice] = useState(false);
  const [newInvoiceLabel, setNewInvoiceLabel] = useState('');
  const [newInvoiceAmount, setNewInvoiceAmount] = useState('');
  const [newInvoiceDueDate, setNewInvoiceDueDate] = useState('');
  const [creatingInvoice, setCreatingInvoice] = useState(false);

  const saveBalanceDueDate = async () => {
    if (!balanceDueDate) return;
    setSavingDueDate(true);
    try {
      await api.patch(`/proposals/${proposal.id}/balance-due-date`, { balance_due_date: balanceDueDate });
      toast.success('Balance due date saved.');
      onUpdate?.();
    } catch (err) {
      toast.error(err.message || 'Failed to save due date.');
    } finally {
      setSavingDueDate(false);
    }
  };

  const chargeBalance = async () => {
    setChargingBalance(true);
    setChargeResult('');
    try {
      const res = await api.post(`/stripe/charge-balance/${proposal.id}`);
      setChargeResult(`Charged ${fmt$cents(res.data.amount / 100)} successfully.`);
      onUpdate?.();
    } catch (err) {
      setChargeResult(err.message || 'Failed to charge balance.');
    } finally {
      setChargingBalance(false);
    }
  };

  const generatePaymentLink = async () => {
    setGeneratingLink(true);
    setLinkError('');
    try {
      const res = await api.post(`/stripe/payment-link/${proposal.id}?token=${proposal.token}`);
      setPaymentLinkUrl(res.data.url);
    } catch (err) {
      setLinkError(err.message || 'Failed to generate payment link. Check Stripe env vars in Render.');
    } finally {
      setGeneratingLink(false);
    }
  };

  const copyPaymentLink = () => {
    navigator.clipboard.writeText(paymentLinkUrl).then(() => {
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    });
  };

  const recordPayment = async () => {
    if (!paymentPaidInFull && (!paymentAmount || Number(paymentAmount) <= 0)) {
      toast.error('Please enter a valid amount.');
      return;
    }
    setRecordingPayment(true);
    try {
      await api.post(`/proposals/${proposal.id}/record-payment`, {
        amount: paymentPaidInFull ? undefined : Number(paymentAmount),
        paid_in_full: paymentPaidInFull,
        method: paymentMethod,
      });
      const amountStr = fmt$cents(paymentPaidInFull ? balanceDue : Number(paymentAmount));
      toast.success(`Payment of ${amountStr} recorded.`);
      setShowRecordPayment(false);
      setPaymentAmount('');
      setPaymentPaidInFull(false);
      onUpdate?.();
    } catch (err) {
      toast.error(err.message || 'Failed to record payment.');
    } finally {
      setRecordingPayment(false);
    }
  };

  const handleCreateInvoice = async () => {
    if (!newInvoiceLabel || !newInvoiceAmount || Number(newInvoiceAmount) <= 0) return;
    setCreatingInvoice(true);
    try {
      await api.post(`/invoices/proposal/${proposal.id}`, {
        label: newInvoiceLabel,
        amount: Number(newInvoiceAmount),
        due_date: newInvoiceDueDate || null,
      });
      setShowCreateInvoice(false);
      setNewInvoiceLabel('');
      setNewInvoiceAmount('');
      setNewInvoiceDueDate('');
      setInvoiceRefreshKey(k => k + 1);
      toast.success('Invoice created.');
    } catch (err) {
      toast.error(err.message || 'Failed to create invoice.');
    } finally {
      setCreatingInvoice(false);
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <h3>Payment</h3>
        {isFullyPaid ? (
          <StatusChip kind="ok">Paid in full</StatusChip>
        ) : balanceDue > 0 && amountPaid > 0 ? (
          <StatusChip kind="info">Deposit paid</StatusChip>
        ) : balanceDue > 0 ? (
          <StatusChip kind="warn">Balance due</StatusChip>
        ) : null}
      </div>
      <div className="card-body">
        <dl className="dl" style={{ gridTemplateColumns: '120px 1fr', margin: 0 }}>
          <dt>Total</dt><dd className="num">{fmt$cents(totalPrice)}</dd>
          <dt>Paid</dt><dd className="num">{fmt$cents(amountPaid)}</dd>
          <dt>Balance</dt>
          <dd className="num" style={{ color: balanceDue > 0 ? 'var(--ms-camel, hsl(38 60% 50%))' : '' }}>
            {fmt$cents(balanceDue)}
          </dd>
          {proposal.payment_type && (
            <>
              <dt>Type</dt>
              <dd>{proposal.payment_type === 'full' ? 'Paid in full' : 'Deposit'}</dd>
            </>
          )}
          {proposal.autopay_enrolled && (
            <>
              <dt>Autopay</dt>
              <dd><StatusChip kind="ok">Enrolled</StatusChip></dd>
            </>
          )}
        </dl>

        {/* Invoices */}
        <div style={{ marginTop: 14 }}>
          <InvoiceDropdown proposalId={proposal.id} key={invoiceRefreshKey} />
          {!showCreateInvoice ? (
            <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 8 }}
              onClick={() => setShowCreateInvoice(true)}>
              <Icon name="plus" size={11} />Create invoice
            </button>
          ) : (
            <div style={{ marginTop: 10, padding: 10, background: 'var(--bg-2)', border: '1px solid var(--line-1)', borderRadius: 4 }}>
              <div className="meta-k" style={{ marginBottom: 4 }}>New invoice</div>
              <input className="input" placeholder="Label (e.g. Rush Fee)" value={newInvoiceLabel}
                onChange={e => setNewInvoiceLabel(e.target.value)}
                style={{ width: '100%', marginBottom: 6 }} />
              <input className="input" type="number" step="0.01" min="0.01" placeholder="Amount ($)"
                value={newInvoiceAmount} onChange={e => setNewInvoiceAmount(e.target.value)}
                style={{ width: '100%', marginBottom: 6 }} />
              <input className="input" type="date" value={newInvoiceDueDate}
                onChange={e => setNewInvoiceDueDate(e.target.value)}
                style={{ width: '100%', marginBottom: 8 }} />
              <div className="hstack" style={{ gap: 6 }}>
                <button type="button" className="btn btn-primary btn-sm"
                  onClick={handleCreateInvoice} disabled={creatingInvoice}>
                  {creatingInvoice ? 'Creating…' : 'Create'}
                </button>
                <button type="button" className="btn btn-ghost btn-sm"
                  onClick={() => setShowCreateInvoice(false)}>Cancel</button>
              </div>
            </div>
          )}
        </div>

        {/* Balance due date — visible after deposit is paid */}
        {isDepositPaid && (
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--line-1)' }}>
            <div className="meta-k" style={{ marginBottom: 4 }}>Balance due date</div>
            <div className="hstack" style={{ gap: 6 }}>
              <input type="date" className="input" value={balanceDueDate}
                onChange={e => setBalanceDueDate(e.target.value)}
                style={{ flex: 1 }} />
              <button type="button" className="btn btn-secondary btn-sm"
                onClick={saveBalanceDueDate} disabled={savingDueDate}>
                {savingDueDate ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        )}

        {/* Charge balance via autopay */}
        {isDepositPaid && proposal.autopay_enrolled && proposal.stripe_payment_method_id && balanceDue > 0 && (
          <div style={{ marginTop: 12 }}>
            <button type="button" className="btn btn-primary btn-sm"
              onClick={chargeBalance} disabled={chargingBalance}>
              <Icon name="dollar" size={11} />
              {chargingBalance ? 'Charging…' : `Charge balance (${fmt$cents(balanceDue)})`}
            </button>
            {chargeResult && (
              <div className="tiny" style={{
                marginTop: 6,
                color: chargeResult.includes('success') ? 'var(--ms-emerald, #15803d)' : 'var(--ms-bordeaux, #b91c1c)',
              }}>
                {chargeResult}
              </div>
            )}
          </div>
        )}

        {/* Generate payment link */}
        {canGeneratePaymentLink && (
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--line-1)' }}>
            <div className="tiny muted" style={{ marginBottom: 6 }}>
              Send the client a Stripe-hosted payment link.
            </div>
            <button type="button" className="btn btn-secondary btn-sm"
              onClick={generatePaymentLink} disabled={generatingLink}>
              <Icon name="external" size={11} />
              {generatingLink ? 'Generating…' : 'Generate payment link'}
            </button>
            {linkError && <div className="tiny" style={{ color: 'var(--ms-bordeaux, #b91c1c)', marginTop: 6 }}>{linkError}</div>}
            {paymentLinkUrl && (
              <div className="hstack" style={{ marginTop: 8, gap: 6 }}>
                <input className="input" readOnly value={paymentLinkUrl}
                  onClick={e => e.target.select()}
                  style={{ flex: 1, fontSize: 12 }} />
                <button type="button" className="btn btn-ghost btn-sm" onClick={copyPaymentLink}>
                  <Icon name="copy" size={11} />{linkCopied ? 'Copied!' : 'Copy'}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Record outside payment */}
        {canRecordPayment && (
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--line-1)' }}>
            {!showRecordPayment ? (
              <button type="button" className="btn btn-ghost btn-sm"
                onClick={() => setShowRecordPayment(true)}>
                <Icon name="pen" size={11} />Record outside payment
              </button>
            ) : (
              <div>
                <div className="meta-k" style={{ marginBottom: 6 }}>Record outside payment</div>
                <div className="vstack" style={{ gap: 6 }}>
                  <select className="select" value={paymentMethod}
                    onChange={e => setPaymentMethod(e.target.value)}>
                    <option value="cash">Cash</option>
                    <option value="venmo">Venmo</option>
                    <option value="zelle">Zelle</option>
                    <option value="check">Check</option>
                    <option value="other">Other</option>
                  </select>
                  <label className="hstack" style={{ gap: 6, fontSize: 12.5, cursor: 'pointer' }}>
                    <input type="checkbox" checked={paymentPaidInFull}
                      onChange={e => {
                        setPaymentPaidInFull(e.target.checked);
                        if (e.target.checked) setPaymentAmount('');
                      }} />
                    Paid in full ({fmt$cents(balanceDue)} remaining)
                  </label>
                  {!paymentPaidInFull && (
                    <input type="number" className="input" placeholder="Amount ($)"
                      value={paymentAmount} onChange={e => setPaymentAmount(e.target.value)}
                      min="0.01" step="0.01" />
                  )}
                  <div className="hstack" style={{ gap: 6 }}>
                    <button type="button" className="btn btn-primary btn-sm"
                      onClick={recordPayment} disabled={recordingPayment}>
                      {recordingPayment ? 'Recording…' : 'Confirm'}
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm"
                      onClick={() => setShowRecordPayment(false)}>Cancel</button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
