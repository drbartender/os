import React, { useCallback, useEffect, useRef, useState } from 'react';

function clamp(v, min, max) {
  if (min !== undefined && min !== null && v < min) return min;
  if (max !== undefined && max !== null && v > max) return max;
  return v;
}

function snapToStep(v, step, min) {
  if (!step) return v;
  const base = (min !== undefined && min !== null) ? min : 0;
  const k = Math.round((v - base) / step);
  return Number((base + k * step).toFixed(10));
}

function strip(n) {
  return Number(n.toFixed(10));
}

export default function NumberStepper({
  value = '',
  onChange,
  min,
  max,
  step = 1,
  className = 'form-input',
  placeholder = '',
  disabled = false,
  required = false,
  id,
  name,
  style,
  'aria-invalid': ariaInvalid,
  'aria-describedby': ariaDescribedBy,
  ariaLabelIncrease = 'Increase',
  ariaLabelDecrease = 'Decrease',
}) {
  const [displayValue, setDisplayValue] = useState(value === null || value === undefined ? '' : String(value));
  const [isFlashing, setIsFlashing] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    setDisplayValue(value === null || value === undefined ? '' : String(value));
  }, [value]);

  const flash = useCallback(() => {
    setIsFlashing(true);
    const t = setTimeout(() => setIsFlashing(false), 400);
    return () => clearTimeout(t);
  }, []);

  const commit = useCallback((next) => {
    const s = next === '' ? '' : String(next);
    if (s !== String(value ?? '')) onChange(s);
    setDisplayValue(s);
  }, [value, onChange]);

  const stepBy = useCallback((dir) => {
    const raw = (value === '' || value === null || value === undefined) ? null : Number(value);
    let next;
    if (raw === null || Number.isNaN(raw)) {
      if (dir > 0) next = (min !== undefined && min !== null) ? min : step;
      else next = (max !== undefined && max !== null) ? max : -step;
    } else {
      const snapped = snapToStep(raw, step, min);
      if (dir > 0) {
        next = snapped <= raw ? snapped + step : snapped;
      } else {
        next = snapped >= raw ? snapped - step : snapped;
      }
    }
    next = strip(clamp(next, min, max));
    commit(next);
  }, [value, min, max, step, commit]);

  const handleBlur = () => {
    const raw = displayValue.trim();
    if (raw === '') {
      if (value !== '' && value !== null && value !== undefined) onChange('');
      setDisplayValue('');
      return;
    }
    const n = Number(raw);
    if (Number.isNaN(n)) {
      setDisplayValue(value === null || value === undefined ? '' : String(value));
      flash();
      return;
    }
    commit(strip(clamp(n, min, max)));
  };

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      stepBy(1);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      stepBy(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      inputRef.current?.blur();
    }
  };

  const cur = (value === '' || value === null || value === undefined) ? null : Number(value);
  const atMin = cur !== null && !Number.isNaN(cur) && min !== undefined && min !== null && cur <= min;
  const atMax = cur !== null && !Number.isNaN(cur) && max !== undefined && max !== null && cur >= max;

  return (
    <div className={`number-stepper${isFlashing ? ' number-stepper-flash' : ''}${disabled ? ' number-stepper-disabled' : ''}`}>
      <input
        ref={inputRef}
        type="text"
        inputMode="decimal"
        className={`number-stepper-input ${className}`.trim()}
        value={displayValue}
        onChange={(e) => setDisplayValue(e.target.value)}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        required={required}
        id={id}
        name={name}
        style={style}
        aria-invalid={ariaInvalid}
        aria-describedby={ariaDescribedBy}
        autoComplete="off"
      />
      <div className="number-stepper-steppers">
        <button
          type="button"
          aria-label={ariaLabelIncrease}
          disabled={disabled || atMax}
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => stepBy(1)}
        >▲</button>
        <button
          type="button"
          aria-label={ariaLabelDecrease}
          disabled={disabled || atMin}
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => stepBy(-1)}
        >▼</button>
      </div>
    </div>
  );
}
