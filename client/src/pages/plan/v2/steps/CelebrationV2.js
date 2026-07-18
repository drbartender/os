import React from 'react';
import axios from 'axios';
import { API_BASE_URL as BASE_URL } from '../../../../utils/api';

// Celebration (spec §3.1/§3.3): the finale plus the ONE selling doorway.
// The Enhancement Lab CTA renders only when the server says the Lab exists
// (plan.lab_enabled, set by the pp2-lab lane) — deploy-seam rule: the CTA can
// never 404.
export default function CelebrationV2({ plan, token, selections, paidFromRedirect }) {
  const labEnabled = plan.lab_enabled === true;

  const openLab = () => {
    // Attach-rate observability (plan §pp2-planner.5): best-effort marker.
    axios.post(`${BASE_URL}/drink-plans/t/${token}/lab-cta`, {}).catch(() => {});
    window.location.href = `/plan/${token}/lab`;
  };

  return (
    <div style={{ textAlign: 'center', paddingTop: '3rem' }}>
      <div className="card">
        <div style={{ fontSize: '3rem', marginBottom: '0.75rem' }}>&#127881;</div>
        <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)' }}>Formulas Filed!</h2>
        <img
          src="/images/potion-bartender.png"
          alt="Dr. Bartender"
          style={{ maxWidth: '120px', margin: '1rem auto', display: 'block', opacity: 0.9 }}
        />
        <p className="text-muted" style={{ marginTop: '0.75rem' }}>
          Thank you, {plan.client_name || 'friend'}! Your selections are in. A confirmation email with
          everything you chose is on its way.
        </p>

        {paidFromRedirect && (
          <div style={{ marginTop: '1rem', padding: '0.75rem', background: 'rgba(46, 125, 50, 0.08)', borderRadius: '8px', border: '1px solid rgba(46, 125, 50, 0.2)' }}>
            <p style={{ fontWeight: 600, color: '#2e7d32', marginBottom: '0.25rem' }}>Payment Received</p>
            <p className="text-muted text-small">Your payment was processed successfully. You'll receive a confirmation email shortly.</p>
          </div>
        )}

        {labEnabled && (
          <div className="pp2-lab-invite">
            <span className="potion-kicker">Your formulas are filed. Care to enhance them?</span>
            <p className="text-muted text-small" style={{ margin: '0.5rem 0 0.75rem' }}>
              Smoke, sparkle, and housemade craft, matched to the drinks you just chose. Nothing is
              ever added unless you say so.
            </p>
            <button className="btn potion-start" onClick={openLab}>Enter the Enhancement Lab</button>
          </div>
        )}

        <div style={{ marginTop: '1.25rem', padding: '0.75rem', background: 'rgba(193, 125, 60, 0.08)', borderRadius: '8px' }}>
          <p style={{ fontWeight: 600, color: 'var(--deep-brown)', marginBottom: '0.25rem' }}>What happens next?</p>
          <p className="text-muted text-small">
            {(selections.menuStyle === 'custom' || selections.menuStyle === 'house')
              ? "We'll use your selections to build your shopping list, your menu, and the run sheet for your event. Expect to hear from us within 2 business days!"
              : "We'll use your selections to build your shopping list and the run sheet for your event. Expect to hear from us within 2 business days!"}
          </p>
        </div>
      </div>
    </div>
  );
}
