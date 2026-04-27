import React from 'react';
import FieldError from '../../../../components/FieldError';
import TimePicker from '../../../../components/TimePicker';
import NumberStepper from '../../../../components/NumberStepper';

export default function EventDetailsStep({
  form,
  setForm,
  update,
  fieldClass,
  inputClass,
  fieldErrors,
  handleAlcoholChange,
  // Event-type autocomplete state (lives in parent so resume effect can sync setter)
  eventTypeRef,
  eventTypeInputRef,
  eventTypeQuery,
  setEventTypeQuery,
  eventTypeOpen,
  setEventTypeOpen,
  eventTypeHighlight,
  setEventTypeHighlight,
  eventTypeFiltered,
  selectEventType,
  handleEventTypeKeyDown,
  clearField,
}) {
  return (
    <div className="wz-card">
      <h3>Tell us about your event</h3>
      <div className="wz-grid">
        <div className={`form-group${fieldClass('guest_count')}`}>
          <label htmlFor="wz-guest_count" className="form-label">Guest Count *</label>
          <input id="wz-guest_count" className={`form-input${inputClass('guest_count')}`} type="number" min={form.alcohol_provider === 'hosted' ? 25 : 1} max="1000"
            value={form.guest_count} onChange={e => update('guest_count', e.target.value)}
            aria-invalid={!!fieldErrors?.guest_count} />
          <FieldError error={fieldErrors?.guest_count} />
          {form.alcohol_provider === 'hosted' && <span className="form-hint">Minimum 25 guests for hosted packages</span>}
        </div>
        <div className={`form-group${fieldClass('event_duration_hours')}`}>
          <label htmlFor="wz-event_duration_hours" className="form-label">Duration (hours) *</label>
          <NumberStepper id="wz-event_duration_hours" className={`form-input${inputClass('event_duration_hours')}`}
            min={1} max={12} step={0.5}
            value={form.event_duration_hours} onChange={v => update('event_duration_hours', v)}
            aria-invalid={!!fieldErrors?.event_duration_hours}
            ariaLabelIncrease="Increase duration" ariaLabelDecrease="Decrease duration" />
          <FieldError error={fieldErrors?.event_duration_hours} />
        </div>
        <div className={`form-group${fieldClass('event_date')}`}>
          <label htmlFor="wz-event_date" className="form-label">Event Date *</label>
          <input id="wz-event_date" className={`form-input${inputClass('event_date')}`} type="date" value={form.event_date}
            min={new Date().toISOString().split('T')[0]}
            onChange={e => update('event_date', e.target.value)}
            aria-invalid={!!fieldErrors?.event_date} />
          <FieldError error={fieldErrors?.event_date} />
        </div>
        <div className="form-group">
          <label htmlFor="wz-event_start_time" className="form-label">Start Time</label>
          <TimePicker
            id="wz-event_start_time"
            value={form.event_start_time}
            onChange={(v) => update('event_start_time', v)}
            minHour={8}
            maxHour={22}
          />
        </div>
        <div className={`form-group${fieldClass('event_city')}`}>
          <label htmlFor="wz-event_city" className="form-label">City *</label>
          <input id="wz-event_city" className={`form-input${inputClass('event_city')}`} value={form.event_city}
            onChange={e => update('event_city', e.target.value)} placeholder="e.g. Chicago"
            aria-invalid={!!fieldErrors?.event_city} />
          <FieldError error={fieldErrors?.event_city} />
        </div>
        <div className={`form-group${fieldClass('event_state')}`}>
          <label htmlFor="wz-event_state" className="form-label">State *</label>
          <select id="wz-event_state" className={`form-select${inputClass('event_state')}`} value={form.event_state}
            onChange={e => update('event_state', e.target.value)}
            aria-invalid={!!fieldErrors?.event_state}>
            <option value="">-- Select --</option>
            <option value="Illinois">Illinois</option>
            <option value="Indiana">Indiana</option>
            <option value="Michigan">Michigan</option>
            <option value="Minnesota">Minnesota</option>
            <option value="Wisconsin">Wisconsin</option>
          </select>
          <FieldError error={fieldErrors?.event_state} />
        </div>

        {/* Alcohol provider */}
        <div className={`form-group${fieldClass('alcohol_provider')}`}>
          <label htmlFor="wz-alcohol_provider" className="form-label">Who provides the alcohol? *</label>
          <select id="wz-alcohol_provider" className={`form-select${inputClass('alcohol_provider')}`} value={form.alcohol_provider}
            onChange={e => handleAlcoholChange(e.target.value)}
            aria-invalid={!!fieldErrors?.alcohol_provider}>
            <option value="">-- Select --</option>
            <option value="mocktail">No alcohol (mocktails only)</option>
            <option value="byob">I'll provide the alcohol</option>
            <option value="hosted">Dr. Bartender provides the alcohol</option>
          </select>
          <FieldError error={fieldErrors?.alcohol_provider} />
        </div>

        <div className="form-group">
          <label htmlFor="wz-needs_bar" className="form-label">Need a Portable Bar?</label>
          <select id="wz-needs_bar" className="form-select" value={form.needs_bar ? 'yes' : 'no'}
            onChange={e => update('needs_bar', e.target.value === 'yes')}>
            <option value="no">No - venue has a bar</option>
            <option value="yes">Yes - bring one</option>
          </select>
        </div>

        {/* Event Type autocomplete */}
        <div className={`form-group${fieldClass('event_type')}`} style={{ gridColumn: '1 / -1', position: 'relative' }} ref={eventTypeRef}>
          <label htmlFor="wz-event_type" className="form-label">Event Type *</label>
          <input
            id="wz-event_type"
            ref={eventTypeInputRef}
            className={`form-input${inputClass('event_type')}`}
            value={eventTypeQuery}
            onChange={e => {
              setEventTypeQuery(e.target.value);
              setEventTypeOpen(true);
              setEventTypeHighlight(-1);
              // Clear selection if user edits
              if (form.event_type) {
                setForm(f => ({ ...f, event_type: '', event_type_category: '', event_type_custom: '' }));
              }
            }}
            onFocus={() => setEventTypeOpen(true)}
            onKeyDown={handleEventTypeKeyDown}
            placeholder="Start typing... e.g. Wedding, Birthday, Corporate"
            autoComplete="off"
            aria-invalid={!!fieldErrors?.event_type}
          />
          <FieldError error={fieldErrors?.event_type || fieldErrors?.event_type_custom} />
          {eventTypeOpen && eventTypeFiltered.length > 0 && (
            <ul className="wz-event-type-dropdown">
              {eventTypeFiltered.map((et, i) => (
                <li
                  key={et.id}
                  className={`wz-event-type-option${i === eventTypeHighlight ? ' highlighted' : ''}`}
                  onMouseDown={() => selectEventType(et)}
                  onMouseEnter={() => setEventTypeHighlight(i)}
                >
                  {et.label}
                </li>
              ))}
            </ul>
          )}
          {form.event_type === 'Other' && (
            <input
              className="form-input wz-event-type-custom"
              value={form.event_type_custom}
              onChange={e => update('event_type_custom', e.target.value)}
              placeholder="Describe your event type"
              style={{ marginTop: '0.5rem' }}
            />
          )}
        </div>
      </div>

      {/* Cocktail class link */}
      <p className="wz-class-link">
        Looking for a cocktail class? <a href="/classes">Book a mixology class</a>
      </p>
    </div>
  );
}
