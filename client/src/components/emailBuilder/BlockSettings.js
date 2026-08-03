import React, { useState, lazy, Suspense } from 'react';

// Lazy like every other consumer: a static import here would drag TipTap/
// ProseMirror (~120 kB gz) eagerly into both campaign route chunks.
const RichTextEditor = lazy(() => import('../RichTextEditor'));

// ── Small reusable field controls ────────────────────────────────
function Field({ label, children }) {
  return (
    <div className="form-group" style={{ marginBottom: 12 }}>
      {label && <label className="form-label">{label}</label>}
      {children}
    </div>
  );
}

function TextInput({ label, value, onChange, placeholder }) {
  return (
    <Field label={label}>
      <input className="form-input" value={value || ''} placeholder={placeholder || ''} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

function Select({ label, value, onChange, options }) {
  return (
    <Field label={label}>
      <select className="form-input" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </Field>
  );
}

function ColorInput({ label, value, onChange }) {
  return (
    <Field label={label}>
      <input type="color" value={value || '#000000'} onChange={(e) => onChange(e.target.value)} style={{ width: 48, height: 34, padding: 2, border: '1px solid #d8ccc2', borderRadius: 6, background: '#fff', cursor: 'pointer' }} />
    </Field>
  );
}

function ImageField({ label, src, alt, onSrc, onAlt, onUploadImage }) {
  const [busy, setBusy] = useState(false);
  const pick = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    try {
      const url = await onUploadImage(file);
      if (url) onSrc(url);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Field label={label}>
      {src
        ? <img src={src} alt={alt || ''} style={{ display: 'block', maxWidth: '100%', borderRadius: 6, marginBottom: 8, border: '1px solid #eee' }} />
        : <div style={{ padding: '16px 12px', textAlign: 'center', background: '#faf7f4', border: '1px dashed #d8ccc2', borderRadius: 6, color: '#b0a396', fontSize: 13, marginBottom: 8 }}>No image yet</div>}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <label className="btn btn-secondary" style={{ margin: 0, cursor: 'pointer' }}>
          {busy ? 'Uploading…' : (src ? 'Replace image' : 'Upload image')}
          <input type="file" accept="image/png,image/jpeg,image/webp" onChange={pick} style={{ display: 'none' }} disabled={busy} />
        </label>
        {src && <button type="button" className="btn btn-secondary" onClick={() => onSrc('')}>Remove</button>}
      </div>
      {onAlt && <input className="form-input" style={{ marginTop: 8 }} placeholder="Alt text (for accessibility)" value={alt || ''} onChange={(e) => onAlt(e.target.value)} />}
    </Field>
  );
}

const ALIGN_OPTS = [{ value: 'left', label: 'Left' }, { value: 'center', label: 'Center' }, { value: 'right', label: 'Right' }];

// ── Per-type settings editors ────────────────────────────────────
export default function BlockSettings({ block, onChange, onUploadImage }) {
  if (!block) {
    return <div style={{ color: '#8a7d6f', fontSize: 14, padding: '8px 2px' }}>Select a block on the left to edit it, or add a new one.</div>;
  }
  const p = block.props || {};
  const set = (patch) => onChange({ ...p, ...patch });
  const setSide = (side, patch) => onChange({ ...p, [side]: { ...(p[side] || {}), ...patch } });

  switch (block.type) {
    case 'heading':
      return (
        <>
          <TextInput label="Heading text" value={p.text} onChange={(v) => set({ text: v })} />
          <Select label="Size" value={p.level || 'h2'} onChange={(v) => set({ level: v })} options={[{ value: 'h1', label: 'Large (H1)' }, { value: 'h2', label: 'Medium (H2)' }, { value: 'h3', label: 'Small (H3)' }]} />
          <Select label="Alignment" value={p.align || 'left'} onChange={(v) => set({ align: v })} options={ALIGN_OPTS} />
        </>
      );
    case 'text':
      return (
        <Field label="Text">
          <Suspense fallback={<div className="muted" style={{ padding: '0.5rem 0' }}>Loading editor…</div>}>
            <RichTextEditor content={p.html} onChange={(html) => set({ html })} onUploadImage={onUploadImage} placeholder="Write your message…" />
          </Suspense>
        </Field>
      );
    case 'image':
      return (
        <>
          <ImageField label="Image" src={p.src} alt={p.alt} onSrc={(src) => set({ src })} onAlt={(alt) => set({ alt })} onUploadImage={onUploadImage} />
          <TextInput label="Link to (optional)" value={p.href} onChange={(v) => set({ href: v })} placeholder="https://…" />
          <Select label="Alignment" value={p.align || 'center'} onChange={(v) => set({ align: v })} options={ALIGN_OPTS} />
          <Select label="Width" value={p.width || 'full'} onChange={(v) => set({ width: v })} options={[{ value: 'full', label: 'Full width' }, { value: 'half', label: 'Half' }, { value: 'third', label: 'Third' }]} />
        </>
      );
    case 'button':
      return (
        <>
          <TextInput label="Button label" value={p.label} onChange={(v) => set({ label: v })} />
          <TextInput label="Links to" value={p.href} onChange={(v) => set({ href: v })} placeholder="https://…" />
          <Select label="Alignment" value={p.align || 'center'} onChange={(v) => set({ align: v })} options={ALIGN_OPTS} />
          <div style={{ display: 'flex', gap: 16 }}>
            <ColorInput label="Button color" value={p.bg} onChange={(v) => set({ bg: v })} />
            <ColorInput label="Text color" value={p.color} onChange={(v) => set({ color: v })} />
          </div>
        </>
      );
    case 'hero':
      return (
        <>
          <ImageField label="Banner image" src={p.src} alt={p.alt} onSrc={(src) => set({ src })} onAlt={(alt) => set({ alt })} onUploadImage={onUploadImage} />
          <TextInput label="Headline" value={p.heading} onChange={(v) => set({ heading: v })} />
          <TextInput label="Sub-text" value={p.subtext} onChange={(v) => set({ subtext: v })} />
          <TextInput label="Button label" value={p.buttonLabel} onChange={(v) => set({ buttonLabel: v })} />
          <TextInput label="Button links to" value={p.buttonHref} onChange={(v) => set({ buttonHref: v })} placeholder="https://…" />
        </>
      );
    case 'columns':
      return (
        <>
          {['left', 'right'].map((side) => (
            <div key={side} style={{ borderTop: '1px solid #f0e9e2', paddingTop: 10, marginTop: 6 }}>
              <div style={{ fontWeight: 'bold', color: '#6b4226', marginBottom: 8, textTransform: 'capitalize' }}>{side} column</div>
              <ImageField label="Image (optional)" src={(p[side] || {}).src} alt={(p[side] || {}).alt} onSrc={(src) => setSide(side, { src })} onAlt={(alt) => setSide(side, { alt })} onUploadImage={onUploadImage} />
              <Field label="Text">
                <Suspense fallback={<div className="muted" style={{ padding: '0.5rem 0' }}>Loading editor…</div>}>
                  <RichTextEditor content={(p[side] || {}).html} onChange={(html) => setSide(side, { html })} onUploadImage={onUploadImage} placeholder="Column text…" />
                </Suspense>
              </Field>
            </div>
          ))}
        </>
      );
    case 'spacer':
      return (
        <Field label={`Height: ${p.height || 24}px`}>
          <input type="range" min="4" max="120" step="4" value={p.height || 24} onChange={(e) => set({ height: parseInt(e.target.value, 10) })} style={{ width: '100%' }} />
        </Field>
      );
    case 'divider':
      return <div style={{ color: '#8a7d6f', fontSize: 14 }}>A divider has no settings — just a clean horizontal line.</div>;
    default:
      return null;
  }
}
