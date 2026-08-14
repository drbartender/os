import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import api from '../../../utils/api';
import Icon from '../../../components/adminos/Icon';
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
 * "what would each filter give me"; the rows and the held-back region count
 * WITH it, so they describe what you are looking at. Computing the chips the
 * same way as the rows makes selecting Untagged read "All 184 / Untagged 184 /
 * Corporate 0", which tells you nothing.
 *
 * The big emailable number on the audience card is the view's own
 * `held_back.mailable`, not the rail's audience-wide count, so it always
 * agrees with the held-back identity check beside it.
 */
export default function AudiencesTab() {
  const navigate = useNavigate();
  const { overview } = useOutletContext();
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

  const pickAudience = (id) => { setAudience(id); setPage(1); };

  return (
    <div className="mkt-audiences">
      <div className="card mkt-card-flush mkt-aud-list">
        <div className="card-head"><h3>Audiences</h3><span className="k num">{audiences.length}</span></div>
        {audiencesError ? (
          <div className="mkt-state mkt-state-error" role="alert">
            <p>{audiencesError}</p>
            <button type="button" className="btn btn-secondary btn-sm" onClick={loadAudiences}>Try again</button>
          </div>
        ) : (
          <div>
            <button
              type="button"
              className={`queue-item${audience === '' ? ' is-selected' : ''}`}
              onClick={() => pickAudience('')}
            >
              <div className="queue-main">
                <div className="queue-title">Everyone</div>
                <div className="queue-sub">The whole contact base</div>
              </div>
              {/* Whole-base EMAILABLE count from the shared overview, so this
                  row is comparable with the audience rows below it and never
                  re-scopes itself to the active filter (review 2026-08-14). */}
              {Number.isFinite(overview?.base?.mailable) && (
                <span className="queue-meta">{overview.base.mailable}</span>
              )}
            </button>
            {audiences.map(a => (
              <button
                type="button"
                key={a.id}
                className={`queue-item${audience === a.id ? ' is-selected' : ''}`}
                onClick={() => pickAudience(a.id)}
              >
                <div className="queue-main">
                  <div className="queue-title">{a.name}</div>
                  <div className="queue-sub">{a.rule}</div>
                </div>
                <span className="queue-meta">{a.emailable}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="mkt-aud-main">
        <div className="card">
          <div className="card-head">
            <h3>{selected ? selected.name : 'Everyone'}</h3>
            <div className="hstack">
              <span className="k">{selected ? selected.rule : 'The whole contact base'}</span>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => navigate(`/marketing/compose${audience ? `?audience=${audience}` : ''}`)}
              >
                Use this audience
              </button>
            </div>
          </div>
          <div className="card-body mkt-audcard-body">
            {selected?.includes && (
              <div style={{ maxWidth: '30ch' }}>
                <div className="mkt-eyebrow">Include</div>
                <div className="mkt-chips">
                  {/* includes is an ARRAY from the resolver (marketingAudience.js),
                      one entry per predicate. */}
                  {(Array.isArray(selected.includes) ? selected.includes : [selected.includes]).map(part => (
                    <span key={part} className="chip neutral">{part}</span>
                  ))}
                </div>
              </div>
            )}
            {selected?.includes && <div className="mkt-vr" />}
            {/* Held-back counts and the big emailable number are gated on a
                CURRENT view: stale numbers beside a loading/erroring table are
                exactly what an operator must not trust before a send. */}
            <HeldBackPanel heldBack={loading || error ? null : data?.held_back} total={data?.total} />
            <div className="spacer" />
            <div className="mkt-audcard-count">
              <span className="num">
                {loading || error ? '—' : (data?.held_back?.mailable ?? '—')}
              </span>
              <div className="mkt-moment-count-sub">emailable</div>
            </div>
          </div>
        </div>

        <div className="mkt-toolbar">
          <div className="input-group">
            <Icon name="search" size={16} />
            <input
              type="search"
              placeholder="Search name or email"
              value={search}
              onChange={e => setSearch(e.target.value)}
              aria-label="Search contacts"
            />
          </div>
          <div className="seg">
            {chips.map(c => (
              <button
                type="button"
                key={c.id}
                className={filter === c.id ? 'active' : undefined}
                onClick={() => { setFilter(c.id); setPage(1); }}
              >
                {c.label}{Number.isFinite(c.count) ? ` ${c.count}` : ''}
              </button>
            ))}
          </div>
          <span className="mkt-hint">Use Edit on any tag cell to change it. Edits save to the contact, not the audience.</span>
        </div>

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
