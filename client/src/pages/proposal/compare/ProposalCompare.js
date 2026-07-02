import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { API_BASE_URL as BASE_URL } from '../../../utils/api';
import { getPackageBySlug } from '../../../data/packages';
import { getEventTypeLabel } from '../../../utils/eventTypes';
import { fmt, formatDateShort, formatTime } from '../proposalView/helpers';

// Public side-by-side "compare your options" page (/compare/:token, token = the
// proposal_groups UUID). Pure presentation: no agreement, no gratuity, no card
// entry. "Choose this one" hands off to that option's normal sign/pay page with
// ?choose=1 (the marker that stops ProposalView bouncing back here).

const S = {
  page: { minHeight: '100vh', background: 'var(--bg, #faf7f2)', padding: '2rem 1rem 4rem' },
  inner: { maxWidth: 1040, margin: '0 auto' },
  kicker: {
    fontFamily: 'var(--font-display)', fontSize: '0.78rem', letterSpacing: '0.22em',
    textTransform: 'uppercase', color: 'var(--brass)', textAlign: 'center', margin: '0 0 0.5rem',
  },
  headline: {
    fontFamily: 'var(--font-display)', fontSize: '2rem', fontWeight: 400,
    textAlign: 'center', margin: '0 0 1.5rem', color: 'var(--ink, #2b2b2b)',
  },
  headerCard: {
    background: 'var(--card, #fff)', border: '1px solid var(--line, #e5ded2)', borderRadius: 10,
    padding: '1rem 1.25rem', margin: '0 auto 2rem', maxWidth: 720,
    display: 'flex', flexWrap: 'wrap', gap: '0.4rem 1.5rem', justifyContent: 'center',
  },
  headerItem: { fontSize: '0.92rem', color: 'var(--text-muted, #6b6257)' },
  headerLabel: { color: 'var(--brass)', marginRight: '0.35rem' },
  columns: { display: 'flex', flexWrap: 'wrap', gap: '1.25rem', alignItems: 'stretch', justifyContent: 'center' },
  col: {
    flex: '1 1 300px', maxWidth: 480, background: 'var(--card, #fff)',
    border: '1px solid var(--line, #e5ded2)', borderRadius: 12, padding: '1.5rem',
    display: 'flex', flexDirection: 'column',
  },
  badge: {
    alignSelf: 'flex-start', fontFamily: 'var(--font-display)', fontSize: '0.7rem',
    letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--brass)',
    border: '1px solid var(--brass)', borderRadius: 999, padding: '0.2rem 0.7rem', marginBottom: '0.75rem',
  },
  pkgName: { fontFamily: 'var(--font-display)', fontSize: '1.35rem', fontWeight: 400, margin: '0 0 0.25rem' },
  tagline: { color: 'var(--text-muted, #6b6257)', fontStyle: 'italic', fontSize: '0.92rem', margin: '0 0 1rem' },
  total: { fontSize: '1.7rem', fontWeight: 600, margin: '0 0 0.15rem', color: 'var(--ink, #2b2b2b)' },
  deposit: { fontSize: '0.85rem', color: 'var(--text-muted, #6b6257)', margin: '0 0 1.25rem' },
  secHeading: {
    fontFamily: 'var(--font-display)', fontSize: '0.75rem', fontWeight: 400, color: 'var(--brass)',
    textTransform: 'uppercase', letterSpacing: '0.18em', margin: '0.9rem 0 0.35rem',
  },
  list: { listStyle: 'none', padding: 0, margin: 0 },
  item: { fontSize: '0.88rem', color: 'var(--text-muted, #5d5548)', padding: '0.18rem 0', lineHeight: 1.45 },
  chooseBtn: {
    marginTop: 'auto', paddingTop: '1.25rem',
  },
  chooseBtnInner: {
    display: 'block', width: '100%', padding: '0.85rem 1rem', borderRadius: 8,
    background: 'var(--brass, #a3803c)', color: '#fff', border: 'none', cursor: 'pointer',
    fontFamily: 'var(--font-display)', fontSize: '0.9rem', letterSpacing: '0.12em', textTransform: 'uppercase',
  },
  centered: { minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: '1rem' },
  mutedNote: { color: 'var(--text-muted, #6b6257)', fontSize: '0.95rem', textAlign: 'center' },
  retryBtn: {
    padding: '0.6rem 1.4rem', borderRadius: 8, border: '1px solid var(--brass)', background: 'transparent',
    color: 'var(--brass)', cursor: 'pointer', fontFamily: 'var(--font-display)', letterSpacing: '0.1em', textTransform: 'uppercase', fontSize: '0.8rem',
  },
};

// Item bullets in the catalog carry witty descriptions after an en/em separator
// ("Tito's Vodka – ..."). Compare columns show just the item names so two tiers
// scan cleanly against each other.
function itemName(item) {
  return item.split(' – ')[0];
}

// Full payment is required inside the 14-day window (server bookingWindow rule);
// cosmetic mirror only, the sign/pay page is authoritative.
function fullPaymentLikely(eventDate) {
  if (!eventDate) return false;
  const days = (new Date(eventDate) - new Date()) / 86400000;
  return days <= 14;
}

function OptionColumn({ option, eventDate, onChoose }) {
  const detail = getPackageBySlug(option.package_slug);
  const badge = option.package_category === 'hosted' || option.pricing_type === 'per_guest'
    ? 'Hosted Bar' : 'BYOB';
  const deposit = Number(option.deposit_amount) || 100;
  return (
    <div style={S.col}>
      <span style={S.badge}>{badge}</span>
      <h2 style={S.pkgName}>{option.package_name}</h2>
      {detail?.tagline && <p style={S.tagline}>{detail.tagline}</p>}
      <p style={S.total}>{fmt(option.total_price)}</p>
      <p style={S.deposit}>
        {fullPaymentLikely(eventDate)
          ? 'Full payment due at booking'
          : `Reserve with a ${fmt(deposit)} deposit`}
      </p>
      {detail ? (
        <div>
          {detail.sections.map((section, si) => (
            <div key={si}>
              <h3 style={S.secHeading}>{section.heading}</h3>
              <ul style={S.list}>
                {section.items.map((item, i) => (
                  <li key={i} style={S.item}>{itemName(item)}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : (
        // Non-catalog package (class/custom): no aligned sections to show.
        <p style={S.item}>Full details on the next page.</p>
      )}
      <div style={S.chooseBtn}>
        <button type="button" style={S.chooseBtnInner} onClick={onChoose}>
          Choose this one
        </button>
      </div>
    </div>
  );
}

export default function ProposalCompare() {
  const { token } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    axios.get(`${BASE_URL}/proposals/group/${token}`)
      .then((res) => { if (!cancelled) setData(res.data); })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.response?.status === 404
          ? 'This comparison is no longer available.'
          : 'Something went wrong loading your options.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token, reloadKey]);

  // A decided group routes to the booked option; a single visible option skips
  // the compare and goes straight to its proposal page.
  useEffect(() => {
    if (!data) return;
    if (data.decided && data.chosen_token) {
      navigate(`/proposal/${data.chosen_token}?choose=1`, { replace: true });
    } else if (data.options && data.options.length === 1) {
      navigate(`/proposal/${data.options[0].token}?choose=1`, { replace: true });
    }
  }, [data, navigate]);

  if (loading) {
    return (
      <div style={S.page}><div style={S.centered}><p style={S.mutedNote}>Loading your options...</p></div></div>
    );
  }
  if (error) {
    return (
      <div style={S.page}>
        <div style={S.centered}>
          <p style={S.mutedNote}>{error}</p>
          {!error.includes('no longer available') && (
            <button type="button" style={S.retryBtn} onClick={() => setReloadKey((k) => k + 1)}>Try again</button>
          )}
        </div>
      </div>
    );
  }
  if (!data || data.decided || (data.options || []).length < 2) return null; // redirecting

  const h = data.event_header || {};
  const eventTypeLabel = getEventTypeLabel({
    event_type: h.event_type, event_type_custom: h.event_type_custom,
  });

  return (
    <div style={S.page}>
      <div style={S.inner}>
        <p style={S.kicker}>Your Options{data.client_name ? ` · For ${data.client_name}` : ''}</p>
        <h1 style={S.headline}>Compare your {eventTypeLabel} options.</h1>
        <div style={S.headerCard}>
          {h.event_date && (
            <span style={S.headerItem}><span style={S.headerLabel}>Date</span>{formatDateShort(h.event_date)}</span>
          )}
          {h.event_start_time && (
            <span style={S.headerItem}><span style={S.headerLabel}>Start</span>{formatTime(h.event_start_time)}</span>
          )}
          {h.guest_count != null && (
            <span style={S.headerItem}><span style={S.headerLabel}>Guests</span>{h.guest_count}</span>
          )}
          {h.event_location && (
            <span style={S.headerItem}><span style={S.headerLabel}>Location</span>{h.event_location}</span>
          )}
        </div>
        <div style={S.columns}>
          {data.options.map((option) => (
            <OptionColumn
              key={option.id}
              option={option}
              eventDate={h.event_date}
              onChoose={() => navigate(`/proposal/${option.token}?choose=1`)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
