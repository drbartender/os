import React, { useCallback, useEffect, useState } from 'react';
import api from '../../../utils/api';
import ContactTable from './ContactTable';
import ContactDrawer from './ContactDrawer';
import HeldBackPanel from './HeldBackPanel';
import { DO_NOT_CONTACT_ID } from '../../../utils/marketingTags';
import { errorText } from './marketingFormat';

const PAGE_SIZE = 50;

/**
 * The Audiences tab: pick who you are talking to, then classify them.
 *
 * Two scopes of count are in play and they are deliberately different. The
 * quick-filter chips count WITHOUT the active filter applied, so they answer
 * "what would each filter give me"; the rows and the held-back panel count WITH
 * it, so they describe what you are looking at. Computing the chips the same
 * way as the rows makes selecting Untagged read "All 184 / Untagged 184 /
 * Corporate 0", which tells you nothing.
 */
export default function AudiencesTab() {
  const [audiences, setAudiences] = useState([]);
  const [audiencesError, setAudiencesError] = useState(null);
  const [audience, setAudience] = useState('');
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(1);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [openId, setOpenId] = useState(null);

  useEffect(() => {
    const t = setTimeout(() => { setDebouncedSearch(search); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const loadAudiences = useCallback(async () => {
    setAudiencesError(null);
    try {
      const res = await api.get('/marketing/audiences');
      setAudiences(res.data);
    } catch (err) {
      setAudiencesError(errorText(err, 'Could not load audiences.'));
    }
  }, []);

  const loadContacts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/marketing/contacts', {
        params: {
          audience: audience || undefined,
          filter: filter === 'all' ? undefined : filter,
          search: debouncedSearch || undefined,
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
  }, [audience, filter, debouncedSearch, page]);

  useEffect(() => { loadAudiences(); }, [loadAudiences]);
  useEffect(() => { loadContacts(); }, [loadContacts]);

  // In-place row updates. A refetch after every tag click would re-sort and
  // re-page under the cursor mid-grind, which is exactly what makes bulk
  // classification unusable.
  const patchContact = (id, patch) => {
    setData(d => (d ? {
      ...d,
      contacts: d.contacts.map(c => (c.id === id ? { ...c, ...patch } : c)),
    } : d));
  };
  /**
   * A do-not-contact change moves someone between the mailable and held-back
   * buckets, and those counts come from the server over the whole base, not
   * from the rows on screen. Patching the row alone would leave the panel
   * still counting someone it just excluded, which is precisely the number an
   * operator is trusting before a send. Patch for immediacy, then refetch for
   * truth. Exclusions are rare, unlike tagging, so the extra round trip costs
   * nothing in the grind this screen is built for.
   */
  const handleExclusionChange = (id, patch) => {
    patchContact(id, patch);
    loadContacts();
  };

  const handleTagsChange = (id, tags) => {
    // A contact that just received its first tag no longer has a suggestion to
    // accept, and one emptied back out should not resurrect a stale one.
    patchContact(id, { tags, untagged: tags.length === 0, ...(tags.length ? { suggestion: null } : {}) });
  };

  const selected = audiences.find(a => a.id === audience);
  const counts = data?.filter_counts || {};
  const chips = [
    { id: 'all', label: 'All', count: counts.all },
    { id: 'untagged', label: 'Untagged', count: counts.untagged },
    { id: 'corporate', label: 'Corporate', count: counts.corporate },
    { id: DO_NOT_CONTACT_ID, label: 'Do not contact', count: counts[DO_NOT_CONTACT_ID] },
  ];

  return (
    <div className="mkt-audiences">
      <section className="mkt-audience-list">
        <h2>Audiences</h2>
        {audiencesError ? (
          <div className="mkt-state mkt-state-error" role="alert">
            <p>{audiencesError}</p>
            <button type="button" className="btn-secondary" onClick={loadAudiences}>Try again</button>
          </div>
        ) : (
          <div className="mkt-audience-cards">
            <button
              type="button"
              className={`mkt-audience-card${audience === '' ? ' is-selected' : ''}`}
              onClick={() => { setAudience(''); setPage(1); }}
            >
              <span className="mkt-audience-name">Everyone</span>
              <span className="mkt-muted">The whole contact base</span>
            </button>
            {audiences.map(a => (
              <button
                type="button"
                key={a.id}
                className={`mkt-audience-card${audience === a.id ? ' is-selected' : ''}`}
                onClick={() => { setAudience(a.id); setPage(1); }}
              >
                <span className="mkt-audience-name">{a.name}</span>
                <span className="mkt-muted">{a.rule}</span>
                <span className="mkt-audience-count">{a.emailable} emailable</span>
              </button>
            ))}
          </div>
        )}
        {selected?.includes && (
          <p className="mkt-muted mkt-audience-includes">Includes: {selected.includes}</p>
        )}
      </section>

      <section className="mkt-contacts">
        <div className="mkt-toolbar">
          <div className="mkt-filters">
            {chips.map(c => (
              <button
                type="button"
                key={c.id}
                className={`mkt-filter${filter === c.id ? ' is-active' : ''}`}
                onClick={() => { setFilter(c.id); setPage(1); }}
              >
                {c.label}{Number.isFinite(c.count) ? ` ${c.count}` : ''}
              </button>
            ))}
          </div>
          <input
            type="search"
            className="mkt-search"
            placeholder="Search name or email"
            value={search}
            onChange={e => setSearch(e.target.value)}
            aria-label="Search contacts"
          />
        </div>

        <div className="mkt-contacts-body">
          <div className="mkt-contacts-table">
            <ContactTable
              contacts={data?.contacts || []}
              loading={loading}
              error={error}
              onRetry={loadContacts}
              total={data?.total || 0}
              page={data?.page || page}
              limit={data?.limit || PAGE_SIZE}
              onPageChange={p => setPage(p)}
              onTagsChange={handleTagsChange}
              onContactChange={handleExclusionChange}
              onOpen={setOpenId}
              filtered={Boolean(audience || debouncedSearch || filter !== 'all')}
            />
          </div>
          {!loading && !error && <HeldBackPanel heldBack={data?.held_back} total={data?.total} />}
        </div>
      </section>

      {openId && (
        <ContactDrawer
          contactId={openId}
          onClose={() => setOpenId(null)}
          onTagsChange={handleTagsChange}
          onContactChange={handleExclusionChange}
        />
      )}
    </div>
  );
}
