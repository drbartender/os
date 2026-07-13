import React, { useCallback, useEffect, useState } from 'react';
import api from '../../../utils/api';
import { useToast } from '../../../context/ToastContext';
import { fmt$fromCents } from '../../../components/adminos/format';

// 1099 tax-totals tab (staff-payment-import spec 2026-07-10 §8.3). Per-person
// calendar-year totals blending the imported ledger (grouped by paid_on year)
// with OS payouts (grouped by paid_at year, constructive receipt). Per-person
// include/exclude toggle persists users.exclude_from_1099; CSV export for the
// January filing workflow.

const PLATFORM_LABELS = {
  venmo: 'Venmo', cashapp: 'Cash App', zelle: 'Zelle',
  ach: 'ACH', paypal: 'PayPal', cash_other: 'Cash / other',
};

const CURRENT_YEAR = new Date().getFullYear();
const YEAR_OPTIONS = [];
for (let y = CURRENT_YEAR; y >= 2024; y -= 1) YEAR_OPTIONS.push(y);

// platforms is { platform: cents }. Build the tooltip breakdown string.
function platformTitle(platforms) {
  const entries = Object.entries(platforms || {});
  if (entries.length === 0) return 'No imported platform breakdown';
  return entries
    .sort((a, b) => b[1] - a[1])
    .map(([p, cents]) => `${PLATFORM_LABELS[p] || p}: ${fmt$fromCents(cents)}`)
    .join(' · ');
}

// Cents → dollar string, formatted only at this edge (money stays integer cents
// everywhere upstream).
function dollarsFromCents(cents) {
  return (Number(cents || 0) / 100).toFixed(2);
}

// Minimal CSV-cell escaping + formula-injection guard. Contractor-controlled
// values (r.name) starting with = + - @ tab or CR would execute as a formula in
// Excel/Sheets, so we neutralize them with a leading apostrophe before quoting.
function csvCell(v) {
  let s = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default function TaxTotalsTab() {
  const toast = useToast();
  const [year, setYear] = useState(CURRENT_YEAR);
  const [rows, setRows] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  // userId whose exclude PATCH is in flight — that row's toggle is disabled.
  const [pendingUser, setPendingUser] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(false);
    api.get(`/admin/payroll/tax-totals?year=${year}`)
      .then(r => setRows(r.data.rows || []))
      .catch(() => { setError(true); setRows(null); })
      .finally(() => setLoading(false));
  }, [year]);

  useEffect(() => { load(); }, [load]);

  const toggleExclude = async (row) => {
    const next = !row.exclude_from_1099;
    setPendingUser(row.user_id);
    // Optimistic flip; restore the prior value on failure.
    setRows(prev => (prev || []).map(r => (
      r.user_id === row.user_id ? { ...r, exclude_from_1099: next } : r
    )));
    try {
      await api.patch(`/admin/payroll/tax-totals/${row.user_id}/exclude`, { exclude: next });
    } catch (err) {
      setRows(prev => (prev || []).map(r => (
        r.user_id === row.user_id ? { ...r, exclude_from_1099: row.exclude_from_1099 } : r
      )));
      toast.error(err.response?.data?.error || err.message || 'Could not update exclusion.');
    } finally {
      setPendingUser(null);
    }
  };

  const exportCsv = () => {
    const list = rows || [];
    const lines = [['name', 'year', 'total_dollars', 'excluded'].join(',')];
    for (const r of list) {
      lines.push([
        csvCell(r.name),
        year,
        dollarsFromCents(r.total_cents),
        r.exclude_from_1099 ? 'yes' : 'no',
      ].join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `1099-totals-${year}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const hasRows = Array.isArray(rows) && rows.length > 0;

  return (
    <div className="vstack" style={{ gap: 'var(--gap)' }}>
      <div className="hstack" style={{ gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <div className="hstack" style={{ gap: 6, alignItems: 'center' }}>
          <span className="tiny muted">Tax year</span>
          <select className="select" value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {YEAR_OPTIONS.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={exportCsv}
          disabled={!hasRows}
        >
          Export CSV
        </button>
      </div>

      <div className="tiny muted">
        1099-NEC calendar-year totals. Imported ledger grouped by payment date; OS payroll by
        paid date (constructive receipt). Excluded people (foreign contractors on W-8BEN) are not
        counted toward a 1099.
      </div>

      {loading && <div className="muted">Loading…</div>}

      {!loading && error && (
        <div className="card">
          <div className="card-body">
            <span className="chip danger">Couldn't load tax totals.</span>
            <button type="button" className="btn btn-ghost btn-sm" style={{ marginLeft: 8 }} onClick={load}>
              Retry
            </button>
          </div>
        </div>
      )}

      {!loading && !error && rows !== null && rows.length === 0 && (
        <div className="card"><div className="card-body muted">No payments recorded for {year}.</div></div>
      )}

      {!loading && !error && hasRows && (
        <div className="card" style={{ overflow: 'hidden' }}>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Name</th>
                  <th className="num">Imported</th>
                  <th className="num">OS payroll</th>
                  <th className="num">Total</th>
                  <th>Platforms</th>
                  <th>1099</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const excluded = r.exclude_from_1099;
                  const pending = pendingUser === r.user_id;
                  const platformKeys = Object.keys(r.platforms || {});
                  return (
                    <tr key={r.user_id} className={excluded ? 'tax-row-excluded' : ''}>
                      <td><strong>{r.name}</strong></td>
                      <td className="num muted">{fmt$fromCents(r.ledger_cents)}</td>
                      <td className="num muted">{fmt$fromCents(r.payout_cents)}</td>
                      <td className="num">
                        <strong className={excluded ? 'tax-total-struck' : ''}>
                          {fmt$fromCents(r.total_cents)}
                        </strong>
                      </td>
                      <td className="tiny muted" title={platformTitle(r.platforms)}>
                        {platformKeys.length
                          ? platformKeys.map(p => PLATFORM_LABELS[p] || p).join(', ')
                          : '—'}
                      </td>
                      <td className="shrink tax-toggle-cell">
                        <label className="tax-toggle">
                          <input
                            type="checkbox"
                            checked={!excluded}
                            disabled={pending}
                            aria-label={`${excluded ? 'Excluded from' : 'Included in'} 1099 - ${r.name}`}
                            onChange={() => toggleExclude(r)}
                          />
                          <span className="tiny">{excluded ? 'Excluded' : 'Included'}</span>
                        </label>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
