import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import axios from 'axios';
import api, { API_BASE_URL as BASE_URL } from '../../../utils/api';
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
//
// preview (admin only, /compare/:token/preview on the admin host): reads the
// authed preview endpoint, which includes options the client cannot see yet,
// skips both redirects, and turns the choose buttons off. Choosing from here
// would open the client's proposal page as the client and could flip it to
// viewed, so the preview never navigates there.

export default function ProposalCompare({ preview = false }) {
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
    const load = preview
      ? api.get(`/proposals/group/${token}/preview`)
      : axios.get(`${BASE_URL}/proposals/group/${token}`);
    load
      .then((res) => { if (!cancelled) setData(res.data); })
      .catch((err) => {
        if (cancelled) return;
        // api.js rejects with a flattened { status }; raw axios keeps err.response.
        // eslint-disable-next-line no-restricted-syntax
        setError((err?.response?.status ?? err?.status) === 404
          ? 'This comparison is no longer available.'
          : 'Something went wrong loading your options.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token, reloadKey, preview]);

  // A decided group routes to the booked option; a single visible option skips
  // the compare and goes straight to its proposal page.
  useEffect(() => {
    if (!data || preview) return;
    if (data.decided && data.chosen_token) {
      navigate(`/proposal/${data.chosen_token}?choose=1`, { replace: true });
    } else if (data.options && data.options.length === 1) {
      navigate(`/proposal/${data.options[0].token}?choose=1`, { replace: true });
    }
  }, [data, navigate, preview]);

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
  if (!data) return null;
  if (!preview && (data.decided || (data.options || []).length < 2)) return null; // redirecting

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
  const hiddenFromClient = preview
    ? data.options.filter((o) => !o.client_visible)
      .map((o) => `${o.package_name || 'No package yet'} (${o.status === 'draft' ? 'not sent yet' : o.status})`)
    : [];
  // Say what the client's own link opens right now, which the redirects above
  // decide: the booked option, a single proposal, nothing, or this comparison.
  const clientVisibleCount = data.options.length - hiddenFromClient.length;
  let previewLead = 'This is the comparison your client sees.';
  if (data.decided) previewLead = 'The client\'s link opens the option they booked, not this comparison.';
  else if (clientVisibleCount === 0) previewLead = 'The client\'s link shows nothing yet: no option has been sent.';
  else if (clientVisibleCount === 1) previewLead = 'The client\'s link currently opens a single proposal, not this comparison.';
  else if (hiddenFromClient.length > 0) previewLead = 'Your client sees this comparison without the hidden options listed here.';

  return (
    <div className="pkg-compare-page">
      <div className="pkg-compare-inner">
        {preview && (
          <div className="pkg-compare-preview" role="note">
            <strong>Preview.</strong> {previewLead} The choose buttons are off here.
            {hiddenFromClient.length > 0 && ` Hidden from the client: ${hiddenFromClient.join(', ')}.`}
          </div>
        )}
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
          onChoose={preview ? undefined : (col) => navigate(`/proposal/${col.token}?choose=1`)}
        />
      </div>
    </div>
  );
}
