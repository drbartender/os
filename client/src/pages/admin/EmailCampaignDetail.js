import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../../utils/api';
import CampaignMetricsBar from '../../components/CampaignMetricsBar';
import SequenceStepEditor from '../../components/SequenceStepEditor';
import AudienceSelector from '../../components/AudienceSelector';

export default function EmailCampaignDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [campaign, setCampaign] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [showAddStep, setShowAddStep] = useState(false);
  const [editingStep, setEditingStep] = useState(null);
  const [showEnroll, setShowEnroll] = useState(false);
  const [selectedLeadIds, setSelectedLeadIds] = useState([]);
  const [enrolling, setEnrolling] = useState(false);

  const fetchCampaign = useCallback(async () => {
    try {
      const res = await api.get(`/email-marketing/campaigns/${id}`);
      setCampaign(res.data);
    } catch (err) {
      console.error('Error fetching campaign:', err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { fetchCampaign(); }, [fetchCampaign]);

  const handleSend = async () => {
    if (!window.confirm(`Send this campaign to all matching leads? This cannot be undone.`)) return;
    setSending(true);
    try {
      const res = await api.post(`/email-marketing/campaigns/${id}/send`);
      alert(res.data.message);
      fetchCampaign();
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to send.');
    } finally {
      setSending(false);
    }
  };

  const handleAddStep = async (stepData) => {
    try {
      await api.post(`/email-marketing/campaigns/${id}/steps`, stepData);
      setShowAddStep(false);
      fetchCampaign();
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to add step.');
    }
  };

  const handleUpdateStep = async (stepData) => {
    try {
      await api.put(`/email-marketing/campaigns/${id}/steps/${editingStep.id}`, stepData);
      setEditingStep(null);
      fetchCampaign();
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to update step.');
    }
  };

  const handleDeleteStep = async (stepId) => {
    if (!window.confirm('Delete this step?')) return;
    try {
      await api.delete(`/email-marketing/campaigns/${id}/steps/${stepId}`);
      fetchCampaign();
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to delete step.');
    }
  };

  const handleActivate = async () => {
    try {
      await api.post(`/email-marketing/campaigns/${id}/activate`);
      fetchCampaign();
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to activate.');
    }
  };

  const handlePause = async () => {
    try {
      await api.post(`/email-marketing/campaigns/${id}/pause`);
      fetchCampaign();
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to pause.');
    }
  };

  const handleEnroll = async () => {
    if (selectedLeadIds.length === 0) return;
    setEnrolling(true);
    try {
      const res = await api.post(`/email-marketing/campaigns/${id}/enroll`, { lead_ids: selectedLeadIds });
      alert(`${res.data.enrolled} leads enrolled.`);
      setShowEnroll(false);
      setSelectedLeadIds([]);
      fetchCampaign();
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to enroll.');
    } finally {
      setEnrolling(false);
    }
  };

  if (loading) return <div className="loading"><div className="spinner" />Loading...</div>;
  if (!campaign) return <div className="em-empty">Campaign not found.</div>;

  const isBlast = campaign.type === 'blast';
  const isSequence = campaign.type === 'sequence';
  const canSend = isBlast && campaign.status === 'draft' && campaign.subject && campaign.html_body;
  const canActivate = isSequence && (campaign.status === 'draft' || campaign.status === 'paused');
  const canPause = isSequence && campaign.status === 'active';

  return (
    <div className="em-campaign-detail">
      <button className="btn btn-secondary btn-sm em-back-btn" onClick={() => navigate('/admin/email-marketing/campaigns')}>
        &larr; Back to Campaigns
      </button>

      <div className="em-campaign-header">
        <div>
          <h2>{campaign.name}</h2>
          <div className="em-campaign-meta">
            <span className="em-badge em-badge-type">{campaign.type}</span>
            <span className={`em-badge em-badge-status-${campaign.status}`}>{campaign.status}</span>
            {campaign.sent_at && <span className="em-meta-date">Sent {new Date(campaign.sent_at).toLocaleString()}</span>}
          </div>
        </div>
        <div className="em-actions">
          {canSend && (
            <button className="btn btn-primary" onClick={handleSend} disabled={sending}>
              {sending ? 'Sending...' : 'Send Now'}
            </button>
          )}
          {canActivate && (
            <button className="btn btn-primary" onClick={handleActivate}>Activate Sequence</button>
          )}
          {canPause && (
            <button className="btn btn-secondary" onClick={handlePause}>Pause Sequence</button>
          )}
        </div>
      </div>

      {/* Metrics */}
      <CampaignMetricsBar stats={campaign.stats} />

      {/* Blast Details */}
      {isBlast && (
        <div className="em-section">
          <h3>Email Content</h3>
          {campaign.subject && <p><strong>Subject:</strong> {campaign.subject}</p>}
          {campaign.html_body && (
            <div className="em-preview-frame">
              <div dangerouslySetInnerHTML={{ __html: campaign.html_body }} />
            </div>
          )}
        </div>
      )}

      {/* Sequence Steps */}
      {isSequence && (
        <div className="em-section">
          <div className="em-section-header">
            <h3>Sequence Steps ({campaign.steps?.length || 0})</h3>
            <button className="btn btn-primary btn-sm" onClick={() => setShowAddStep(true)}>+ Add Step</button>
          </div>

          {campaign.steps?.length === 0 ? (
            <p className="em-empty-sm">No steps yet. Add your first email step.</p>
          ) : (
            <div className="em-steps-list">
              {campaign.steps?.map((step, idx) => (
                <div key={step.id} className="em-step-card">
                  {editingStep?.id === step.id ? (
                    <SequenceStepEditor
                      step={step}
                      onSave={handleUpdateStep}
                      onCancel={() => setEditingStep(null)}
                    />
                  ) : (
                    <>
                      <div className="em-step-header">
                        <span className="em-step-number">Step {idx + 1}</span>
                        <span className="em-step-delay">
                          {step.delay_days > 0 && `${step.delay_days}d`}
                          {step.delay_hours > 0 && ` ${step.delay_hours}h`}
                          {step.delay_days === 0 && step.delay_hours === 0 && 'Immediately'}
                          {' after previous'}
                        </span>
                        <div className="em-step-actions-inline">
                          <button className="btn btn-sm btn-secondary" onClick={() => setEditingStep(step)}>Edit</button>
                          <button className="btn btn-sm btn-secondary" onClick={() => handleDeleteStep(step.id)}>Delete</button>
                        </div>
                      </div>
                      <p className="em-step-subject"><strong>Subject:</strong> {step.subject}</p>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}

          {showAddStep && (
            <SequenceStepEditor
              onSave={handleAddStep}
              onCancel={() => setShowAddStep(false)}
            />
          )}

          {/* Enrollment */}
          <div className="em-section">
            <div className="em-section-header">
              <h3>Enrollments ({campaign.enrollments?.length || 0})</h3>
              <button className="btn btn-primary btn-sm" onClick={() => setShowEnroll(!showEnroll)}>+ Enroll Leads</button>
            </div>

            {showEnroll && (
              <div className="em-enroll-panel">
                <AudienceSelector
                  targetSources={[]}
                  targetEventTypes={[]}
                  onChange={() => {}}
                  selectedLeadIds={selectedLeadIds}
                  onLeadIdsChange={setSelectedLeadIds}
                />
                <button className="btn btn-primary" onClick={handleEnroll} disabled={enrolling || selectedLeadIds.length === 0}>
                  {enrolling ? 'Enrolling...' : `Enroll ${selectedLeadIds.length} Leads`}
                </button>
              </div>
            )}

            {campaign.enrollments?.length > 0 && (
              <table className="em-table em-table-sm">
                <thead>
                  <tr>
                    <th>Lead</th>
                    <th>Email</th>
                    <th>Step</th>
                    <th>Status</th>
                    <th>Enrolled</th>
                  </tr>
                </thead>
                <tbody>
                  {campaign.enrollments?.map(e => (
                    <tr key={e.id}>
                      <td>{e.lead_name}</td>
                      <td>{e.lead_email}</td>
                      <td>{e.current_step} / {campaign.steps?.length || '?'}</td>
                      <td><span className={`em-badge em-badge-${e.status}`}>{e.status}</span></td>
                      <td>{new Date(e.enrolled_at).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* Send Log */}
      <div className="em-section">
        <h3>Send Log</h3>
        {campaign.sends?.length === 0 ? (
          <p className="em-empty-sm">No emails sent yet.</p>
        ) : (
          <table className="em-table em-table-sm">
            <thead>
              <tr>
                <th>Recipient</th>
                <th>Email</th>
                <th>Subject</th>
                <th>Status</th>
                <th>Sent</th>
              </tr>
            </thead>
            <tbody>
              {campaign.sends?.map(s => (
                <tr key={s.id}>
                  <td>{s.lead_name}</td>
                  <td>{s.lead_email}</td>
                  <td>{s.subject}</td>
                  <td><span className={`em-badge em-badge-${s.status}`}>{s.status}</span></td>
                  <td>{new Date(s.sent_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
