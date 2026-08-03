import React from 'react';
import DOMPurify from 'dompurify';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { BRAND, blockLabel } from './blockCatalog';

const clean = (html) => DOMPurify.sanitize(html || '');

// Lightweight visual approximation of a block for the editing canvas. The
// exact, as-sent rendering comes from the server preview endpoint.
function BlockPreview({ block }) {
  const p = block.props || {};
  switch (block.type) {
    case 'heading': {
      const size = p.level === 'h1' ? 26 : p.level === 'h3' ? 17 : 21;
      return <div style={{ fontWeight: 'bold', fontSize: size, color: BRAND.primary, textAlign: p.align || 'left', fontFamily: 'Georgia, serif' }}>{p.text || 'Heading'}</div>;
    }
    case 'text':
      return <div style={{ fontFamily: 'Georgia, serif', fontSize: 15, lineHeight: 1.6, color: BRAND.primary }} dangerouslySetInnerHTML={{ __html: clean(p.html) || '<span style="color:#aaa">Empty text</span>' }} />;
    case 'image':
      return p.src
        ? <img src={p.src} alt={p.alt || ''} style={{ display: 'block', maxWidth: '100%', margin: p.align === 'center' ? '0 auto' : 0, borderRadius: 6 }} />
        : <Placeholder label="Image — add a photo in the panel →" />;
    case 'button':
      return <div style={{ textAlign: p.align || 'center' }}><span style={{ display: 'inline-block', padding: '12px 26px', background: p.bg || BRAND.primary, color: p.color || BRAND.white, borderRadius: 6, fontWeight: 'bold', fontFamily: 'Georgia, serif' }}>{p.label || 'Button'}</span></div>;
    case 'hero':
      return (
        <div>
          {p.src ? <img src={p.src} alt={p.alt || ''} style={{ display: 'block', width: '100%', borderRadius: 8, marginBottom: 10 }} /> : <Placeholder label="Hero image — add a photo →" />}
          <div style={{ textAlign: 'center', fontWeight: 'bold', fontSize: 22, color: BRAND.primary, fontFamily: 'Georgia, serif', marginTop: 8 }}>{p.heading}</div>
          {p.subtext && <div style={{ textAlign: 'center', color: BRAND.secondary, fontFamily: 'Georgia, serif', marginTop: 4 }}>{p.subtext}</div>}
          {p.buttonLabel && <div style={{ textAlign: 'center', marginTop: 10 }}><span style={{ display: 'inline-block', padding: '10px 22px', background: BRAND.primary, color: BRAND.white, borderRadius: 6, fontWeight: 'bold', fontFamily: 'Georgia, serif' }}>{p.buttonLabel}</span></div>}
        </div>
      );
    case 'columns':
      return (
        <div style={{ display: 'flex', gap: 12 }}>
          {['left', 'right'].map((side) => {
            const s = p[side] || {};
            return (
              <div key={side} style={{ flex: 1 }}>
                {s.src ? <img src={s.src} alt={s.alt || ''} style={{ display: 'block', maxWidth: '100%', borderRadius: 6, marginBottom: 6 }} /> : null}
                <div style={{ fontFamily: 'Georgia, serif', fontSize: 14, color: BRAND.primary }} dangerouslySetInnerHTML={{ __html: clean(s.html) || '<span style="color:#aaa">Empty</span>' }} />
              </div>
            );
          })}
        </div>
      );
    case 'divider':
      return <hr style={{ border: 0, borderTop: '1px solid #e0d6cf', margin: '6px 0' }} />;
    case 'spacer':
      return <div style={{ height: Math.min(120, Math.max(4, p.height || 24)), border: '1px dashed #d8ccc2', borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#b0a396', fontSize: 12 }}>Spacer · {p.height || 24}px</div>;
    default:
      return <Placeholder label={block.type} />;
  }
}

function Placeholder({ label }) {
  return <div style={{ padding: '22px 12px', textAlign: 'center', background: '#faf7f4', border: '1px dashed #d8ccc2', borderRadius: 6, color: '#b0a396', fontSize: 13 }}>{label}</div>;
}

export default function BlockCard({ block, selected, onSelect, onDelete, onDuplicate }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: block.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    border: selected ? `2px solid ${BRAND.secondary}` : '1px solid #e7ddd4',
    borderRadius: 8,
    background: '#fff',
    marginBottom: 10,
    position: 'relative',
  };
  return (
    <div ref={setNodeRef} style={style} onClick={() => onSelect(block.id)}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 8px', borderBottom: '1px solid #f0e9e2', background: selected ? '#f7f1ec' : '#fbf8f5', borderRadius: '7px 7px 0 0' }}>
        <button type="button" {...attributes} {...listeners} title="Drag to reorder" onClick={(e) => e.stopPropagation()} style={{ cursor: 'grab', border: 'none', background: 'transparent', color: '#a89b8d', fontSize: 14, padding: '2px 6px' }}>⠿ {blockLabel(block.type)}</button>
        <span style={{ display: 'flex', gap: 4 }}>
          <button type="button" title="Duplicate" onClick={(e) => { e.stopPropagation(); onDuplicate(block.id); }} style={iconBtn}>Duplicate</button>
          <button type="button" title="Delete" onClick={(e) => { e.stopPropagation(); onDelete(block.id); }} style={{ ...iconBtn, color: '#b3261e' }}>Delete</button>
        </span>
      </div>
      {/* Links inside authored rich text must not navigate the admin away
          mid-edit (unsaved blocks would be lost) — the canvas is for editing. */}
      <div
        style={{ padding: 14 }}
        onClickCapture={(e) => { if (e.target.closest && e.target.closest('a')) e.preventDefault(); }}
      >
        <BlockPreview block={block} />
      </div>
    </div>
  );
}

const iconBtn = { border: 'none', background: 'transparent', color: '#8a7d6f', fontSize: 12, cursor: 'pointer', padding: '2px 6px' };
