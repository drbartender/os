import React, { useState, useEffect, useRef } from 'react';
import VenueAddressFields from '../../../components/VenueAddressFields';
import EVENT_TYPES from '../../../data/eventTypes';
import { enforceHostedMinimum } from '../../../utils/proposalRules';
import FieldError from '../../../components/FieldError';
import TimePicker from '../../../components/TimePicker';
import NumberStepper from '../../../components/NumberStepper';
import { Lbl } from './helpers';

export default function EventSection({ form, update, merge, fieldErrors, isHostedPackage }) {
  const [eventTypeQuery, setEventTypeQuery] = useState(form.event_type || '');
  const [eventTypeOpen, setEventTypeOpen] = useState(false);
  const [eventTypeHighlight, setEventTypeHighlight] = useState(-1);
  const eventTypeRef = useRef(null);

  const eventTypeFiltered = eventTypeQuery.length >= 1
    ? EVENT_TYPES.filter(et => et.id === 'other' || et.label.toLowerCase().includes(eventTypeQuery.toLowerCase()))
    : EVENT_TYPES;

  useEffect(() => {
    const handler = (e) => {
      if (eventTypeRef.current && !eventTypeRef.current.contains(e.target)) setEventTypeOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const selectEventType = (et) => {
    merge({
      event_type: et.label,
      event_type_category: et.category,
      event_type_custom: et.id === 'other' ? form.event_type_custom : '',
    });
    setEventTypeQuery(et.label === 'Other' ? '' : et.label);
    setEventTypeOpen(false);
    setEventTypeHighlight(-1);
  };

  const handleEventTypeKeyDown = (e) => {
    if (!eventTypeOpen) return;
    const list = eventTypeFiltered;
    if (e.key === 'ArrowDown') { e.preventDefault(); setEventTypeHighlight(h => Math.min(h + 1, list.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setEventTypeHighlight(h => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (eventTypeHighlight >= 0 && eventTypeHighlight < list.length) selectEventType(list[eventTypeHighlight]); }
    else if (e.key === 'Escape') setEventTypeOpen(false);
  };

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {/* Row 1 — Type + Date */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
        <Lbl text="Type">
          <div style={{ position: 'relative' }} ref={eventTypeRef}>
            <input
              className="input"
              value={eventTypeQuery}
              onChange={(e) => {
                setEventTypeQuery(e.target.value);
                setEventTypeOpen(true);
                setEventTypeHighlight(-1);
                if (form.event_type) merge({ event_type: '', event_type_category: '', event_type_custom: '' });
              }}
              onFocus={() => setEventTypeOpen(true)}
              onKeyDown={handleEventTypeKeyDown}
              placeholder="Wedding, Birthday…"
              autoComplete="off"
              style={{ width: '100%' }}
            />
            {eventTypeOpen && eventTypeFiltered.length > 0 && (
              <ul style={{
                position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0,
                zIndex: 10, listStyle: 'none', margin: 0, padding: 4,
                background: 'var(--bg-elev)', border: '1px solid var(--line-1)',
                borderRadius: 4, boxShadow: 'var(--shadow-pop)',
                maxHeight: 220, overflow: 'auto',
              }}>
                {eventTypeFiltered.map((et, i) => (
                  <li
                    key={et.id}
                    onMouseDown={() => selectEventType(et)}
                    onMouseEnter={() => setEventTypeHighlight(i)}
                    style={{
                      padding: '6px 8px', cursor: 'pointer', borderRadius: 3, fontSize: 12.5,
                      background: i === eventTypeHighlight ? 'var(--row-hover)' : 'transparent',
                    }}
                  >
                    {et.label}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <FieldError error={fieldErrors?.event_type} />
        </Lbl>

        <Lbl text="Date">
          <input
            className="input"
            type="date"
            value={form.event_date}
            onChange={(e) => update('event_date', e.target.value)}
            placeholder="mm/dd/yyyy"
            style={{ width: '100%' }}
          />
        </Lbl>
      </div>

      {form.event_type === 'Other' && (
        <Lbl text="Custom event type">
          <input
            className="input"
            value={form.event_type_custom}
            onChange={(e) => update('event_type_custom', e.target.value)}
            placeholder="Describe the event"
            style={{ width: '100%' }}
          />
        </Lbl>
      )}

      {/* Row 2 — Start / Hrs / Guests / Bars */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(80px, 1fr))', gap: 8 }}>
        <Lbl text="Start">
          <TimePicker
            className="input"
            value={form.event_start_time}
            onChange={(v) => update('event_start_time', v)}
            minHour={6}
            maxHour={23}
          />
        </Lbl>

        <Lbl text="Hrs">
          <NumberStepper
            className="input num"
            min={1} max={12} step={0.5}
            value={form.event_duration_hours}
            onChange={(v) => update('event_duration_hours', v)}
            style={{ width: '100%', textAlign: 'right' }}
            ariaLabelIncrease="Increase duration" ariaLabelDecrease="Decrease duration"
          />
        </Lbl>

        <Lbl text="Guests">
          <input
            className="input num"
            type="number"
            min="1" max="1000"
            value={form.guest_count}
            onChange={(e) => update('guest_count', e.target.value)}
            onBlur={(e) => update('guest_count', enforceHostedMinimum(e.target.value, isHostedPackage))}
            style={{ width: '100%', textAlign: 'right' }}
          />
        </Lbl>

        <Lbl text="Bars">
          <input
            className="input num"
            type="number"
            min="0" max="5"
            value={form.num_bars}
            onChange={(e) => update('num_bars', e.target.value)}
            style={{ width: '100%', textAlign: 'right' }}
          />
        </Lbl>
      </div>

      {/* Row 3 — Venue full width. Not wrapped in <Lbl> (which renders a <label>) — VenueAddressFields renders its own per-field labels, and nested labels are invalid HTML. */}
      <div>
        <div className="tiny mono" style={{ color: 'var(--ink-3)', marginBottom: 3, textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 9.5 }}>
          Venue / location
        </div>
        <VenueAddressFields
          value={form}
          onChange={(field, val) => update(field, val)}
          fieldErrors={fieldErrors}
          inputClassName="input"
          selectClassName="select"
          labelClassName="meta-k"
        />
      </div>
    </div>
  );
}
