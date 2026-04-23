import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatTime12h, generateTimeOptions, parseTimeInput } from '../utils/timeOptions';

function toMinutes(hhmm) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function fromMinutes(total) {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export default function TimePicker({
  value = '',
  onChange,
  minHour = 0,
  maxHour = 23,
  className = 'form-input',
  placeholder = '—:— —',
  disabled = false,
  required = false,
  id,
  name,
}) {
  const [displayValue, setDisplayValue] = useState(formatTime12h(value));
  const [isOpen, setIsOpen] = useState(false);
  const [isFlashing, setIsFlashing] = useState(false);
  const wrapperRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  // Keep display in sync when parent updates value externally
  useEffect(() => {
    setDisplayValue(formatTime12h(value));
  }, [value]);

  const slots = useMemo(() => generateTimeOptions(minHour, maxHour + 1), [minHour, maxHour]);

  const flash = useCallback(() => {
    setIsFlashing(true);
    const t = setTimeout(() => setIsFlashing(false), 400);
    return () => clearTimeout(t);
  }, []);

  const commit = useCallback((next) => {
    if (next !== value) onChange(next);
    setDisplayValue(formatTime12h(next));
  }, [value, onChange]);

  const stepBy = useCallback((mins) => {
    const minTotal = minHour * 60;
    const maxTotal = maxHour * 60 + 30;
    let total;
    const cur = toMinutes(value);
    if (cur === null) {
      total = mins > 0 ? minTotal : maxTotal;
    } else if (mins > 0) {
      // snap up to next 30-min grid line
      total = Math.floor(cur / 30) * 30 + 30;
      if (total <= cur) total = cur + 30;
    } else {
      // snap down to previous 30-min grid line
      total = Math.ceil(cur / 30) * 30 - 30;
      if (total >= cur) total = cur - 30;
    }
    if (total < minTotal) total = minTotal;
    if (total > maxTotal) total = maxTotal;
    commit(fromMinutes(total));
  }, [value, minHour, maxHour, commit]);

  const handleBlur = () => {
    const raw = displayValue.trim();
    if (raw === '') {
      if (value !== '') onChange('');
      setDisplayValue('');
      return;
    }
    const parsed = parseTimeInput(raw, { minHour, maxHour });
    if (parsed === null) {
      setDisplayValue(formatTime12h(value));
      flash();
    } else {
      commit(parsed);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      inputRef.current?.blur();
    } else if (e.key === 'Escape' && isOpen) {
      e.preventDefault();
      setIsOpen(false);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      stepBy(30);
    } else if (e.key === 'ArrowDown') {
      if (e.altKey) {
        e.preventDefault();
        setIsOpen(true);
      } else {
        e.preventDefault();
        stepBy(-30);
      }
    }
  };

  // Close dropdown on outside click
  useEffect(() => {
    if (!isOpen) return undefined;
    const handler = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen]);

  // Scroll highlighted slot into view when opening
  useEffect(() => {
    if (!isOpen || !listRef.current) return;
    const active = listRef.current.querySelector('li.selected, li[data-nearest="true"]');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }, [isOpen]);

  const cur = useMemo(() => toMinutes(value), [value]);
  const atMin = cur !== null && cur <= minHour * 60;
  const atMax = cur !== null && cur >= maxHour * 60 + 30;

  // Find highlighted slot: exact match if on-grid, else nearest lower
  const nearestIndex = useMemo(() => {
    if (cur === null) return -1;
    for (let i = slots.length - 1; i >= 0; i--) {
      if (toMinutes(slots[i].value) <= cur) return i;
    }
    return -1;
  }, [cur, slots]);

  return (
    <div ref={wrapperRef} className={`time-picker${isFlashing ? ' time-picker-flash' : ''}${disabled ? ' time-picker-disabled' : ''}`}>
      <input
        ref={inputRef}
        type="text"
        className={`time-picker-input ${className}`.trim()}
        value={displayValue}
        onChange={(e) => setDisplayValue(e.target.value)}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        required={required}
        id={id}
        name={name}
        autoComplete="off"
      />
      <div className="time-picker-steppers">
        <button
          type="button"
          aria-label="Increase time by 30 minutes"
          disabled={disabled || atMax}
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => stepBy(30)}
        >▲</button>
        <button
          type="button"
          aria-label="Decrease time by 30 minutes"
          disabled={disabled || atMin}
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => stepBy(-30)}
        >▼</button>
      </div>
      <button
        type="button"
        className="time-picker-chevron"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label="Open time list"
        disabled={disabled}
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setIsOpen((o) => !o)}
      >▾</button>
      {isOpen && (
        <ul ref={listRef} className="time-picker-dropdown" role="listbox">
          {slots.map((slot, i) => {
            const selected = slot.value === value;
            const nearest = !selected && i === nearestIndex;
            return (
              <li
                key={slot.value}
                role="option"
                aria-selected={selected}
                data-nearest={nearest ? 'true' : undefined}
                className={selected ? 'selected' : ''}
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(slot.value);
                  setIsOpen(false);
                }}
              >
                {slot.label}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
