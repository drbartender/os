import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { API_BASE_URL as BASE_URL } from '../../../utils/api';
import { getEventTypeLabel } from '../../../utils/eventTypes';
import PackageMatrix from './PackageMatrix';

// Public "compare your options" page (/compare/:token, token = the
// proposal_groups UUID). Thin wrapper (P8): loads the option group and hands
// the visible options to PackageMatrix in STORED-pricing mode — each column
// shows the option's stored total_price (which already includes addons,
// adjustments, overrides, and its own num_bars: the number the client actually
// pays after choosing), never a live reprice. The decided-group /
// single-option redirects below are client behavior preserved verbatim from
// the pre-P8 page (compareGroup.test.js pins the SERVER payload contract, not
// these redirects). "Choose this one" still hands off to that option's normal
// sign/pay page with ?choose=1 (the marker that stops ProposalView bouncing
// back here). No agreement, no gratuity, no card entry.

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
      <div className="pkg-compare-page">
        <div className="pkg-compare-centered"><p className="pkg-matrix-caption">Loading your options...</p></div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="pkg-compare-page">
        <div className="pkg-compare-centered">
          <p className="pkg-matrix-caption">{error}</p>
          {!error.includes('no longer available') && (
            <button type="button" className="pkg-explore-toggle" onClick={() => setReloadKey((k) => k + 1)}>Try again</button>
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

  // Stored-mode columns: total = the option's stored total_price; the floor
  // fields come from the option's stored pricing_snapshot (the matrix omits
  // the minimum row when they are absent — it never price-computes them).
  const columns = data.options.map((o) => ({
    package_id: o.package_id,
    slug: o.package_slug,
    name: o.package_name,
    category: o.package_category,
    pricing_type: o.pricing_type,
    token: o.token,
    total: o.total_price,
    deposit: o.deposit_amount,
    floor_reason: o.floor_reason,
    billed_guests: o.billed_guests,
    floor_applied: o.floor_applied,
  }));

  return (
    <div className="pkg-compare-page">
      <div className="pkg-compare-inner">
        <p className="kicker no-rule center pkg-compare-kicker">
          Your Options{data.client_name ? ` · For ${data.client_name}` : ''}
        </p>
        <h1 className="pkg-compare-title">Compare your {eventTypeLabel} options.</h1>
        <PackageMatrix
          pricing="stored"
          eventHeader={{
            guest_count: h.guest_count,
            duration_hours: h.event_duration_hours,
            event_date: h.event_date,
          }}
          columns={columns}
          chooseLabel="Choose this one"
          onChoose={(col) => navigate(`/proposal/${col.token}?choose=1`)}
        />
      </div>
    </div>
  );
}
