import React, { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';
import FormBanner from '../../components/FormBanner';
import FieldError from '../../components/FieldError';
import { LEAD_SOURCES } from '../../utils/leadSources';

export default function EmailLeadDetail() {
  const { id } = useParams();
  const toast = useToast();
  const [lead, setLead] = useState(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});

  const fetchLead = useCallback(async () => {
    try {
      const res = await api.get(`/email-marketing/leads/${id}`);
      setLead(res.data);
      setForm({
        name: res.data.name,
        email: res.data.email,
        company: res.data.company || '',
        event_type: res.data.event_type || '',
        location: res.data.location || '',
        lead_source: res.data.lead_source,
        notes: res.data.notes || '',
      });
    } catch (err) {
      toast.error('Failed to load lead. Try refreshing.');
    } finally {
      setLoading(false);
    }
  }, [id, toast]);

  useEffect(() => { fetchLead(); }, [fetchLead]);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    setFieldErrors({});
    try {
      await api.put(`/email-marketing/leads/${id}`, form);
      setEditing(false);
      toast.success('Lead updated.');
      fetchLead();
    } catch (err) {
      setError(err.message || 'Failed to update lead.');
      setFieldErrors(err.fieldErrors || {});
    } finally {
      setSaving(false);
    }
  };

  const handleUnsubscribe = async () => {
    if (!window.confirm('Unsubscribe this lead? They will no longer receive marketing emails.')) return;
    try {
      await api.delete(`/email-marketing/leads/${id}`);
      toast.success('Lead unsubscribed.');
      fetchLead();
    } catch (err) {
      toast.error(err.message || 'Failed to unsubscribe.');
    }
  };

  if (loading) return <div className="loading"><div className="spinner" />Loading...</div>;
  if (!lead) return <div className="em-empty">Lead not found.</div>;

  return (
    <div className="em-lead-detail">
      <div className="em-lead-header">
        <div>
          <h2>{lead.name}</h2>
          <p className="em-lead-email-display">{lead.email}</p>
        </div>
        <div className="em-actions">
          <span className={`em-badge em-badge-${lead.status}`}>{lead.status}</span>
          {lead.status === 'active' && (
            <button className="btn btn-secondary btn-sm" onClick={handleUnsubscribe}>Unsubscribe</button>
          )}
          <button className="btn btn-primary btn-sm" onClick={() => setEditing(!editing)}>
            {editing ? 'Cancel' : 'Edit'}
          </button>
        </div>
      </div>

      {editing ? (
        <div className="em-edit-form">
          <div className="em-form-grid">
            <div className="form-group">
              <label className="form-label">Name</label>
              <input className="form-input" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
              <FieldError error={fieldErrors?.name} />
            </div>
            <div className="form-group">
              <label className="form-label">Email</label>
              <input className="form-input" type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} />
              <FieldError error={fieldErrors?.email} />
            </div>
            <div className="form-group">
              <label className="form-label">Company</label>
              <input className="form-input" value={form.company} onChange={e => setForm({ ...form, company: e.target.value })} />
            </div>
            <div className="form-group">
              <label className="form-label">Event Type</label>
              <input className="form-input" value={form.event_type} onChange={e => setForm({ ...form, event_type: e.target.value })} />
            </div>
            <div className="form-group">
              <label className="form-label">Location</label>
              <input className="form-input" value={form.location} onChange={e => setForm({ ...form, location: e.target.value })} />
            </div>
            <div className="form-group">
              <label className="form-label">Source</label>
              <select className="form-input" value={form.lead_source} onChange={e => setForm({ ...form, lead_source: e.target.value })}>
                {LEAD_SOURCES.map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
              </select>
              <FieldError error={fieldErrors?.lead_source} />
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Notes</label>
            <textarea className="form-input" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} rows={3} />
          </div>
          <FormBanner error={error} fieldErrors={fieldErrors} />
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>{saving ? 'Saving...' : 'Save Changes'}</button>
        </div>
      ) : (
        <div className="em-lead-info">
          <div className="em-info-grid">
            <div><strong>Company:</strong> {lead.company || '—'}</div>
            <div><strong>Event Type:</strong> {lead.event_type || '—'}</div>
            <div><strong>Location:</strong> {lead.location || '—'}</div>
            <div><strong>Source:</strong> <span className="em-badge em-badge-source">{lead.lead_source?.replace('_', ' ')}</span></div>
            <div><strong>Added:</strong> {new Date(lead.created_at).toLocaleDateString()}</div>
          </div>
          {lead.notes && <div className="em-lead-notes"><strong>Notes:</strong> {lead.notes}</div>}
        </div>
      )}

      {/* Send History */}
      <div className="em-section">
        <h3>Send History</h3>
        {lead.sends?.length === 0 ? (
          <p className="em-empty-sm">No emails sent to this lead yet.</p>
        ) : (
          <table className="em-table em-table-sm">
            <thead>
              <tr>
                <th>Campaign</th>
                <th>Subject</th>
                <th>Status</th>
                <th>Sent</th>
              </tr>
            </thead>
            <tbody>
              {lead.sends?.map(send => (
                <tr key={send.id}>
                  <td>{send.campaign_name || '—'}</td>
                  <td>{send.subject}</td>
                  <td><span className={`em-badge em-badge-${send.status}`}>{send.status}</span></td>
                  <td>{new Date(send.sent_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Conversation Thread */}
      <div className="em-section">
        <h3>Conversation</h3>
        {lead.conversations?.length === 0 ? (
          <p className="em-empty-sm">No conversation history.</p>
        ) : (
          <div className="em-conversation-thread">
            {lead.conversations?.map(msg => (
              <div key={msg.id} className={`em-message em-message-${msg.direction}`}>
                <div className="em-message-header">
                  <span className="em-message-direction">{msg.direction === 'outbound' ? 'You' : 'Lead'}</span>
                  <span className="em-message-time">{new Date(msg.created_at).toLocaleString()}</span>
                </div>
                {msg.subject && <div className="em-message-subject">{msg.subject}</div>}
                <div className="em-message-body">{msg.body_text || '(HTML content)'}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
