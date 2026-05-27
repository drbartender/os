import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';
import { useAuth } from '../../context/AuthContext';

/**
 * CC-Import Review page — Section 9.2 worklist.
 *
 * Seven collapsible sections backed by `GET /admin/cc-import/review`:
 *   1. Suspected duplicates (events flagged for human review)
 *   2. Orphan payments (Payment / Refund rows that did not match a cc proposal)
 *   3. Unmatched payouts payees (stubs needing real-user link or fresh stub)
 *   4. Unmatched assigned-staff names (read-only label list from phase 3)
 *   5. Type-coercion failures (raw rows that errored during promote)
 *   6. Skipped (Bucket D) events
 *   7. Phase 0 give-ups (durable-retry rows at attempt_count >= 10)
 *
 * Action endpoints live in `server/routes/admin/ccImport/review.js`.
 */

const SECTION_DEFS = [
  { key: 'duplicates', label: 'Suspected duplicates', emptyMsg: 'No rows flagged as suspected duplicates.' },
  { key: 'orphans', label: 'Orphan payments', emptyMsg: 'No orphan payments waiting for review.' },
  { key: 'unmatchedPayees', label: 'Unmatched payouts payees', emptyMsg: 'No payouts without a payee match.' },
  { key: 'unmatchedStaff', label: 'Unmatched assigned-staff names', emptyMsg: 'All shift assignments matched a user.' },
  { key: 'errored', label: 'Type-coercion failures', emptyMsg: 'No rows in errored state.' },
  { key: 'skipped', label: 'Skipped (Bucket D)', emptyMsg: 'No skipped Bucket D events.' },
  { key: 'phase0', label: 'Phase 0 give-ups', emptyMsg: 'No phase 0 give-ups to action.' },
];

function fmtCents(cents) {
  if (cents == null) return '—';
  const n = Number(cents);
  if (!Number.isFinite(n)) return '—';
  return `$${(n / 100).toFixed(2)}`;
}

function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString();
}

function fmtTimestamp(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleString();
}

// api.js interceptor normalizes rejections to { message, code, fieldErrors, status }.
function extractError(err) {
  return err?.message || 'Unknown error';
}

function extractCode(err) {
  return err?.code;
}

// ── Section shell ──────────────────────────────────────────────────────

function SectionShell({ title, count, open, onToggle, children }) {
  return (
    <div className="card" style={{ marginBottom: 'var(--gap, 12px)' }}>
      <div
        className="card-head"
        style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12 }}
        onClick={onToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onToggle(); }}
      >
        <h3 style={{ margin: 0, fontSize: 14 }}>
          {open ? '▾' : '▸'} {title}
          {count != null && <span className="muted tiny" style={{ marginLeft: 8 }}>({count})</span>}
        </h3>
      </div>
      {open && <div className="card-body">{children}</div>}
    </div>
  );
}

// ── Search picker (used by orphan-link + unmatched-payee-link) ─────────

function SearchPicker({ endpoint, params = {}, onSelect, placeholder, renderItem }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const debRef = useRef(null);

  useEffect(() => {
    if (debRef.current) clearTimeout(debRef.current);
    if (q.trim().length < 2) {
      setItems([]);
      setError(null);
      setLoading(false);
      return;
    }
    debRef.current = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.get(endpoint, { params: { ...params, q } });
        setItems(res.data?.items || []);
      } catch (err) {
        setError(extractError(err));
        setItems([]);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => {
      if (debRef.current) clearTimeout(debRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, endpoint, JSON.stringify(params)]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <input
        type="text"
        value={q}
        placeholder={placeholder || 'Type at least 2 characters'}
        onChange={(e) => setQ(e.target.value)}
        style={{ padding: '6px 8px', border: '1px solid var(--line, #ccc)', borderRadius: 4 }}
      />
      {loading && <span className="muted tiny">Searching…</span>}
      {error && <span style={{ color: 'var(--danger, #b00020)' }} className="tiny">{error}</span>}
      {items.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, maxHeight: 220, overflowY: 'auto', border: '1px solid var(--line, #ddd)', borderRadius: 4 }}>
          {items.map((it) => (
            <li
              key={it.id}
              style={{ padding: '6px 8px', borderBottom: '1px solid var(--line, #eee)', cursor: 'pointer' }}
              onClick={() => onSelect(it)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter') onSelect(it); }}
            >
              {renderItem(it)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Section 1: Suspected duplicates ────────────────────────────────────

function DuplicatesSection({ rows, onAction }) {
  if (!rows.length) return <div className="muted">{SECTION_DEFS[0].emptyMsg}</div>;
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--line, #ddd)' }}>
          <th style={{ padding: '6px 4px' }}>Row #</th>
          <th style={{ padding: '6px 4px' }}>Title</th>
          <th style={{ padding: '6px 4px' }}>Client</th>
          <th style={{ padding: '6px 4px' }}>Candidate</th>
          <th style={{ padding: '6px 4px' }}>Actions</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <DuplicateRow key={row.id} row={row} onAction={onAction} />
        ))}
      </tbody>
    </table>
  );
}

function DuplicateRow({ row, onAction }) {
  const [busy, setBusy] = useState(false);
  const candidateId = row.import_notes?.candidate_proposal_id;
  const title = row.payload?.Title || row.payload?.['Event Title'] || '(no title)';
  const clientName = row.payload?.['Client Name'] || row.payload?.Client || '—';

  async function confirm() {
    setBusy(true);
    try {
      await onAction(async () => api.post(`/admin/cc-import/review/duplicate/${row.id}/confirm`, {}));
    } finally { setBusy(false); }
  }

  async function promote(allowEdited = false) {
    setBusy(true);
    try {
      await onAction(async () => {
        try {
          return await api.post(`/admin/cc-import/review/duplicate/${row.id}/promote`,
            allowEdited ? { confirm_candidate_edited: true } : {});
        } catch (err) {
          if (extractCode(err) === 'CC_CANDIDATE_EDITED') {
            // Re-prompt the operator with the server's explanation.
            const ok = window.confirm(
              `${extractError(err)}\n\nProceed and overwrite the human edits?`
            );
            if (!ok) return null;
            return await api.post(`/admin/cc-import/review/duplicate/${row.id}/promote`,
              { confirm_candidate_edited: true });
          }
          throw err;
        }
      });
    } finally { setBusy(false); }
  }

  return (
    <tr style={{ borderBottom: '1px solid var(--line, #eee)' }}>
      <td style={{ padding: '6px 4px' }}>{row.source_row_number}</td>
      <td style={{ padding: '6px 4px' }}>{title}</td>
      <td style={{ padding: '6px 4px' }}>{clientName}</td>
      <td style={{ padding: '6px 4px' }}>
        {candidateId ? (
          <a href={`/events/${candidateId}`} target="_blank" rel="noreferrer">#{candidateId}</a>
        ) : '—'}
      </td>
      <td style={{ padding: '6px 4px' }}>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={confirm}>Confirm duplicate</button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => promote(false)} style={{ marginLeft: 6 }}>
          Promote anyway
        </button>
      </td>
    </tr>
  );
}

// ── Section 2: Orphan payments ─────────────────────────────────────────

function OrphansSection({ rows, onAction }) {
  if (!rows.length) return <div className="muted">{SECTION_DEFS[1].emptyMsg}</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {rows.map((row) => <OrphanRow key={row.id} row={row} onAction={onAction} />)}
    </div>
  );
}

function OrphanRow({ row, onAction }) {
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState(null); // 'link' | 'dismiss' | null
  const [dismissReason, setDismissReason] = useState('');

  async function link(proposal) {
    setBusy(true);
    try {
      await onAction(async () => api.post(
        `/admin/cc-import/review/orphan-payment/${row.id}/link`,
        { proposal_id: proposal.id }
      ));
      setMode(null);
    } finally { setBusy(false); }
  }

  async function dismiss() {
    if (dismissReason.length > 2000) return;
    setBusy(true);
    try {
      await onAction(async () => api.post(
        `/admin/cc-import/review/orphan-payment/${row.id}/dismiss`,
        dismissReason ? { reason: dismissReason } : {}
      ));
      setMode(null);
      setDismissReason('');
    } finally { setBusy(false); }
  }

  return (
    <div style={{ border: '1px solid var(--line, #eee)', borderRadius: 4, padding: 10 }}>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <div><strong>{row.cc_event_title || '(no title)'}</strong> <span className="muted tiny">({row.cc_type})</span></div>
        <div className="muted tiny">Paid {fmtDate(row.paid_on)}</div>
        <div>{fmtCents(row.payment_applied_cents)}</div>
        <div className="muted tiny">{row.payment_method || '—'}</div>
        {row.reference_code && <code className="tiny">{row.reference_code}</code>}
      </div>
      <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setMode(mode === 'link' ? null : 'link')}>
          Link to proposal
        </button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setMode(mode === 'dismiss' ? null : 'dismiss')}>
          Dismiss
        </button>
      </div>
      {mode === 'link' && (
        <div style={{ marginTop: 8 }}>
          <SearchPicker
            endpoint="/admin/cc-import/search/proposals"
            onSelect={link}
            placeholder="Search by client name or cc id"
            renderItem={(p) => (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span>{p.client_name}</span>
                <span className="muted tiny">{fmtDate(p.event_date)}</span>
                <span className="muted tiny">${p.total_price}</span>
                {p.cc_id && <span className="tiny" style={{ background: 'var(--line, #eee)', padding: '1px 6px', borderRadius: 8 }}>cc</span>}
              </div>
            )}
          />
        </div>
      )}
      {mode === 'dismiss' && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <textarea
            value={dismissReason}
            onChange={(e) => setDismissReason(e.target.value)}
            placeholder="Reason (optional, up to 2000 chars)"
            maxLength={2000}
            rows={2}
            style={{ padding: 6, border: '1px solid var(--line, #ccc)', borderRadius: 4 }}
          />
          <div>
            <button type="button" className="btn" disabled={busy} onClick={dismiss}>Confirm dismiss</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Section 3: Unmatched payouts payees ────────────────────────────────

function UnmatchedPayeesSection({ rows, onAction, isAdmin }) {
  if (!rows.length) return <div className="muted">{SECTION_DEFS[2].emptyMsg}</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {rows.map((row) => <PayeeRow key={row.id} row={row} onAction={onAction} isAdmin={isAdmin} />)}
    </div>
  );
}

function PayeeRow({ row, onAction, isAdmin }) {
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [includeStubs, setIncludeStubs] = useState(false);
  const [confirmModal, setConfirmModal] = useState(null); // { user, preview }

  async function startLink(user) {
    setBusy(true);
    try {
      const res = await api.get(
        `/admin/cc-import/review/unmatched-payee/${row.id}/link-preview`,
        { params: { user_id: user.id } }
      );
      setConfirmModal({ user, preview: res.data });
    } catch (err) {
      setConfirmModal(null);
      throw err;
    } finally { setBusy(false); }
  }

  async function commitLink() {
    if (!confirmModal) return;
    setBusy(true);
    try {
      await onAction(async () => api.post(
        `/admin/cc-import/review/unmatched-payee/${row.id}/link`,
        { user_id: confirmModal.user.id }
      ));
      setConfirmModal(null);
      setPickerOpen(false);
    } finally { setBusy(false); }
  }

  async function createStub() {
    setBusy(true);
    try {
      await onAction(async () => api.post(`/admin/cc-import/review/unmatched-payee/${row.id}/create-stub`, {}));
    } finally { setBusy(false); }
  }

  return (
    <div style={{ border: '1px solid var(--line, #eee)', borderRadius: 4, padding: 10 }}>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <div><strong>{row.payee_name}</strong></div>
        <div className="muted tiny">Paid {fmtDate(row.paid_on)}</div>
        <div>{fmtCents(row.amount_cents)}</div>
        {row.reference_role && <span className="muted tiny">{row.reference_role}</span>}
        {row.category && <span className="muted tiny">{row.category}</span>}
      </div>
      <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setPickerOpen((v) => !v)}>
          Link to user
        </button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={createStub}>
          Create stub
        </button>
      </div>
      {pickerOpen && (
        <div style={{ marginTop: 8 }}>
          {isAdmin && (
            <label className="tiny" style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
              <input
                type="checkbox"
                checked={includeStubs}
                onChange={(e) => setIncludeStubs(e.target.checked)}
              />
              Include stub users in results
            </label>
          )}
          <SearchPicker
            endpoint="/admin/cc-import/search/users"
            params={isAdmin && includeStubs ? { include_stubs: 'true' } : {}}
            onSelect={(u) => startLink(u).catch((err) => {
              const code = extractCode(err);
              if (code === 'CC_TARGET_IS_STUB') {
                window.alert('Cannot link a payout to a stub user. Pick a real user.');
              } else {
                window.alert(extractError(err));
              }
            })}
            placeholder="Search by name or email"
            renderItem={(u) => (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span>{u.name}</span>
                <span className="muted tiny">{u.email}</span>
                {/^legacy_cc:/.test(u.cc_id || '') && (
                  <span className="tiny" style={{ background: 'var(--line, #eee)', padding: '1px 6px', borderRadius: 8 }}>stub</span>
                )}
              </div>
            )}
          />
        </div>
      )}
      {confirmModal && (
        <LinkConfirmModal
          payeeName={row.payee_name}
          user={confirmModal.user}
          preview={confirmModal.preview}
          onCancel={() => setConfirmModal(null)}
          onConfirm={commitLink}
          busy={busy}
        />
      )}
    </div>
  );
}

function LinkConfirmModal({ payeeName, user, preview, onCancel, onConfirm, busy }) {
  // §9.3.E pluralization — drop a clause entirely when its count is 0.
  const lines = [];
  const userLabel = user.name || user.email || `user #${user.id}`;
  if (preview.shifts_reassigned > 0) {
    lines.push(`Reassign ${preview.shifts_reassigned} shift_requests from stub to ${userLabel}.`);
  }
  if (preview.shifts_merged > 0) {
    lines.push(`Merge ${preview.shifts_merged} shifts where ${userLabel} was already approved.`);
  }
  if (preview.shifts_real_user_status_cleared > 0) {
    lines.push(`Clear ${preview.shifts_real_user_status_cleared} pending or denied rows for ${userLabel} on shifts where the stub was approved.`);
  }
  if (preview.proposals > 0) {
    lines.push(`Affects ${preview.proposals} distinct proposals.`);
  }
  if (lines.length === 0) {
    lines.push(`This stub has no shift participation. The link will just point the payout at ${userLabel}.`);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
      }}
      onClick={busy ? undefined : onCancel}
    >
      <div className="card" style={{ maxWidth: 540, width: 'calc(100% - 32px)', background: 'white' }} onClick={(e) => e.stopPropagation()}>
        <div className="card-head"><h3 style={{ margin: 0, fontSize: 16 }}>Confirm link</h3></div>
        <div className="card-body">
          <p style={{ marginTop: 0 }}>
            Linking payout for <strong>{payeeName}</strong> to <strong>{userLabel}</strong>.
          </p>
          <ul style={{ paddingLeft: 18 }}>
            {lines.map((line, i) => <li key={i}>{line}</li>)}
          </ul>
          <p className="muted tiny" style={{ margin: 0 }}>
            This rewrites shift_requests in a single transaction and writes a per-proposal activity log entry.
          </p>
        </div>
        <div className="card-body" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="button" className="btn" onClick={onConfirm} disabled={busy}>
            {busy ? 'Linking…' : 'Confirm link'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Section 4: Unmatched assigned-staff names (read-only) ──────────────

function UnmatchedStaffSection({ names }) {
  if (!names.length) return <div className="muted">{SECTION_DEFS[3].emptyMsg}</div>;
  return (
    <ul style={{ margin: 0, paddingLeft: 18 }}>
      {names.map((entry, i) => {
        const label = typeof entry === 'string' ? entry : (entry.name || JSON.stringify(entry));
        const count = typeof entry === 'object' ? entry.count : null;
        return (
          <li key={i}>
            {label}{count != null && <span className="muted tiny"> ({count})</span>}
          </li>
        );
      })}
    </ul>
  );
}

// ── Section 5: Type-coercion failures ──────────────────────────────────

function ErroredSection({ rows, onAction }) {
  if (!rows.length) return <div className="muted">{SECTION_DEFS[4].emptyMsg}</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {rows.map((row) => <ErroredRow key={row.id} row={row} onAction={onAction} />)}
    </div>
  );
}

function ErroredRow({ row, onAction }) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [payloadText, setPayloadText] = useState(() => JSON.stringify(row.payload, null, 2));
  const [jsonError, setJsonError] = useState(null);
  const errorMsg = row.import_notes?.error || row.import_notes?.message || '(no error message)';

  async function retry() {
    let override;
    if (editing && payloadText !== JSON.stringify(row.payload, null, 2)) {
      try {
        override = JSON.parse(payloadText);
      } catch (e) {
        setJsonError('Payload override is not valid JSON.');
        return;
      }
      if (typeof override !== 'object' || Array.isArray(override) || override === null) {
        setJsonError('Payload override must be a JSON object.');
        return;
      }
    }
    setJsonError(null);
    setBusy(true);
    try {
      await onAction(async () => api.post(
        `/admin/cc-import/review/errored-row/${row.id}/retry`,
        override ? { payload_override: override } : {}
      ));
      setEditing(false);
    } finally { setBusy(false); }
  }

  return (
    <div style={{ border: '1px solid var(--line, #eee)', borderRadius: 4, padding: 10 }}>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <div className="muted tiny">{row.source_entity} #{row.source_row_number}</div>
        <div style={{ color: 'var(--danger, #b00020)' }} className="tiny">{errorMsg}</div>
      </div>
      <details style={{ marginTop: 6 }}>
        <summary className="tiny muted">Payload</summary>
        {!editing ? (
          <pre style={{ background: 'var(--line, #f5f5f5)', padding: 6, fontSize: 11, overflowX: 'auto' }}>
            {JSON.stringify(row.payload, null, 2)}
          </pre>
        ) : (
          <textarea
            value={payloadText}
            onChange={(e) => setPayloadText(e.target.value)}
            rows={10}
            style={{ width: '100%', fontFamily: 'monospace', fontSize: 11, padding: 6, border: '1px solid var(--line, #ccc)', borderRadius: 4 }}
          />
        )}
        {jsonError && <div style={{ color: 'var(--danger, #b00020)' }} className="tiny">{jsonError}</div>}
      </details>
      <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setEditing((v) => !v)}>
          {editing ? 'Cancel edit' : 'Edit payload'}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={retry}>
          {editing ? 'Retry with edits' : 'Retry'}
        </button>
      </div>
    </div>
  );
}

// ── Section 6: Skipped (Bucket D) ──────────────────────────────────────

function SkippedSection({ rows, onAction }) {
  if (!rows.length) return <div className="muted">{SECTION_DEFS[5].emptyMsg}</div>;
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--line, #ddd)' }}>
          <th style={{ padding: '6px 4px' }}>Row #</th>
          <th style={{ padding: '6px 4px' }}>Client</th>
          <th style={{ padding: '6px 4px' }}>Event</th>
          <th style={{ padding: '6px 4px' }}>Date</th>
          <th style={{ padding: '6px 4px' }}>Action</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => <SkippedRow key={row.id} row={row} onAction={onAction} />)}
      </tbody>
    </table>
  );
}

function SkippedRow({ row, onAction }) {
  const [busy, setBusy] = useState(false);
  const pkg = row.payload?.Package || row.payload?.['Event Type'] || '—';
  const clientName = row.payload?.['Client Name'] || '—';
  const evtDate = row.payload?.['Event Date'] || '—';

  async function promote() {
    setBusy(true);
    try {
      await onAction(async () => api.post(`/admin/cc-import/review/skipped-event/${row.id}/promote`, {}));
    } finally { setBusy(false); }
  }

  return (
    <tr style={{ borderBottom: '1px solid var(--line, #eee)' }}>
      <td style={{ padding: '6px 4px' }}>{row.source_row_number}</td>
      <td style={{ padding: '6px 4px' }}>{clientName}</td>
      <td style={{ padding: '6px 4px' }}>{pkg}</td>
      <td style={{ padding: '6px 4px' }}>{evtDate}</td>
      <td style={{ padding: '6px 4px' }}>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={promote}>Promote anyway</button>
      </td>
    </tr>
  );
}

// ── Section 7: Phase 0 give-ups ────────────────────────────────────────

function Phase0Section({ eligible, done, onAction }) {
  if (!eligible.length && !done.length) {
    return <div className="muted">{SECTION_DEFS[6].emptyMsg}</div>;
  }
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 12 }}>
      <div>
        <h4 style={{ margin: '0 0 6px', fontSize: 13 }}>Eligible (attempt_count ≥ 10)</h4>
        {!eligible.length ? <div className="muted tiny">None.</div> : eligible.map((r) => (
          <Phase0EligibleRow key={r.id} row={r} onAction={onAction} />
        ))}
      </div>
      <div>
        <h4 style={{ margin: '0 0 6px', fontSize: 13 }}>Already actioned</h4>
        {!done.length ? <div className="muted tiny">None.</div> : done.map((r) => (
          <Phase0DoneRow key={r.id} row={r} onAction={onAction} />
        ))}
      </div>
    </div>
  );
}

function Phase0EligibleRow({ row, onAction }) {
  const [busy, setBusy] = useState(false);

  async function acceptLoss() {
    const reason = window.prompt('Reason for accepting the loss (1-500 chars):');
    if (reason == null) return; // cancelled
    const trimmed = reason.trim();
    if (trimmed.length < 1 || trimmed.length > 500) {
      window.alert('Reason must be 1-500 characters.');
      return;
    }
    setBusy(true);
    try {
      await onAction(async () => api.post(
        `/admin/cc-import/review/phase0-failure/${row.id}/accept-loss`,
        { reason: trimmed }
      ));
    } finally { setBusy(false); }
  }

  return (
    <div style={{ border: '1px solid var(--line, #eee)', borderRadius: 4, padding: 8, marginBottom: 6 }}>
      <div className="tiny" style={{ wordBreak: 'break-all' }}>{row.source_url}</div>
      <div className="muted tiny">
        {row.source_entity} · attempts {row.attempt_count} · last {fmtTimestamp(row.last_attempted_at)}
      </div>
      {row.last_error && (
        <div className="tiny" style={{ color: 'var(--danger, #b00020)' }}>{row.last_error}</div>
      )}
      <div style={{ marginTop: 6 }}>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={acceptLoss}>Accept loss</button>
      </div>
    </div>
  );
}

function Phase0DoneRow({ row, onAction }) {
  const [busy, setBusy] = useState(false);

  async function revert() {
    if (!window.confirm('Revert give-up? attempt_count will reset to 0 and phase 0 will retry.')) return;
    setBusy(true);
    try {
      await onAction(async () => api.post(`/admin/cc-import/review/phase0-failure/${row.id}/revert-give-up`, {}));
    } finally { setBusy(false); }
  }

  return (
    <div style={{ border: '1px solid var(--line, #eee)', borderRadius: 4, padding: 8, marginBottom: 6 }}>
      <div className="tiny" style={{ wordBreak: 'break-all' }}>{row.source_url}</div>
      <div className="muted tiny">
        {row.source_entity} · attempts {row.attempt_count} · given up {fmtTimestamp(row.given_up_at)}
      </div>
      {row.given_up_reason && (
        <div className="tiny">Reason: {row.given_up_reason}</div>
      )}
      <div style={{ marginTop: 6 }}>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={revert}>Revert give-up</button>
      </div>
    </div>
  );
}

// ── Page shell ─────────────────────────────────────────────────────────

export default function CcImportReviewPage() {
  const toast = useToast();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState({}); // section.key → boolean

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/admin/cc-import/review');
      setData(res.data);
      // Auto-expand non-empty sections on first / subsequent loads.
      setOpen((prev) => {
        const next = { ...prev };
        const counts = sectionCounts(res.data);
        for (const def of SECTION_DEFS) {
          if (next[def.key] === undefined) {
            next[def.key] = (counts[def.key] || 0) > 0;
          }
        }
        return next;
      });
    } catch (err) {
      setError(extractError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // onAction wraps an API call with toast handling + refresh.
  const onAction = useCallback(async (fn) => {
    try {
      const res = await fn();
      if (res === null) return; // cancelled inside the wrapper
      toast.success('Done.');
      await refresh();
    } catch (err) {
      toast.error(extractError(err));
    }
  }, [refresh, toast]);

  const counts = useMemo(() => data ? sectionCounts(data) : {}, [data]);

  const toggle = useCallback((key) => {
    setOpen((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">CC-Import review</div>
          <div className="page-subtitle">
            Operator worklist for everything the importer flagged for human review.
          </div>
        </div>
      </div>

      {data?.lastRun && (
        <div className="card" style={{ marginBottom: 'var(--gap, 12px)' }}>
          <div className="card-body">
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
              <strong>Last run</strong>
              <span>Phase {data.lastRun.phase}</span>
              <span className="muted tiny">{data.lastRun.status}</span>
              <span className="muted tiny">started {fmtTimestamp(data.lastRun.started_at)}</span>
              {data.lastRun.finished_at && (
                <span className="muted tiny">finished {fmtTimestamp(data.lastRun.finished_at)}</span>
              )}
            </div>
            {data.lastRun.error_summary && (
              <div style={{
                marginTop: 8, padding: 8, background: 'var(--danger-bg, #fdecea)',
                color: 'var(--danger, #b00020)', borderRadius: 4,
              }}>
                {data.lastRun.error_summary}
              </div>
            )}
          </div>
        </div>
      )}

      {loading && !data && (
        <div className="loading" role="status" aria-live="polite" style={{ padding: 24, textAlign: 'center' }}>
          Loading review queue…
        </div>
      )}

      {error && (
        <div className="card" style={{ marginBottom: 'var(--gap, 12px)' }}>
          <div className="card-body" style={{ color: 'var(--danger, #b00020)' }}>
            {error}
            <button type="button" className="btn btn-ghost" style={{ marginLeft: 12 }} onClick={refresh}>
              Retry
            </button>
          </div>
        </div>
      )}

      {data && SECTION_DEFS.map((def) => (
        <SectionShell
          key={def.key}
          title={def.label}
          count={counts[def.key]}
          open={!!open[def.key]}
          onToggle={() => toggle(def.key)}
        >
          {def.key === 'duplicates' && <DuplicatesSection rows={data.duplicates || []} onAction={onAction} />}
          {def.key === 'orphans' && <OrphansSection rows={data.orphans || []} onAction={onAction} />}
          {def.key === 'unmatchedPayees' && (
            <UnmatchedPayeesSection rows={data.unmatchedPayees || []} onAction={onAction} isAdmin={isAdmin} />
          )}
          {def.key === 'unmatchedStaff' && <UnmatchedStaffSection names={data.unmatchedStaff || []} />}
          {def.key === 'errored' && <ErroredSection rows={data.errored || []} onAction={onAction} />}
          {def.key === 'skipped' && <SkippedSection rows={data.skipped || []} onAction={onAction} />}
          {def.key === 'phase0' && (
            <Phase0Section
              eligible={data.phase0Eligible || []}
              done={data.phase0Done || []}
              onAction={onAction}
            />
          )}
        </SectionShell>
      ))}
    </div>
  );
}

function sectionCounts(data) {
  return {
    duplicates: (data.duplicates || []).length,
    orphans: (data.orphans || []).length,
    unmatchedPayees: (data.unmatchedPayees || []).length,
    unmatchedStaff: (data.unmatchedStaff || []).length,
    errored: (data.errored || []).length,
    skipped: (data.skipped || []).length,
    phase0: (data.phase0Eligible || []).length + (data.phase0Done || []).length,
  };
}
