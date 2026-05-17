import React, { useEffect, useMemo, useRef, useState } from 'react';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';
import { formatPhoneInput, stripPhone } from '../../utils/formatPhone';
import VenueAddressFields from '../../components/VenueAddressFields';
import ConfirmModal from '../../components/ConfirmModal';
import FormBanner from '../../components/FormBanner';
import FieldError from '../../components/FieldError';
import TimePicker from '../../components/TimePicker';
import NumberStepper from '../../components/NumberStepper';
import Icon from '../../components/adminos/Icon';
import { initialFormFromProposal } from './ProposalDetailEditForm';

// Focused event-specifics editor for EventDetailPage. Edits date, time,
// location, and client contact ONLY — package/pricing/add-ons are out of
// scope here (that lives on the proposal-side editor).
//
// Why it still sends the full pricing payload: PATCH /proposals/:id always
// re-prices, and omitting addon_ids/syrups/adjustments would wipe them. So we
// seed state from the shared initialFormFromProposal() builder and pass every
// pricing input back through UNCHANGED — only the event/client fields are
// user-editable. A duration change still re-prices correctly (extra-hour
// rates) with everything else intact. The linked shift is re-synced
// server-side inside the same PATCH transaction.
export default function EventEditForm({ proposal, onSaved, onCancel }) {
  const toast = useToast();
  const [form, setForm] = useState(() => initialFormFromProposal(proposal));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  const initialRef = useRef(JSON.stringify(initialFormFromProposal(proposal)));

  const isDirty = useMemo(
    () => JSON.stringify(form) !== initialRef.current,
    [form]
  );

  useEffect(() => {
    const handler = (e) => { if (isDirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  const update = (field, value) => setForm(f => ({ ...f, [field]: value }));

  const clearFieldError = (name) => {
    if (fieldErrors[name]) {
      setFieldErrors(fe => {
        const next = { ...fe };
        delete next[name];
        return next;
      });
    }
  };

  const handleSave = async () => {
    if (!form.package_id) {
      setError('This event has no package — open it on the proposal to fix that first.');
      return;
    }
    setError('');
    setFieldErrors({});
    setSaving(true);
    try {
      if (proposal.client_id) {
        await api.put(`/clients/${proposal.client_id}`, {
          name: form.client_name,
          email: form.client_email,
          phone: form.client_phone,
          source: form.client_source,
        });
      }
      // Event fields edited here; every pricing input passed through unchanged.
      const res = await api.patch(`/proposals/${proposal.id}`, {
        event_date: form.event_date,
        event_start_time: form.event_start_time,
        event_duration_hours: Number(form.event_duration_hours),
        venue_name: form.venue_name,
        venue_street: form.venue_street,
        venue_city: form.venue_city,
        venue_state: form.venue_state,
        venue_zip: form.venue_zip,
        guest_count: Number(form.guest_count),
        package_id: Number(form.package_id),
        num_bars: Number(form.num_bars) || 0,
        addon_ids: (form.addon_ids || []).map(Number),
        addon_variants: form.addon_variants || {},
        syrup_selections: form.syrup_selections || [],
        adjustments: form.adjustments || [],
        total_price_override: form.total_price_override,
      });
      toast.success('Event updated.');
      onSaved?.(res.data);
    } catch (err) {
      setError(err.message || 'Failed to save changes.');
      setFieldErrors(err.fieldErrors || {});
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    if (isDirty) setShowLeaveConfirm(true);
    else onCancel?.();
  };

  return (
    <div className="card">
      <div className="card-head">
        <h3>Edit event</h3>
        <span className="k">Date · time · location · contact</span>
      </div>
      <div className="card-body">
        {/* Event */}
        <div className="meta-k" style={{ marginBottom: 8 }}>Event</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 }}>
          <div>
            <label className="meta-k" style={{ display: 'block', marginBottom: 4 }}>Event date</label>
            <input className="input" type="date" style={{ width: '100%' }} value={form.event_date}
              onChange={e => { update('event_date', e.target.value); clearFieldError('event_date'); }}
              aria-invalid={!!fieldErrors?.event_date} />
            <FieldError error={fieldErrors?.event_date} />
          </div>
          <div>
            <label className="meta-k" style={{ display: 'block', marginBottom: 4 }}>Start time</label>
            <TimePicker className="input" value={form.event_start_time || ''}
              onChange={(v) => update('event_start_time', v)}
              minHour={6} maxHour={23} />
          </div>
          <div>
            <label className="meta-k" style={{ display: 'block', marginBottom: 4 }}>Duration (hours)</label>
            <NumberStepper className="input" min={1} max={12} step={0.5} style={{ width: '100%' }}
              value={form.event_duration_hours}
              onChange={v => update('event_duration_hours', v)}
              ariaLabelIncrease="Increase duration" ariaLabelDecrease="Decrease duration" />
          </div>
          <div />
          <div style={{ gridColumn: '1 / -1' }}>
            <label className="meta-k" style={{ display: 'block', marginBottom: 4 }}>Location</label>
            <VenueAddressFields
              value={form}
              onChange={(f, val) => update(f, val)}
            />
          </div>
        </div>

        {/* Client */}
        <div className="meta-k" style={{ marginBottom: 8 }}>Client</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 }}>
          <div>
            <label className="meta-k" style={{ display: 'block', marginBottom: 4 }}>Name</label>
            <input className="input" style={{ width: '100%' }} value={form.client_name}
              onChange={e => { update('client_name', e.target.value); clearFieldError('name'); }}
              aria-invalid={!!fieldErrors?.name} />
            <FieldError error={fieldErrors?.name} />
          </div>
          <div>
            <label className="meta-k" style={{ display: 'block', marginBottom: 4 }}>Email</label>
            <input className="input" type="email" style={{ width: '100%' }} value={form.client_email}
              onChange={e => { update('client_email', e.target.value); clearFieldError('email'); }}
              aria-invalid={!!fieldErrors?.email} />
            <FieldError error={fieldErrors?.email} />
          </div>
          <div>
            <label className="meta-k" style={{ display: 'block', marginBottom: 4 }}>Phone</label>
            <input className="input" type="tel" style={{ width: '100%' }}
              value={formatPhoneInput(form.client_phone)}
              onChange={e => { update('client_phone', stripPhone(e.target.value)); clearFieldError('phone'); }}
              aria-invalid={!!fieldErrors?.phone} />
            <FieldError error={fieldErrors?.phone} />
          </div>
          <div>
            <label className="meta-k" style={{ display: 'block', marginBottom: 4 }}>Source</label>
            <select className="select" style={{ width: '100%' }} value={form.client_source}
              onChange={e => update('client_source', e.target.value)}>
              <option value="thumbtack">Thumbtack</option>
              <option value="direct">Direct</option>
              <option value="referral">Referral</option>
              <option value="website">Website</option>
            </select>
          </div>
        </div>

        <FormBanner error={error} fieldErrors={fieldErrors} />
        <div className="hstack" style={{ gap: 8, marginTop: 12 }}>
          <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={handleCancel}>Cancel</button>
        </div>
      </div>

      <ConfirmModal
        isOpen={showLeaveConfirm}
        title="Unsaved changes"
        message="You have unsaved changes. Leave without saving?"
        onConfirm={() => { setShowLeaveConfirm(false); onCancel?.(); }}
        onCancel={() => setShowLeaveConfirm(false)} />
    </div>
  );
}
