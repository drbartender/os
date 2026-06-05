import React, { useState, useEffect } from 'react';
import * as Sentry from '@sentry/react';
import api from '../../../../utils/api';
import ShareButton from '../ShareButton';
export default function PotionTab({ focus }) {
  const [plan, setPlan] = useState(null);
  const [state, setState] = useState(focus.drink_plan_token ? 'loading' : 'none');
  useEffect(() => { if (!focus.drink_plan_token) return; let off = false; (async () => {
    try { const { data } = await api.get(`/drink-plans/t/${focus.drink_plan_token}`);
      if (!off) { setPlan(data || {}); setState('ready'); }
    } catch (e) { if (!off) { Sentry.captureException(e, { tags: { area: 'client-portal', tab: 'potion', token: focus.token } }); setState('error'); } }
  })(); return () => { off = true; }; }, [focus.drink_plan_token, focus.token]);
  if (state === 'none') return <div className="cp-empty"><p>Your menu opens after booking.</p></div>;
  if (state === 'loading') return <div className="loading" role="status"><div className="spinner" />Loading...</div>;
  if (state === 'error') return <div className="client-alert client-alert-error">Could not load your menu.</div>;
  return (<div className="cp-potion-summary"><div className="cp-potion-serving">{plan.serving_type || 'Menu in progress'}</div>
    <div className="cp-potion-actions">
      <a className="btn client-btn-primary" href={`/plan/${focus.drink_plan_token}`}>Open the planner</a>
      <ShareButton url={`/plan/${focus.drink_plan_token}`} label="Share the menu" />
    </div></div>);
}
