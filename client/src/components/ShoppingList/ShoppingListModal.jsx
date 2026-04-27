import React, { useState, useCallback, useRef, useEffect } from 'react';
import { generateShoppingListPDF } from './ShoppingListPDF';
import { generateShoppingList } from './generateShoppingList';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import api from '../../utils/api';
import { PUBLIC_SITE_URL } from '../../utils/constants';

export default function ShoppingListModal({ listData, onClose, planId, planToken }) {
  const [edited, setEdited] = useState(() => deepClone(listData));
  const [guestCount, setGuestCount] = useState(listData.guestCount);
  const [downloading, setDownloading] = useState(false);
  const [pdfError, setPdfError] = useState('');
  const [undoStack, setUndoStack] = useState([]);
  const [saveStatus, setSaveStatus] = useState('saved'); // 'saved' | 'saving' | 'unsaved'
  const [linkCopied, setLinkCopied] = useState(false);
  const [approveStatus, setApproveStatus] = useState('idle'); // 'idle' | 'approving' | 'approved'
  const [approveError, setApproveError] = useState('');
  const isFirstRender = useRef(true);
  const saveTimer = useRef(null);

  // Fetch current shopping_list_status so the Approve button reflects whether
  // admin has already sent the list to the client.
  useEffect(() => {
    if (!planId) return;
    let cancelled = false;
    api.get(`/drink-plans/${planId}/shopping-list`)
      .then(r => {
        if (!cancelled && r.data?.shopping_list_status === 'approved') {
          setApproveStatus('approved');
        }
      })
      .catch(() => { /* non-fatal — leave Approve enabled */ });
    return () => { cancelled = true; };
  }, [planId]);

  function deepClone(d) {
    const uid = () => typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
    return {
      ...d,
      liquorBeerWine: d.liquorBeerWine.map(r => ({ ...r, _id: r._id || uid() })),
      everythingElse: d.everythingElse.map(r => ({ ...r, _id: r._id || uid() })),
    };
  }

  // Auto-save with debounce
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    if (!planId) return;

    setSaveStatus('unsaved');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaveStatus('saving');
      try {
        await api.put(`/drink-plans/${planId}/shopping-list`, {
          shopping_list: {
            ...edited,
            guestCount: parseInt(guestCount, 10) || edited.guestCount,
          },
        });
        setSaveStatus('saved');
      } catch (err) {
        console.error('Auto-save failed:', err);
        setSaveStatus('unsaved');
      }
    }, 1500);

    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edited, guestCount, planId]);

  const resetList = useCallback((count = guestCount) => {
    const fresh = generateShoppingList({
      clientName: listData.clientName,
      guestCount: count,
      signatureCocktails: listData._signatureCocktails || (listData.signatureCocktailNames || []).map(name => ({ name, ingredients: [] })),
      syrupSelfProvided: listData._syrupSelfProvided || [],
      eventDate: listData.eventDate,
      notes: listData.notes,
      serviceStyle: listData.serviceStyle || 'full_bar',
      beerSelections: listData.beerSelections || [],
      wineSelections: listData.wineSelections || [],
      mixersForSignatureDrinks: listData.mixersForSignatureDrinks,
    });
    setEdited(deepClone(fresh));
    setUndoStack([]);
  }, [listData, guestCount]);

  const handleGuestCountChange = (val) => {
    setGuestCount(val);
  };

  const handleGuestCountBlur = () => {
    const count = parseInt(guestCount, 10);
    if (count > 0 && count !== edited.guestCount) {
      if (window.confirm(`Recalculate quantities for ${count} guests?`)) {
        resetList(count);
      }
    }
  };

  const updateItem = (section, index, field, value) => {
    setEdited(prev => {
      const next = deepClone(prev);
      next[section][index] = { ...next[section][index], [field]: field === 'qty' ? (parseInt(value, 10) || 0) : value };
      return next;
    });
  };

  const removeItem = (section, index) => {
    setEdited(prev => {
      const next = deepClone(prev);
      const removed = next[section][index];
      setUndoStack(stack => [...stack, { section, index, item: { ...removed } }]);
      next[section] = next[section].filter((_, i) => i !== index);
      return next;
    });
  };

  const undoLastDelete = () => {
    setUndoStack(stack => {
      if (stack.length === 0) return stack;
      const newStack = [...stack];
      const last = newStack.pop();
      setEdited(prev => {
        const next = deepClone(prev);
        const insertAt = Math.min(last.index, next[last.section].length);
        next[last.section].splice(insertAt, 0, { ...last.item });
        return next;
      });
      return newStack;
    });
  };

  const addItem = (section) => {
    const uid = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
    setEdited(prev => {
      const next = deepClone(prev);
      next[section] = [...next[section], { _id: uid, item: '', size: '', qty: 1 }];
      return next;
    });
  };

  const handleDragEnd = (section) => (event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setEdited(prev => {
      const next = deepClone(prev);
      const items = next[section];
      const oldIndex = items.findIndex(i => i._id === active.id);
      const newIndex = items.findIndex(i => i._id === over.id);
      if (oldIndex === -1 || newIndex === -1) return prev;
      next[section] = arrayMove(items, oldIndex, newIndex);
      return next;
    });
  };

  const handleDownload = async () => {
    setDownloading(true);
    setPdfError('');
    try {
      const finalData = {
        ...edited,
        guestCount: parseInt(guestCount, 10) || edited.guestCount,
        eventTypeLabel: edited.eventTypeLabel || listData.eventTypeLabel,
      };
      const blob = await generateShoppingListPDF(finalData);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `DRB_ShoppingList_${(edited.clientName || 'Event').replace(/\s+/g, '_')}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('PDF generation failed:', err);
      setPdfError('PDF generation failed. Please try again.');
    } finally {
      setDownloading(false);
    }
  };

  const handleShareLink = () => {
    if (!planToken) return;
    const url = `${PUBLIC_SITE_URL}/shopping-list/${planToken}`;
    navigator.clipboard.writeText(url).then(() => {
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    }).catch(() => {
      window.prompt('Copy this link:', url);
    });
  };

  const handleApproveAndSend = async () => {
    if (!planId) return;
    // Flush any pending auto-save before approving so the version that goes
    // out matches what admin sees on screen.
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    setApproveStatus('approving');
    setApproveError('');
    try {
      // First save current state synchronously (in case admin edited and
      // hasn't waited 1.5s for the debounce to fire).
      await api.put(`/drink-plans/${planId}/shopping-list`, {
        shopping_list: {
          ...edited,
          guestCount: parseInt(guestCount, 10) || edited.guestCount,
        },
      });
      setSaveStatus('saved');
      // Now flip the status to approved + email the client.
      await api.patch(`/drink-plans/${planId}/shopping-list/approve`);
      setApproveStatus('approved');
    } catch (err) {
      console.error('Approve failed:', err);
      setApproveStatus('idle');
      setApproveError(err?.message || 'Failed to approve. Try again.');
    }
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor)
  );

  const saveIndicator = saveStatus === 'saving' ? 'Saving...'
    : saveStatus === 'saved' ? 'Saved'
    : 'Unsaved';
  const saveColor = saveStatus === 'saved' ? '#4caf50' : saveStatus === 'saving' ? '#D49549' : '#ff9800';

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      backgroundColor: 'rgba(0,0,0,0.65)',
      display: 'flex', flexDirection: 'column',
      overflowY: 'auto',
      paddingTop: 'calc(60px + 1.5rem)',
    }}>
      <div style={{
        backgroundColor: 'var(--cream)',
        margin: '0 auto 1.5rem',
        width: '100%',
        maxWidth: 960,
        borderRadius: 8,
        boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
        display: 'flex',
        flexDirection: 'column',
      }}>

        {/* ── Modal Header ── */}
        <div style={{
          backgroundColor: '#1A1410',
          borderRadius: '8px 8px 0 0',
          padding: '0.875rem 1.25rem',
          display: 'flex',
          alignItems: 'center',
          gap: '1rem',
          flexWrap: 'wrap',
          borderBottom: '2px solid #C17D3C',
        }}>
          <div style={{ flex: 1 }}>
            <p style={{ color: '#F5F0E8', fontFamily: 'var(--font-display)', fontSize: '1.1rem', margin: 0 }}>
              {edited.clientName || 'Shopping List'}
            </p>
            {edited.eventDate && (
              <p style={{ color: '#D49549', fontSize: '0.8rem', margin: '2px 0 0', fontStyle: 'italic' }}>
                {new Date(edited.eventDate).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' })}
              </p>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <label style={{ color: '#D49549', fontSize: '0.8rem', whiteSpace: 'nowrap' }}>Guests:</label>
            <input
              type="number"
              min="1"
              value={guestCount}
              onChange={e => handleGuestCountChange(e.target.value)}
              onBlur={handleGuestCountBlur}
              style={{
                width: 64, padding: '0.3rem 0.5rem', borderRadius: 4,
                border: '1px solid #C17D3C', backgroundColor: '#2a2a2a',
                color: '#F5F0E8', fontSize: '0.9rem', textAlign: 'center',
              }}
            />
          </div>
          {planId && (
            <span style={{ color: saveColor, fontSize: '0.72rem', fontStyle: 'italic', whiteSpace: 'nowrap' }}>
              {saveIndicator}
            </span>
          )}
          {undoStack.length > 0 && (
            <button
              className="btn btn-sm"
              onClick={undoLastDelete}
              style={{ whiteSpace: 'nowrap', backgroundColor: '#D49549', border: 'none', color: '#1A1410', fontWeight: 'bold' }}
              title={`Undo (${undoStack.length} item${undoStack.length > 1 ? 's' : ''})`}
            >
              Undo ({undoStack.length})
            </button>
          )}
          <button
            className="btn btn-sm btn-secondary"
            onClick={() => { if (window.confirm('Reset all quantities to auto-calculated values?')) resetList(); }}
            style={{ whiteSpace: 'nowrap' }}
          >
            Reset
          </button>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', color: '#F5F0E8',
            fontSize: '1.4rem', cursor: 'pointer', lineHeight: 1, padding: '0 0.25rem',
          }}>×</button>
        </div>

        {/* ── Two-column editable body ── */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '1.5rem',
          padding: '1.25rem',
        }}>
          <EditableSection
            title="Liquor · Beer · Wine"
            items={edited.liquorBeerWine}
            onUpdate={(i, f, v) => updateItem('liquorBeerWine', i, f, v)}
            onRemove={(i) => removeItem('liquorBeerWine', i)}
            onAdd={() => addItem('liquorBeerWine')}
            onDragEnd={handleDragEnd('liquorBeerWine')}
            sensors={sensors}
          />
          <EditableSection
            title="Everything Else"
            items={edited.everythingElse}
            onUpdate={(i, f, v) => updateItem('everythingElse', i, f, v)}
            onRemove={(i) => removeItem('everythingElse', i)}
            onAdd={() => addItem('everythingElse')}
            onDragEnd={handleDragEnd('everythingElse')}
            sensors={sensors}
          />
        </div>

        {/* ── Signature cocktails reference (read-only) ── */}
        {edited.signatureCocktailNames && edited.signatureCocktailNames.length > 0 && (
          <div style={{
            margin: '0 1.25rem',
            backgroundColor: '#1A1410',
            border: '1px solid #C17D3C',
            borderRadius: 4,
            padding: '0.5rem 0.875rem',
            display: 'flex',
            gap: '0.5rem',
            alignItems: 'center',
            flexWrap: 'wrap',
          }}>
            <span style={{ color: '#D49549', fontSize: '0.78rem', fontStyle: 'italic', whiteSpace: 'nowrap' }}>
              Signature Cocktails:
            </span>
            <span style={{ color: '#F5F0E8', fontSize: '0.82rem' }}>
              {edited.signatureCocktailNames.join('  ·  ')}
            </span>
          </div>
        )}

        {/* ── Footer actions ── */}
        <div style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: '0.75rem',
          padding: '1rem 1.25rem',
          borderTop: '1px solid var(--border)',
          marginTop: '1rem',
          flexWrap: 'wrap',
          alignItems: 'center',
        }}>
          {pdfError && (
            <span style={{ color: '#d32f2f', fontSize: '0.82rem', marginRight: 'auto' }}>{pdfError}</span>
          )}
          {approveError && (
            <span style={{ color: '#d32f2f', fontSize: '0.82rem', marginRight: 'auto' }}>{approveError}</span>
          )}
          {planToken && (
            <button className="btn btn-sm btn-secondary" onClick={handleShareLink}>
              {linkCopied ? 'Link Copied!' : 'Share Client Link'}
            </button>
          )}
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
          <button className="btn" onClick={handleDownload} disabled={downloading}>
            {downloading ? 'Generating PDF...' : 'Download PDF'}
          </button>
          {planId && (
            <button
              className="btn btn-success"
              onClick={handleApproveAndSend}
              disabled={approveStatus !== 'idle'}
              title={approveStatus === 'approved'
                ? 'Already approved — client can now see this list'
                : 'Save current edits, mark approved, and email the client a link'}
            >
              {approveStatus === 'approving' ? 'Approving…'
                : approveStatus === 'approved' ? '✓ Approved & Sent'
                : 'Approve & Send to Client'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function EditableSection({ title, items, onUpdate, onRemove, onAdd, onDragEnd, sensors }) {
  return (
    <div>
      {/* Section header */}
      <div style={{
        backgroundColor: '#1A1410',
        color: '#E8DFC4',
        fontSize: '0.78rem',
        textAlign: 'center',
        padding: '0.3rem 0.5rem',
        marginBottom: '0.25rem',
        borderRadius: 3,
        fontFamily: 'var(--font-display)',
        letterSpacing: '0.05em',
      }}>
        {title}
      </div>

      {/* Column headers */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '20px 40px 60px 1fr 28px',
        gap: '0.25rem',
        backgroundColor: '#2a2a2a',
        padding: '0.3rem 0.4rem',
        borderBottom: '1.5px solid #C17D3C',
        marginBottom: '0.125rem',
      }}>
        <span />
        {['Qty', 'Size', 'Item', ''].map(h => (
          <span key={h} style={{ color: '#E8DFC4', fontSize: '0.7rem', textAlign: h === 'Qty' ? 'center' : 'left' }}>{h}</span>
        ))}
      </div>

      {/* Item rows with drag-and-drop */}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={items.map(i => i._id)} strategy={verticalListSortingStrategy}>
          {items.map((row, i) => (
            <SortableRow
              key={row._id}
              row={row}
              index={i}
              onUpdate={onUpdate}
              onRemove={onRemove}
            />
          ))}
        </SortableContext>
      </DndContext>

      {/* Add item button */}
      <button
        onClick={onAdd}
        style={{
          width: '100%', marginTop: '0.375rem',
          background: 'none', border: '1px dashed #C17D3C',
          color: '#C17D3C', fontSize: '0.78rem', cursor: 'pointer',
          borderRadius: 3, padding: '0.3rem 0', textAlign: 'center',
        }}
      >
        + Add Item
      </button>
    </div>
  );
}

function SortableRow({ row, index, onUpdate, onRemove }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: row._id });

  const style = {
    display: 'grid',
    gridTemplateColumns: '20px 40px 60px 1fr 28px',
    gap: '0.25rem',
    alignItems: 'center',
    padding: '0.2rem 0.4rem',
    backgroundColor: isDragging ? '#D49549' : index % 2 === 0 ? '#F5F0E8' : '#EDE3CC',
    borderBottom: '0.5px solid rgba(193,125,60,0.2)',
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.8 : 1,
    zIndex: isDragging ? 10 : undefined,
    cursor: isDragging ? 'grabbing' : undefined,
  };

  return (
    <div ref={setNodeRef} style={style}>
      {/* Drag handle */}
      <button
        {...attributes}
        {...listeners}
        style={{
          background: 'none', border: 'none', cursor: 'grab',
          color: '#aaa', fontSize: '0.8rem', lineHeight: 1, padding: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          touchAction: 'none',
        }}
        title="Drag to reorder"
      >⠿</button>
      <input
        type="number"
        min="0"
        value={row.qty}
        onChange={e => onUpdate(index, 'qty', e.target.value)}
        style={rowInput({ textAlign: 'center', color: '#6B4226', fontWeight: 'bold' })}
      />
      <input
        value={row.size}
        onChange={e => onUpdate(index, 'size', e.target.value)}
        style={rowInput({ color: '#7A6245', fontSize: '0.78rem' })}
      />
      <input
        value={row.item}
        onChange={e => onUpdate(index, 'item', e.target.value)}
        style={rowInput({ fontWeight: '600', color: '#2C1F0E' })}
      />
      <button
        onClick={() => onRemove(index)}
        style={{
          background: 'none', border: 'none', cursor: 'pointer',
          color: '#aaa', fontSize: '0.9rem', lineHeight: 1, padding: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
        title="Remove"
      >×</button>
    </div>
  );
}

function rowInput(extra = {}) {
  return {
    width: '100%',
    border: 'none',
    backgroundColor: 'transparent',
    fontSize: '0.82rem',
    padding: '0.1rem 0.2rem',
    outline: 'none',
    ...extra,
  };
}
