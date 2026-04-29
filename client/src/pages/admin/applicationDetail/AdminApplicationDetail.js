import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../../../utils/api';
import { useToast } from '../../../context/ToastContext';
import Icon from '../../../components/adminos/Icon';
import StatusChip from '../../../components/adminos/StatusChip';
import { initialsOf, relDay, AD_FLOW, stageOf, chipKindFor, tryParseArray } from './helpers';
import PipelineStrip from './components/PipelineStrip';
import ScorecardCard from './components/ScorecardCard';
import TimelineCard from './components/TimelineCard';
import OnboardingCard from './components/OnboardingCard';
import ActionsCard from './components/ActionsCard';
import StatsCard from './components/StatsCard';
import FilesBlock from './components/FilesBlock';
import FlagsCard from './components/FlagsCard';
import ViabilityCard from './components/ViabilityCard';
import RejectModal from './components/RejectModal';
import SectionWords from './sections/SectionWords';
import SectionExperience from './sections/SectionExperience';
import SectionGear from './sections/SectionGear';
import SectionContact from './sections/SectionContact';

export default function AdminApplicationDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [data, setData]         = useState(null);
  const [loading, setLoading]   = useState(true);
  const [acting, setActing]     = useState(false);
  const [reminderBusy, setReminderBusy] = useState(false);
  const [rejectOpen, setRejectOpen]     = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.get(`/admin/applications/${id}`);
      setData(r.data);
    } catch {
      toast.error('Failed to load application.');
    } finally {
      setLoading(false);
    }
  }, [id, toast]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div className="page" data-app="admin-os">
        <div className="loading"><div className="spinner" />Loading…</div>
      </div>
    );
  }

  if (!data || !data.application) {
    return (
      <div className="page" data-app="admin-os">
        <div className="card-empty">Application not found.</div>
      </div>
    );
  }

  const a = data.application;
  const status = stageOf(a.onboarding_status);
  const isRejected = a.onboarding_status === 'rejected';
  const onboardingPct = a.onboarding_progress ?? 0;
  const positions = tryParseArray(a.positions_interested);

  const handle = async (fn, successMsg) => {
    setActing(true);
    try {
      await fn();
      if (successMsg) toast.success(successMsg);
      await load();
    } catch (e) {
      const apiMsg = e?.response?.data?.error
        || e?.response?.data?.message
        || 'Action failed.';
      toast.error(apiMsg);
    } finally {
      setActing(false);
    }
  };

  const handleReminder = async () => {
    setReminderBusy(true);
    try {
      await api.post(`/admin/applications/${a.id}/reminder`);
      toast.success('Reminder sent.');
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.error || e?.response?.data?.message || 'Could not send reminder.');
    } finally {
      setReminderBusy(false);
    }
  };

  return (
    <div className="page" data-app="admin-os" style={{ maxWidth: 1280 }}>
      <div className="hstack" style={{ marginBottom: 8 }}>
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('/hiring')}>
          <Icon name="arrow_right" size={11} style={{ transform: 'rotate(180deg)' }} />
          Hiring pipeline
        </button>
      </div>

      {/* Identity bar */}
      <div className="card" style={{ padding: '1.5rem 1.75rem', marginBottom: 'var(--gap)' }}>
        <div className="hstack" style={{ gap: 18, alignItems: 'flex-start' }}>
          <div className="avatar" style={{ width: 64, height: 64, fontSize: 22, flexShrink: 0 }}>
            {initialsOf(a.full_name)}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="tiny muted" style={{
              textTransform: 'uppercase', letterSpacing: '0.08em', fontSize: 10, marginBottom: 4,
            }}>Application · A{a.id}</div>
            <div className="hstack" style={{ gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
              <h1 style={{
                fontFamily: 'var(--font-display)', fontSize: 32, fontWeight: 500,
                margin: 0, lineHeight: 1.1,
              }}>{a.full_name}</h1>
              <StatusChip kind={chipKindFor(a.onboarding_status, onboardingPct)}>
                {isRejected
                  ? 'Rejected'
                  : (AD_FLOW.find(s => s.key === status)?.label || status)}
              </StatusChip>
              {positions.map(p => <span key={p} className="tag">{p}</span>)}
              {a.referral_source && (
                <span className="tag" style={{ color: 'var(--accent)', borderColor: 'currentColor' }}>
                  Referral · {a.referral_source}
                </span>
              )}
              {a.has_bartending_experience && !a.basset_file_url && (
                <StatusChip kind="warn">No BASSET</StatusChip>
              )}
            </div>
            <div className="hstack" style={{
              gap: 16, marginTop: 6, color: 'var(--ink-3)', fontSize: 13, flexWrap: 'wrap',
            }}>
              <span className="hstack"><Icon name="mail" size={12} />{a.email}</span>
              <span className="hstack"><Icon name="phone" size={12} /><span className="mono">{a.phone}</span></span>
              <span className="hstack"><Icon name="location" size={12} />{a.city}, {a.state}</span>
              <span className="hstack"><Icon name="calendar" size={12} />Applied {relDay(a.applied_at)}</span>
            </div>
          </div>
        </div>
        <PipelineStrip status={a.onboarding_status} rejectionReason={a.rejection_reason} />
      </div>

      {/* Two-column body */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 'var(--gap)' }}>
        <div className="vstack" style={{ gap: 'var(--gap)' }}>
          <ViabilityCard a={a} />
          {(status === 'interviewing' || status === 'in_progress' || isRejected) && (
            <ScorecardCard userId={a.id} initial={data.scorecard} onSaved={load} />
          )}
          <SectionWords a={a} />
          <SectionExperience a={a} />
          <SectionGear a={a} />
          <SectionContact a={a} />
          <TimelineCard userId={a.id} timeline={data.timeline} onPosted={load} />
        </div>
        <div className="vstack" style={{ gap: 'var(--gap)' }}>
          <ActionsCard
            a={a}
            acting={acting}
            onMove={(to) => handle(() => api.post(`/admin/applications/${a.id}/move`, { to }), 'Moved.')}
            onSchedule={() => navigate(`/hiring?schedule=${a.id}`)}
            onReject={() => setRejectOpen(true)}
            onRestore={() => handle(() => api.post(`/admin/applications/${a.id}/restore`), 'Restored to Applied.')}
            onReminder={handleReminder}
          />
          <StatsCard a={a} scorecard={data.scorecard} />
          {status === 'in_progress' && (
            <OnboardingCard a={a} onReminder={handleReminder} reminderBusy={reminderBusy} />
          )}
          <FilesBlock a={a} />
          <FlagsCard a={a} />
        </div>
      </div>

      <RejectModal
        open={rejectOpen}
        onClose={() => setRejectOpen(false)}
        onConfirm={async (reason) => {
          await handle(
            () => api.post(`/admin/applications/${a.id}/reject`, { rejection_reason: reason }),
            'Rejected.'
          );
          setRejectOpen(false);
        }}
      />
    </div>
  );
}
