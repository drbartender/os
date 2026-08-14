import React, { useCallback, useEffect, useState } from 'react';
import api from '../../../utils/api';
import { formatDollars, formatDay, heldBackLabel, errorText } from './marketingFormat';

const PAGE_SIZE = 50;

/**
 * Choose who a campaign goes to.
 *
 * Only MAILABLE contacts are listed (`mailable_only=true`). The held-back ones
 * are not hidden to be tidy: an operator cannot select them, so showing them as
 * unselectable rows would only invite the question "why can't I tick this",
 * which the Audiences tab already answers properly with its reasons panel.
 *
 * "Select all" selects everyone matching the CURRENT FILTER across every page,
 * not just the rows on screen. Selecting a 300-person audience one page at a
 * time is not a real workflow, and a control that silently means "this page
 * only" is how someone sends to 50 people believing they sent to 300.
 */
export default function RecipientPicker({ audiences, selected, onChange }) {
  const [audience, setAudience] = useState('');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => { setDebounced(search); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await api.get('/marketing/contacts', {
        params: {
          audience: audience || undefined,
          search: debounced || undefined,
          mailable_only: 'true',
          page,
          limit: PAGE_SIZE,
        },
      });
      setData(res.data);
    } catch (err) {
      setError(errorText(err, 'Could not load contacts.'));
    } finally {
      setLoading(false);
    }
  }, [audience, debounced, page]);

  useEffect(() => { load(); }, [load]);

  const toggle = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    onChange(next);
  };

  /** Select every contact matching the current filter, across all pages. */
  const selectAllMatching = async () => {
    // Guard on a loaded page. Without it a failed first load left total at 0,
    // so the request went out with limit 1, selected exactly one contact, and
    // the "first N of M" notice could not fire because 0 > 1 is false.
    const total = data?.total || 0;
    if (!data || total === 0) return;
    setBulkBusy(true);
    try {
      const res = await api.get('/marketing/contacts', {
        params: {
          audience: audience || undefined,
          search: debounced || undefined,
          mailable_only: 'true',
          page: 1,
          limit: Math.max(1, Math.min(200, total)),
        },
      });
      const next = new Set(selected);
      res.data.contacts.forEach(c => next.add(c.id));
      onChange(next);
      // The server caps a page at 200. Say so rather than quietly selecting a
      // subset of what the button claimed.
      if (total > res.data.contacts.length) {
        setError(`Selected the first ${res.data.contacts.length} of ${total}. `
          + 'Narrow the audience, or send in batches.');
      }
    } catch (err) {
      setError(errorText(err, 'Could not select all.'));
    } finally {
      setBulkBusy(false);
    }
  };

  const rows = data?.contacts || [];
  const pages = Math.max(1, Math.ceil((data?.total || 0) / PAGE_SIZE));

  return (
    <div className="mkt-recipients">
      <div className="mkt-toolbar">
        <select
          className="mkt-filter-select"
          value={audience}
          onChange={e => { setAudience(e.target.value); setPage(1); }}
          aria-label="Audience"
        >
          <option value="">Everyone</option>
          {audiences.map(a => (
            <option key={a.id} value={a.id}>{a.name} ({a.emailable})</option>
          ))}
        </select>
        <input
          type="search"
          className="mkt-search"
          placeholder="Search name or email"
          value={search}
          onChange={e => setSearch(e.target.value)}
          aria-label="Search contacts"
        />
        <button type="button" className="btn-secondary" onClick={selectAllMatching} disabled={bulkBusy || loading}>
          {bulkBusy ? 'Selecting…' : 'Select all matching'}
        </button>
        <button type="button" className="btn-link" onClick={() => onChange(new Set())} disabled={selected.size === 0}>
          Clear ({selected.size})
        </button>
      </div>

      {error && (
        <div className="mkt-state mkt-state-error" role="alert">
          <p>{error}</p>
          <button type="button" className="btn-secondary" onClick={load}>Try again</button>
        </div>
      )}

      {loading ? (
        <div className="mkt-state" role="status" aria-live="polite"><div className="spinner" /> Loading…</div>
      ) : rows.length === 0 ? (
        <div className="mkt-state">
          {audience || debounced
            ? 'Nobody emailable matches that. Try a different audience or search.'
            : 'No emailable contacts yet.'}
        </div>
      ) : (
        <>
          <table className="mkt-table">
            <thead>
              <tr>
                <th aria-label="Selected" />
                <th>Contact</th>
                <th>Last event</th>
                <th>Lifetime</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(c => (
                <tr key={c.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(c.id)}
                      onChange={() => toggle(c.id)}
                      aria-label={`Include ${c.name || c.email}`}
                    />
                  </td>
                  <td>
                    <div className="mkt-name">{c.name || 'No name'}</div>
                    <div className="mkt-email">{c.email}</div>
                    {!c.mailable && (
                      <span className="mkt-chip mkt-chip-muted">{heldBackLabel(c.held_back_reason)}</span>
                    )}
                  </td>
                  <td>{formatDay(c.last_event)}</td>
                  <td>{formatDollars(c.lifetime_dollars)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mkt-pager">
            <span>{data.total} emailable match this filter</span>
            <div>
              <button type="button" className="btn-secondary" onClick={() => setPage(p => p - 1)} disabled={page <= 1}>
                Previous
              </button>
              <span className="mkt-pager-page">Page {page} of {pages}</span>
              <button type="button" className="btn-secondary" onClick={() => setPage(p => p + 1)} disabled={page >= pages}>
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
