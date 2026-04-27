import React, { useEffect, useState } from 'react';
import api from '../../../utils/api';
import Drawer from '../Drawer';
import Icon from '../Icon';
import StatusChip from '../StatusChip';
import { fmt$fromCents, fmtDate } from '../format';
import { useToast } from '../../../context/ToastContext';

// InvoicesDrawer — read-only list of invoices for a proposal.
// Click a row → opens the public invoice page (/invoice/:token) in a new tab.
//
// Endpoint: GET /api/invoices/proposal/:proposalId → { invoices: [...] }
// amount_due / amount_paid are INTEGER CENTS (per server/db/schema.sql),
// so we render them with fmt$fromCents.
export default function InvoicesDrawer({ proposalId, open, onClose }) {
  const toast = useToast();
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !proposalId) {
      setInvoices([]);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    api.get(`/invoices/proposal/${proposalId}`)
      .then((r) => {
        if (cancelled) return;
        setInvoices(Array.isArray(r.data?.invoices) ? r.data.invoices : []);
      })
      .catch((err) => {
        if (cancelled) return;
        // eslint-disable-next-line no-console
        console.error(err);
        toast.error("Couldn't load invoices.");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [proposalId, open, toast]);

  const crumb = (
    <div className="crumb" style={{ flex: 1 }}>
      <Icon name="card" />
      <span>Invoices &amp; payments</span>
    </div>
  );

  const statusKind = (status) => {
    if (status === 'paid') return 'ok';
    if (status === 'partially_paid') return 'warn';
    if (status === 'void') return 'neutral';
    return 'neutral';
  };

  return (
    <Drawer open={open} onClose={onClose} crumb={crumb}>
      {loading && <div className="drawer-loading">Loading…</div>}
      {!loading && invoices.length === 0 && (
        <p className="empty">No invoices yet.</p>
      )}
      {!loading && invoices.length > 0 && (
        <div className="drawer-section">
          {invoices.map((inv) => (
            <a
              key={inv.id}
              href={`/invoice/${inv.token}`}
              target="_blank"
              rel="noopener noreferrer"
              className="drawer-row drawer-row-link"
            >
              <div style={{ minWidth: 0 }}>
                <div className="drawer-row-name">
                  {inv.label || `Invoice #${inv.invoice_number}`}
                </div>
                <div className="drawer-row-meta">
                  Due {fmtDate(inv.due_date && String(inv.due_date).slice(0, 10))}
                  {' · '}
                  {fmt$fromCents(inv.amount_due)}
                  {Number(inv.amount_paid) > 0 && Number(inv.amount_paid) < Number(inv.amount_due) && (
                    <> {' · '} Paid {fmt$fromCents(inv.amount_paid)}</>
                  )}
                </div>
              </div>
              <StatusChip kind={statusKind(inv.status)}>
                {inv.status || 'draft'}
              </StatusChip>
            </a>
          ))}
        </div>
      )}
    </Drawer>
  );
}
