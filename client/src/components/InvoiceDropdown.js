import React, { useState, useEffect } from 'react';
import api from '../utils/api';

function formatCurrency(cents) {
  if (cents == null) return '$0.00';
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

/**
 * Dropdown showing invoices for a proposal.
 * @param {number|string} props.proposalId - The proposal ID (admin mode)
 * @param {string} [props.proposalToken] - The proposal token (client mode)
 * @param {boolean} [props.isClient] - If true, uses client auth endpoint
 * @param {string} [props.clientToken] - JWT for client auth header
 */
export default function InvoiceDropdown({ proposalId, proposalToken, isClient = false, clientToken }) {
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const fetchInvoices = async () => {
      try {
        let res;
        if (isClient && proposalToken) {
          const headers = clientToken ? { Authorization: `Bearer ${clientToken}` } : {};
          res = await api.get(`/invoices/client/${proposalToken}`, { headers });
        } else if (proposalId) {
          res = await api.get(`/invoices/proposal/${proposalId}`);
        } else {
          setLoading(false);
          return;
        }
        if (!cancelled) setInvoices(res.data.invoices || []);
      } catch (err) {
        console.error('Failed to load invoices:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchInvoices();
    return () => { cancelled = true; };
  }, [proposalId, proposalToken, isClient, clientToken]);

  if (loading || invoices.length === 0) return null;

  return (
    <div className="invoice-dropdown-wrapper">
      <button
        className="section-toggle"
        onClick={() => setOpen(!open)}
        style={{ marginTop: '0.75rem' }}
      >
        {open ? 'Hide Invoices' : `Invoices (${invoices.length})`}
      </button>
      {open && (
        <div className="invoice-dropdown-list" style={{ marginTop: '0.5rem' }}>
          {invoices.map(inv => {
            const isPaid = inv.status === 'paid';
            const isPartial = inv.status === 'partially_paid';
            const color = isPaid ? 'var(--sage)' : 'var(--rust)';
            const statusLabel = isPaid ? 'Paid' : isPartial ? 'Partial' : 'Due';
            const displayAmount = isPaid ? inv.amount_paid : inv.amount_due;

            return (
              <a
                key={inv.id}
                href={`/invoice/${inv.token}`}
                target="_blank"
                rel="noopener noreferrer"
                className="invoice-dropdown-item"
                style={{ color, textDecoration: 'none' }}
              >
                <span className="invoice-dropdown-number">
                  {inv.invoice_number} · {inv.label}
                </span>
                <span className="invoice-dropdown-amount">
                  {formatCurrency(displayAmount)} — {statusLabel}
                </span>
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}
