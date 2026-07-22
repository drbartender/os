import React, { useState, useEffect } from 'react';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';
import InvoiceDropdown from '../../components/InvoiceDropdown';
import SendModal, { describeSendResult } from '../../components/SendModal';
import NotifyConfirmModal from '../../components/comms/NotifyConfirmModal';
import isPlaceholderEmail from '../../utils/isPlaceholderEmail';
import Icon from '../../components/adminos/Icon';
import StatusChip from '../../components/adminos/StatusChip';
import { fmt$2dp } from '../../components/adminos/format';

// Self-contained payment panel for ProposalDetail's right rail.
// Owns: balance due date editor, charge-balance button, payment-link generation,
// record-payment form, invoice list + create form. Calls onUpdate after any
// mutation that changes proposal state so the parent can reload.
export default function ProposalDetailPaymentPanel({ proposal, onUpdate, onFullyRefunded }) {
  const toast = useToast();

  const totalPrice = Number(proposal.total_price || 0);
  const amountPaid = Number(proposal.amount_paid || 0);
  const balanceDue = totalPrice - amountPaid;
  // "Paid in full" needs BOTH a paid lifecycle status AND no outstanding
  // balance. A refund can leave a 'confirmed'/'completed' proposal (lifecycle
  // statuses refundHelpers.js intentionally does NOT demote) with a positive
  // balance; status alone would render a green "Paid in full" chip beside a
  // balance due. Money is the source of truth for paid-ness.
  const isFullyPaid =
    ['balance_paid', 'confirmed', 'completed'].includes(proposal.status) && balanceDue <= 0;
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
  const [receiptPrompt, setReceiptPrompt] = useState(false);
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
  // Own copy of the invoice list, just to drive the per-invoice Send/Resend
  // affordance. Keyed on the same invoiceRefreshKey the create flow and the
  // InvoiceDropdown use, so a send (draft -> sent) re-reads and re-labels here.
  const [invoices, setInvoices] = useState([]);
  const [sendInvoice, setSendInvoice] = useState(null);

  useEffect(() => {
    let alive = true;
    api.get(`/invoices/proposal/${proposal.id}`)
      .then(res => { if (alive) setInvoices(res.data.invoices || []); })
      .catch(() => { /* non-fatal: the send-invoice actions just won't render */ });
    return () => { alive = false; };
  }, [proposal.id, invoiceRefreshKey]);

  // Draft invoices offer "Send invoice"; sent-but-unpaid offer "Resend". Paid,
  // partially paid, and void invoices are never (re)sent from here.
  const sendableInvoices = invoices.filter(inv => inv.status === 'draft' || inv.status === 'sent');

  // Refund
  const [showRefund, setShowRefund] = useState(false);
  const [refundAmount, setRefundAmount] = useState('');
  const [refundReason, setRefundReason] = useState('');
  const [refundKey, setRefundKey] = useState('');
  const [issuingRefund, setIssuingRefund] = useState(false);
  const [refunds, setRefunds] = useState([]);

  useEffect(() => {
    let alive = true;
    api.get(`/stripe/refunds/${proposal.id}`)
      .then(res => { if (alive) setRefunds(res.data || []); })
      .catch(() => { /* non-fatal: history just won't render */ });
    return () => { alive = false; };
  }, [proposal.id, proposal.amount_paid, proposal.total_price]);

  // Thumbtack acquisition cost (cents) — only fetched for TT-sourced proposals,
  // null when the linked lead was never charged. Informational line in the dl.
  const [leadCostCents, setLeadCostCents] = useState(null);
  useEffect(() => {
    if (proposal.source !== 'thumbtack') return undefined;
    let alive = true;
    api.get(`/proposals/${proposal.id}/lead-cost`)
      .then(res => { if (alive) setLeadCostCents(res.data?.leadCost?.lead_price_cents ?? null); })
      .catch(() => { /* non-fatal: acquisition line just won't render */ });
    return () => { alive = false; };
  }, [proposal.id, proposal.source]);

  const openRefund = () => {
    setRefundKey(
      (window.crypto && window.crypto.randomUUID)
        ? window.crypto.randomUUID()
        : String(Date.now()) + Math.random().toString(16).slice(2)
    );
    setShowRefund(true);
  };

  const issueRefund = async () => {
    if (!refundAmount || Number(refundAmount) <= 0) { toast.error('Enter a valid amount.'); return; }
    if (!refundReason.trim()) { toast.error('A reason is required.'); return; }
    setIssuingRefund(true);
    try {
      const res = await api.post(`/stripe/refund/${proposal.id}`, {
        amount: Number(refundAmount),
        reason: refundReason.trim(),
        idempotency_key: refundKey,
      });
      toast.success(`Refunded ${fmt$2dp(res.data.refunded / 100)}.`);
      setShowRefund(false);
      setRefundAmount('');
      setRefundReason('');
      // A full refund that zeroes the balance leaves the booking demoted but still
      // live everywhere else; prompt the admin to close it (archive-with-reap for a
      // demoted booking, or the cancel dialog for a still-confirmed one). The parent
      // reads the pre-refund status to route.
      if (Number(res.data.amount_paid) <= 0 && onFullyRefunded) {
        onFullyRefunded();
      } else {
        onUpdate?.();
      }
    } catch (err) {
      toast.error(err.message || 'Refund failed.');
    } finally {
      setIssuingRefund(false);
    }
  };

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
      setChargeResult(`Charged ${fmt$2dp(res.data.amount / 100)} successfully.`);
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

  // Receipt is OPT-IN (notify-client contract, 2026-07-22): recording a
  // payment asks first. A real usable email = popup (Send receipt primary);
  // no email or a CC-import .invalid placeholder = record quietly, no popup.
  const clientEmailUsable = Boolean(proposal.client_email) && !isPlaceholderEmail(proposal.client_email);

  const recordPayment = () => {
    if (!paymentPaidInFull && (!paymentAmount || Number(paymentAmount) <= 0)) {
      toast.error('Please enter a valid amount.');
      return;
    }
    if (!clientEmailUsable) { doRecordPayment(false); return; }
    setReceiptPrompt(true);
  };

  // The popup stays mounted and busy through the POST (matches the editor's
  // pattern) and closes on completion; double-click is locked out by busy.
  const doRecordPayment = async (notifyClient) => {
    setRecordingPayment(true);
    try {
      const res = await api.post(`/proposals/${proposal.id}/record-payment`, {
        amount: paymentPaidInFull ? undefined : Number(paymentAmount),
        paid_in_full: paymentPaidInFull,
        method: paymentMethod,
        notify_client: notifyClient,
      });
      const amountStr = fmt$2dp(paymentPaidInFull ? balanceDue : Number(paymentAmount));
      toast.success(`Payment of ${amountStr} recorded.`);
      (res.data.notifications || []).forEach((n) => {
        if (n.email === 'failed') toast.error(`Recorded, but the receipt failed to send: ${n.email_error || 'unknown error'}`);
        else if (n.email === 'skipped' && n.skip_reasons?.email) toast.info(`Recorded. Receipt not sent: ${n.skip_reasons.email}`);
      });
      setShowRecordPayment(false);
      setPaymentAmount('');
      setPaymentPaidInFull(false);
      onUpdate?.();
    } catch (err) {
      toast.error(err.message || 'Failed to record payment.');
    } finally {
      setReceiptPrompt(false);
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
        {amountPaid > totalPrice ? (
          // Durable overpayment signal (§6): derived from amount_paid > total_price
          // (e.g. a price-down on a paid proposal). Admin issues the refund.
          <StatusChip kind="warn">Overpaid {fmt$2dp(amountPaid - totalPrice)}, issue a refund</StatusChip>
        ) : isFullyPaid ? (
          <StatusChip kind="ok">Paid in full</StatusChip>
        ) : balanceDue > 0 && amountPaid > 0 ? (
          <StatusChip kind="info">Deposit paid</StatusChip>
        ) : balanceDue > 0 ? (
          <StatusChip kind="warn">Balance due</StatusChip>
        ) : null}
      </div>
      <div className="card-body">
        <dl className="dl" style={{ gridTemplateColumns: '120px 1fr', margin: 0 }}>
          <dt>Total</dt><dd className="num">{fmt$2dp(totalPrice)}</dd>
          <dt>Paid</dt><dd className="num">{fmt$2dp(amountPaid)}</dd>
          {Number(proposal.external_paid) > 0 && (
            <>
              <dt>Off-platform</dt>
              <dd className="num">
                {fmt$2dp(Number(proposal.external_paid))} <span className="muted tiny">collected in CheckCherry, included in Paid</span>
              </dd>
            </>
          )}
          <dt>Balance</dt>
          <dd className="num" style={{ color: balanceDue > 0 ? 'hsl(var(--warn-h) var(--warn-s) 58%)' : '' }}>
            {fmt$2dp(balanceDue)}
          </dd>
          {leadCostCents != null && (
            <>
              <dt>Acquisition</dt>
              <dd className="num">
                {fmt$2dp(leadCostCents / 100)} <span className="muted tiny">Thumbtack lead</span>
              </dd>
            </>
          )}
          {proposal.budget_raw && (
            <>
              <dt>Stated budget</dt>
              <dd>{proposal.budget_raw}</dd>
            </>
          )}
          {/* No payment_type row: it recorded the elected arrangement (deposit vs
              pay-in-full), not money received, so it read as a status it could not
              back up ('full' is stamped at intent creation, before any charge, and
              the column defaults to 'deposit' on untouched drafts). The lifecycle
              status chip (Deposit paid / Paid in full) carries this truthfully.
              The column itself stays: invoiceLifecycle reads it to pick the
              Deposit vs Full invoice. */}
          {proposal.autopay_enrolled && (
            <>
              <dt>Autopay</dt>
              <dd><StatusChip kind="ok">Enrolled</StatusChip></dd>
            </>
          )}
        </dl>

        {/* P4 (fix #8): name the hosted minimum that bound the base price. Reads
            the stored snapshot; legacy snapshots without floor_reason render nothing. */}
        {proposal.pricing_snapshot?.floor_reason === 'guest_min' && (
          <p className="muted tiny" style={{ margin: '6px 0 0' }}>
            Small event minimum applied (billed as {proposal.pricing_snapshot.billed_guests} guests).
          </p>
        )}
        {proposal.pricing_snapshot?.floor_reason === 'dollar_min' && (
          <p className="muted tiny" style={{ margin: '6px 0 0' }}>
            Hosted minimum $550 applied.
          </p>
        )}

        {/* Invoices */}
        <div style={{ marginTop: 14 }}>
          <InvoiceDropdown proposalId={proposal.id} key={invoiceRefreshKey} />
          {sendableInvoices.length > 0 && (
            <div className="vstack" style={{ gap: 6, marginTop: 8 }}>
              {sendableInvoices.map(inv => (
                <div key={inv.id} className="hstack"
                  style={{ gap: 8, justifyContent: 'space-between', alignItems: 'center' }}>
                  <span className="tiny muted"
                    style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {inv.invoice_number} · {inv.label}
                  </span>
                  <button type="button" className="btn btn-ghost btn-sm"
                    style={{ whiteSpace: 'nowrap' }}
                    onClick={() => setSendInvoice(inv)}>
                    <Icon name="send" size={11} />{inv.status === 'draft' ? 'Send invoice' : 'Resend'}
                  </button>
                </div>
              ))}
            </div>
          )}
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
              {chargingBalance ? 'Charging…' : `Charge balance (${fmt$2dp(balanceDue)})`}
            </button>
            {chargeResult && (
              <div className="tiny" style={{
                marginTop: 6,
                color: chargeResult.includes('success') ? 'hsl(var(--ok-h) var(--ok-s) 38%)' : 'hsl(var(--danger-h) var(--danger-s) 50%)',
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
            {linkError && <div className="tiny" style={{ color: 'hsl(var(--danger-h) var(--danger-s) 50%)', marginTop: 6 }}>{linkError}</div>}
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
                    Paid in full ({fmt$2dp(balanceDue)} remaining)
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

        {/* Issue refund */}
        {amountPaid > 0 && (
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--line-1)' }}>
            {!showRefund ? (
              <button type="button" className="btn btn-ghost btn-sm" onClick={openRefund}>
                <Icon name="dollar" size={11} />Issue refund
              </button>
            ) : (
              <div>
                <div className="meta-k" style={{ marginBottom: 6 }}>Issue refund</div>
                <div className="vstack" style={{ gap: 6 }}>
                  <input type="number" className="input" placeholder="Amount ($)"
                    value={refundAmount} onChange={e => setRefundAmount(e.target.value)}
                    min="0.01" step="0.01" />
                  <textarea className="input" placeholder="Reason"
                    value={refundReason} onChange={e => setRefundReason(e.target.value)}
                    rows={2} style={{ resize: 'vertical' }} />
                  <div className="hstack" style={{ gap: 6 }}>
                    <button type="button" className="btn btn-primary btn-sm"
                      onClick={issueRefund} disabled={issuingRefund}>
                      {issuingRefund ? 'Refunding…' : 'Confirm refund'}
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm"
                      onClick={() => setShowRefund(false)}>Cancel</button>
                  </div>
                </div>
              </div>
            )}

            {refunds.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div className="meta-k" style={{ marginBottom: 4 }}>Refund history</div>
                {refunds.map(r => (
                  <div key={r.id} className="tiny" style={{ marginBottom: 4 }}>
                    <span style={{ color: 'hsl(var(--danger-h) var(--danger-s) 50%)' }}>
                      −{fmt$2dp(r.amount / 100)}
                    </span>{' '}
                    · {r.reason} ·{' '}
                    {new Date(r.created_at).toLocaleDateString('en-US', { timeZone: 'UTC' })}
                    {r.status !== 'succeeded' && <> · <em>{r.status}</em></>}
                    <div className="muted">
                      total {fmt$2dp(Number(r.total_price_before))} → {fmt$2dp(Number(r.total_price_after))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {sendInvoice && (
        <SendModal
          action="invoice_send"
          entityId={sendInvoice.id}
          title="Send Invoice"
          confirmLabel="Send Invoice"
          onClose={() => setSendInvoice(null)}
          onComplete={(results) => {
            const { level, message } = describeSendResult(results);
            toast[level](message);
            setInvoiceRefreshKey(k => k + 1);
          }}
        />
      )}
      {receiptPrompt && (
        <NotifyConfirmModal
          title="Email a receipt?"
          notices={[{
            type: 'payment_receipt',
            reasons: [`Receipt for ${fmt$2dp(paymentPaidInFull ? balanceDue : Number(paymentAmount))}`],
            composable: false,
            recipient: { name: proposal.client_name, email: proposal.client_email, phone: null },
            channels: { email: { available: true, default: true }, sms: { available: false } },
            autopay_notice: null,
            draft: null,
          }]}
          primary="send"
          sendLabel="Send receipt"
          quietLabel="Don't send"
          busy={recordingPayment}
          onCancel={() => setReceiptPrompt(false)}
          onQuiet={() => doRecordPayment(false)}
          onSend={() => doRecordPayment(true)}
        />
      )}
    </div>
  );
}
