import React, { useState, useMemo } from 'react';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import BlockCard from './BlockCard';
import BlockSettings from './BlockSettings';
import EmailPreviewModal from './EmailPreviewModal';
import { BLOCK_TYPES, makeBlock, cloneBlock } from './blockCatalog';
import { TEMPLATES } from './starterTemplates';

/**
 * Drag-and-drop email designer.
 * @param {Array} value      ordered blocks [{id,type,props}]
 * @param {Function} onChange (blocks) => void
 * @param {Function} onUploadImage (file) => Promise<url|null>
 */
export default function EmailBlockBuilder({ value, onChange, onUploadImage }) {
  const blocks = useMemo(() => (Array.isArray(value) ? value : []), [value]);
  const [selectedId, setSelectedId] = useState(null);
  const [showPreview, setShowPreview] = useState(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const selected = useMemo(() => blocks.find((b) => b.id === selectedId) || null, [blocks, selectedId]);
  const designForPreview = useMemo(() => ({ version: 1, blocks }), [blocks]);

  const addBlock = (type) => {
    const b = makeBlock(type);
    onChange([...blocks, b]);
    setSelectedId(b.id);
  };
  const updateSelected = (props) => onChange(blocks.map((b) => (b.id === selectedId ? { ...b, props } : b)));
  const deleteBlock = (id) => {
    onChange(blocks.filter((b) => b.id !== id));
    if (selectedId === id) setSelectedId(null);
  };
  const duplicateBlock = (id) => {
    const idx = blocks.findIndex((b) => b.id === id);
    if (idx < 0) return;
    const copy = cloneBlock(blocks[idx]);
    const next = [...blocks];
    next.splice(idx + 1, 0, copy);
    onChange(next);
    setSelectedId(copy.id);
  };
  const onDragEnd = ({ active, over }) => {
    if (!over || active.id === over.id) return;
    const oldIndex = blocks.findIndex((b) => b.id === active.id);
    const newIndex = blocks.findIndex((b) => b.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    onChange(arrayMove(blocks, oldIndex, newIndex));
  };
  const applyTemplate = (tpl) => {
    if (blocks.length && !window.confirm('Replace the current design with this template? Your current blocks will be cleared.')) return;
    const next = tpl.build();
    onChange(next);
    setSelectedId(next[0] ? next[0].id : null);
  };

  return (
    <div>
      {/* Toolbar */}
      <div style={toolbar}>
        <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          <span style={{ fontWeight: 'bold', color: '#6b4226', marginRight: 4 }}>Add:</span>
          {BLOCK_TYPES.map((b) => (
            <button key={b.type} type="button" className="btn btn-secondary" title={b.hint} onClick={() => addBlock(b.type)} style={{ padding: '5px 10px', fontSize: 13 }}>+ {b.label}</button>
          ))}
        </span>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <select className="form-input" defaultValue="" onChange={(e) => { const t = TEMPLATES.find((x) => x.key === e.target.value); if (t) applyTemplate(t); e.target.value = ''; }} style={{ padding: '6px 8px', fontSize: 13, maxWidth: 180 }}>
            <option value="" disabled>Start from template…</option>
            {TEMPLATES.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}
          </select>
          <button type="button" className="btn btn-secondary" onClick={() => setShowPreview(true)} disabled={!blocks.length}>Preview</button>
        </span>
      </div>

      {/* Canvas + settings */}
      <div style={grid}>
        <div style={canvasCol}>
          {blocks.length === 0 ? (
            <div style={empty}>
              <div style={{ fontSize: 15, marginBottom: 6 }}>Your email is empty.</div>
              <div>Add a block above, or pick a <strong>template</strong> to start from a designed layout.</div>
            </div>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={blocks.map((b) => b.id)} strategy={verticalListSortingStrategy}>
                {blocks.map((b) => (
                  <BlockCard key={b.id} block={b} selected={b.id === selectedId} onSelect={setSelectedId} onDelete={deleteBlock} onDuplicate={duplicateBlock} />
                ))}
              </SortableContext>
            </DndContext>
          )}
        </div>
        <div style={settingsCol}>
          <div style={{ fontWeight: 'bold', color: '#3b2314', marginBottom: 10 }}>{selected ? 'Edit block' : 'Block settings'}</div>
          <BlockSettings block={selected} onChange={updateSelected} onUploadImage={onUploadImage} />
        </div>
      </div>

      {showPreview && <EmailPreviewModal design={designForPreview} onClose={() => setShowPreview(false)} />}
    </div>
  );
}

const toolbar = { display: 'flex', flexWrap: 'wrap', gap: 10, justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', background: '#fbf8f5', border: '1px solid #e7ddd4', borderRadius: 8, marginBottom: 12 };
const grid = { display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' };
const canvasCol = { flex: '1 1 340px', minWidth: 300, background: '#f4efe9', borderRadius: 8, padding: 12, minHeight: 200 };
const settingsCol = { flex: '1 1 300px', minWidth: 280, maxWidth: 420, background: '#fff', border: '1px solid #e7ddd4', borderRadius: 8, padding: 16, position: 'sticky', top: 12 };
const empty = { textAlign: 'center', color: '#8a7d6f', padding: '40px 16px', fontFamily: 'Georgia, serif', lineHeight: 1.6 };
