import React from 'react';
import TagCell from './TagCell';
import DoNotContactControl from './DoNotContactControl';
import { formatDollars, formatDay, formatLocalDay } from './marketingFormat';

/**
 * The contact base. One row per client; no dedupe here by design (the resolver
 * measured zero duplicate addresses in prod, and dedupe lives on the send path
 * where it is genuinely load-bearing).
 *
 * Pagination is required rather than optional: the base is roughly 700 rows and
 * the only local precedent, AudienceSelector.js, hard-codes limit 500 with no
 * pagination and silently truncates.
 */
export default function ContactTable({
  contacts, loading, error, onRetry, total, page, limit,
  onPageChange, onTagsChange, onContactChange, onOpen, filtered,
}) {
  if (loading) {
    return (
      <div className="mkt-state" role="status" aria-live="polite">
        <div className="spinner" /> Loading contacts…
      </div>
    );
  }

  if (error) {
    return (
      <div className="mkt-state mkt-state-error" role="alert">
        <p>{error}</p>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>Try again</button>
      </div>
    );
  }

  if (!contacts.length) {
    // The two empty states are genuinely different problems: one means "your
    // filter is too narrow", the other means "there is nothing here at all".
    return (
      <div className="mkt-state">
        {filtered
          ? 'No contacts match that filter. Try a different audience, filter, or search.'
          : 'No contacts yet. They appear here as soon as someone requests a quote or books.'}
      </div>
    );
  }

  const pages = Math.max(1, Math.ceil(total / limit));
  const from = (page - 1) * limit + 1;
  const to = Math.min(total, page * limit);

  return (
    <>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>Contact</th>
              <th>Marketing tags</th>
              <th>Last event</th>
              <th className="num">Lifetime</th>
              <th className="mkt-col-contacted">Last contacted</th>
              <th className="shrink" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {contacts.map(c => (
              <tr
                key={c.id}
                className={c.mailable ? '' : 'mkt-row-held'}
                onClick={() => onOpen(c.id)}
              >
                <td>
                  <div className="mkt-name">{c.name || 'No name'}</div>
                  <div className="mkt-email">{c.email || 'No address'}</div>
                </td>
                {/* The tag control and the do-not-contact control both live inside
                    the row, so their clicks must not also open the drawer. */}
                <td onClick={e => e.stopPropagation()} style={{ overflow: 'visible', position: 'relative' }}>
                  <TagCell contact={c} onTagsChange={onTagsChange} />
                </td>
                <td className="muted">{formatDay(c.last_event)}</td>
                <td className="num">{formatDollars(c.lifetime_dollars)}</td>
                {/* last_contacted is a timestamptz, so it renders in local time.
                    Folds away under 1400px (mkt-col-contacted); the drawer
                    still carries the full history. */}
                <td className="muted mkt-col-contacted">{formatLocalDay(c.last_contacted)}</td>
                <td className="shrink" onClick={e => e.stopPropagation()}>
                  <DoNotContactControl contact={c} onChange={onContactChange} compact />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mkt-pager">
        <span>{from} to {to} of {total}</span>
        <div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1}
          >
            Previous
          </button>
          <span className="mkt-pager-page">Page {page} of {pages}</span>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => onPageChange(page + 1)}
            disabled={page >= pages}
          >
            Next
          </button>
        </div>
      </div>
    </>
  );
}
