import React, { useLayoutEffect } from 'react';

// Small parts the editor's right panel shares (spec 2026-10-01 section 11.1,
// Right panel): the section label, the .seg picker and the inert switch.
//
// Section({ label, note, num, className, children }): an 11 px uppercase label
//   with an optional note on the right (num: the numeric face, as the Drinks
//   count reads).
// Seg({ label, options: [[value, text, { disabled, title }?]], value, onChange,
//   disabled }): the app's .seg, one active button, aria-pressed.
// useInert(ref, off): sets the inert attribute through the ref while off (React
//   18 has no inert prop), so the tab can be neither clicked nor focused.

export const OPEN = new Set(['pending', 'working']);
export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const list = (v) => (Array.isArray(v) ? v.filter(isObj) : []);

export function Section({ label, note, num = false, className, children }) {
  return (
    <section className={className ? `md-sec ${className}` : 'md-sec'}>
      <div className="md-sec-head">
        <span className="md-sec-label">{label}</span>
        {note && <span className={num ? 'md-sec-note md-num' : 'md-sec-note'}>{note}</span>}
      </div>
      {children}
    </section>
  );
}

export function Seg({ label, options, value, onChange, disabled = false, className }) {
  return (
    <div className={className ? `seg ${className}` : 'seg'} role="group" aria-label={label}>
      {options.map(([v, text, opt = {}]) => (
        <button key={String(v)} type="button" className={v === value ? 'active' : ''} aria-pressed={v === value}
          disabled={disabled || !!opt.disabled} title={opt.title || undefined}
          onClick={() => { if (v !== value && typeof onChange === 'function') onChange(v); }}>
          {text}
        </button>
      ))}
    </div>
  );
}

export function useInert(ref, off) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (off) el.setAttribute('inert', '');
    else el.removeAttribute('inert');
  }, [ref, off]);
}

// Why no image can be drawn now ('' when one can): no key, or no image left
// under the cap (table B's Drawing is off and Image limit).
export function rerollWhy(configured, cap) {
  if (!(isObj(configured) && configured.openai)) return "Drawing is off. The AI key isn't on the server.";
  if (isObj(cap) && Number(cap.remaining) <= 0) return 'Daily image limit reached.';
  return '';
}

// A read-only draft (no plan on the event, table B's "No drink plan"): nothing
// in the panel PATCHes or re-rolls. The editor may pass readOnly; the draft's
// own read_only flag counts either way.
export const READ_ONLY_WHY = 'No drink plan on this event. The draft is read-only.';
export function isReadOnly(draft, readOnly) {
  return readOnly === true || !!(isObj(draft) && draft.read_only === true);
}

// The draft's words have landed (text and the Design and Drinks tabs are live).
export function wordsLanded(draft) {
  return !!(isObj(draft) && isObj(draft.content) && draft.content.words_status === 'done');
}

// A draft exists whose words did not fail (the footer reads Start over).
export function hasLiveDraft(draft) {
  if (!isObj(draft)) return false;
  const w = isObj(draft.content) ? draft.content.words_status : null;
  return w === 'done' || OPEN.has(w);
}
