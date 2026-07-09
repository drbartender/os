import React, { useState, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
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

// Regenerating pulls a fresh list from the server (the live par catalog) and
// discards manual edits; saving an already-approved list returns it to review.
// This copy gates every regenerate entry point (Reset + guest-count change).
const REGEN_CONFIRM = 'Regenerate replaces your edits, and saving will set the list back to Needs review. Continue?';

export default function ShoppingListModal({ listData, onClose, planId, planToken, initialApproveStatus = 'idle' }) {
  const navigate = useNavigate();
  const [edited, setEdited] = useState(() => deepClone(listData));
  const [guestCount, setGuestCount] = useState(listData.guestCount);
  const [downloading, setDownloading] = useState(false);
  const [pdfError, setPdfError] = useState('');
  const [undoStack, setUndoStack] = useState([]);
  const [saveStatus, setSaveStatus] = useState('saved'); // 'saved' | 'saving' | 'unsaved'
  const [linkCopied, setLinkCopied] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [regenError, setRegenError] = useState('');
  const [addingRecipe, setAddingRecipe] = useState(null); // name being added, or null
  const [addRecipeError, setAddRecipeError] = useState('');
  // Approve state is seeded by the parent (ShoppingListButton already fetched
  // /shopping-list to load the saved list — it passes status here so we don't
  // duplicate the request on mount).
  const [approveStatus, setApproveStatus] = useState(initialApproveStatus); // 'idle' | 'approving' | 'approved'
  const [approveError, setApproveError] = useState('');
  const isFirstRender = useRef(true);
  const saveTimer = useRef(null);

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

  // Regenerate from the server (live par catalog); the client-side generator
  // mirror is retired. Replaces manual edits, so each call site gates it behind
  // window.confirm (REGEN_CONFIRM), matching the old Reset/guest-count pattern.
  const regenerate = useCallback(async (count) => {
    if (!planId) return;
    setRegenerating(true);
    setRegenError('');
    try {
      const n = parseInt(count, 10);
      const body = {};
      if (n > 0) body.guest_count_override = n;
      const res = await api.post(`/drink-plans/${planId}/shopping-list/regenerate`, body);
      const fresh = res.data.list;
      // The server list omits the display-only event-type label; carry it over.
      if (!fresh.eventTypeLabel && listData.eventTypeLabel) fresh.eventTypeLabel = listData.eventTypeLabel;
      setEdited(deepClone(fresh));
      if (n > 0) setGuestCount(n);
      setUndoStack([]);
    } catch (err) {
      setRegenError(err?.message || 'Failed to regenerate. Try again.');
    } finally {
      setRegenerating(false);
    }
  }, [planId, listData]);

  const handleGuestCountChange = (val) => {
    setGuestCount(val);
  };

  const handleGuestCountBlur = () => {
    const count = parseInt(guestCount, 10);
    if (count > 0 && count !== edited.guestCount) {
      if (window.confirm(REGEN_CONFIRM)) {
        regenerate(count);
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
      // Dynamic-import the PDF generator (which carries the embedded logo
      // + jspdf) so admins who never download a PDF don't pay that cost.
      const { generateShoppingListPDF } = await import('./ShoppingListPDF');
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

  // Client requested a drink we have no recipe for. Create an off-menu draft
  // cocktail (server slugs the id) and jump to the Recipes tab to author it.
  const handleAddRecipe = async (name) => {
    setAddingRecipe(name);
    setAddRecipeError('');
    try {
      const res = await api.post('/cocktails', { name, is_active: false });
      navigate(`/potions?tab=recipes&drink=${res.data.id}`);
    } catch (err) {
      setAddRecipeError(err?.message || `Could not add "${name}". Try again.`);
      setAddingRecipe(null);
    }
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor)
  );

  const saveIndicator = saveStatus === 'saving' ? 'Saving...'
    : saveStatus === 'saved' ? 'Saved'
    : 'Unsaved';
  // Admin-os semantic colors (skin-aware via the html[data-app=admin-os] cascade).
  const saveColor = saveStatus === 'saved' ? 'hsl(var(--ok-h) var(--ok-s) 42%)'
    : saveStatus === 'saving' ? 'var(--ink-3)'
    : 'hsl(var(--danger-h) var(--danger-s) 55%)';

  return createPortal(
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      backgroundColor: 'rgba(0,0,0,0.6)',
      display: 'flex', flexDirection: 'column',
      overflowY: 'auto',
      paddingTop: 'calc(60px + 1.5rem)',
    }}>
      <div style={{
        backgroundColor: 'var(--bg-elev)',
        margin: '0 auto 1.5rem',
        width: '100%',
        maxWidth: 960,
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-pop)',
        border: '1px solid var(--line-2)',
        display: 'flex',
        flexDirection: 'column',
      }}>

        {/* ── Modal Header ── */}
        <div style={{
          backgroundColor: 'transparent',
          borderRadius: 'var(--radius-lg) var(--radius-lg) 0 0',
          padding: '0.875rem 1.25rem',
          display: 'flex',
          alignItems: 'center',
          gap: '1rem',
          flexWrap: 'wrap',
          borderBottom: '1px solid var(--line-2)',
        }}>
          <div style={{ flex: 1 }}>
            <p style={{ color: 'var(--ink-1)', fontFamily: 'var(--font-display)', fontSize: '1.1rem', margin: 0 }}>
              {edited.clientName || 'Shopping List'}
            </p>
            {edited.eventDate && (
              <p style={{ color: 'var(--ink-3)', fontSize: '0.8rem', margin: '2px 0 0', fontStyle: 'italic' }}>
                {new Date(edited.eventDate).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' })}
              </p>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <label style={{ color: 'var(--ink-2)', fontSize: '0.8rem', whiteSpace: 'nowrap' }}>Guests:</label>
            <input
              type="number"
              min="1"
              value={guestCount}
              onChange={e => handleGuestCountChange(e.target.value)}
              onBlur={handleGuestCountBlur}
              style={{
                width: 64, padding: '0.3rem 0.5rem', borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--line-2)', backgroundColor: 'var(--bg-3)',
                color: 'var(--ink-1)', fontSize: '0.9rem', textAlign: 'center',
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
              className="btn btn-sm btn-primary"
              onClick={undoLastDelete}
              style={{ whiteSpace: 'nowrap' }}
              title={`Undo (${undoStack.length} item${undoStack.length > 1 ? 's' : ''})`}
            >
              Undo ({undoStack.length})
            </button>
          )}
          <button
            className="btn btn-sm btn-secondary"
            onClick={() => { if (window.confirm(REGEN_CONFIRM)) regenerate(guestCount); }}
            disabled={regenerating}
            style={{ whiteSpace: 'nowrap' }}
          >
            {regenerating ? 'Regenerating…' : 'Regenerate'}
          </button>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', color: 'var(--ink-2)',
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
            backgroundColor: 'var(--bg-2)',
            border: '1px solid var(--line-2)',
            borderRadius: 'var(--radius)',
            padding: '0.5rem 0.875rem',
            display: 'flex',
            gap: '0.5rem',
            alignItems: 'center',
            flexWrap: 'wrap',
          }}>
            <span style={{ color: 'var(--ink-3)', fontSize: '0.78rem', fontStyle: 'italic', whiteSpace: 'nowrap' }}>
              Signature Cocktails:
            </span>
            <span style={{ color: 'var(--ink-1)', fontSize: '0.82rem' }}>
              {edited.signatureCocktailNames.join('  ·  ')}
            </span>
          </div>
        )}

        {/* ── Client-requested drinks with no recipe yet ── */}
        {Array.isArray(edited.needsRecipe) && edited.needsRecipe.length > 0 && (
          <div style={{
            margin: '0.75rem 1.25rem 0',
            backgroundColor: 'var(--bg-2)',
            border: '1px solid var(--accent-line)',
            borderRadius: 'var(--radius)',
            padding: '0.75rem 0.875rem',
          }}>
            <p style={{ color: 'var(--ink-1)', fontFamily: 'var(--font-display)', fontSize: '0.9rem', margin: '0 0 0.5rem' }}>
              Client requested: recipe needed
            </p>
            {edited.needsRecipe.map((entry, i) => (
              <div
                key={(entry.name || '') + '-' + i}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  gap: '0.75rem', padding: '0.25rem 0',
                }}
              >
                <span style={{ color: 'var(--ink-2)', fontSize: '0.85rem' }}>{entry.name}</span>
                <button
                  className="btn btn-sm btn-secondary"
                  onClick={() => handleAddRecipe(entry.name)}
                  disabled={addingRecipe !== null}
                  style={{ whiteSpace: 'nowrap' }}
                >
                  {addingRecipe === entry.name ? 'Adding…' : 'Add recipe'}
                </button>
              </div>
            ))}
            {addRecipeError && (
              <p style={{ color: 'hsl(var(--danger-h) var(--danger-s) 55%)', fontSize: '0.8rem', margin: '0.5rem 0 0' }}>
                {addRecipeError}
              </p>
            )}
          </div>
        )}

        {/* ── Footer actions ── */}
        <div style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: '0.75rem',
          padding: '1rem 1.25rem',
          borderTop: '1px solid var(--line-2)',
          marginTop: '1rem',
          flexWrap: 'wrap',
          alignItems: 'center',
        }}>
          {pdfError && (
            <span style={{ color: 'hsl(var(--danger-h) var(--danger-s) 55%)', fontSize: '0.82rem', marginRight: 'auto' }}>{pdfError}</span>
          )}
          {approveError && (
            <span style={{ color: 'hsl(var(--danger-h) var(--danger-s) 55%)', fontSize: '0.82rem', marginRight: 'auto' }}>{approveError}</span>
          )}
          {regenError && (
            <span style={{ color: 'hsl(var(--danger-h) var(--danger-s) 55%)', fontSize: '0.82rem', marginRight: 'auto' }}>{regenError}</span>
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
                ? 'Already approved, client can now see this list'
                : 'Save current edits, mark approved, and email the client a link'}
            >
              {approveStatus === 'approving' ? 'Approving…'
                : approveStatus === 'approved' ? '✓ Approved & Sent'
                : 'Approve & Send to Client'}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

function EditableSection({ title, items, onUpdate, onRemove, onAdd, onDragEnd, sensors }) {
  return (
    <div>
      {/* Section header */}
      <div style={{
        backgroundColor: 'var(--bg-2)',
        color: 'var(--ink-2)',
        fontSize: '0.78rem',
        textAlign: 'center',
        padding: '0.3rem 0.5rem',
        marginBottom: '0.25rem',
        borderRadius: 'var(--radius-sm)',
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
        backgroundColor: 'var(--bg-3)',
        padding: '0.3rem 0.4rem',
        borderBottom: '1px solid var(--line-2)',
        marginBottom: '0.125rem',
      }}>
        <span />
        {['Qty', 'Size', 'Item', ''].map(h => (
          <span key={h} style={{ color: 'var(--ink-3)', fontSize: '0.7rem', textAlign: h === 'Qty' ? 'center' : 'left' }}>{h}</span>
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
          background: 'none', border: '1px dashed var(--accent-line)',
          color: 'var(--accent)', fontSize: '0.78rem', cursor: 'pointer',
          borderRadius: 'var(--radius-sm)', padding: '0.3rem 0', textAlign: 'center',
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
    backgroundColor: isDragging ? 'var(--accent-soft)' : index % 2 === 0 ? 'var(--bg-elev)' : 'var(--bg-2)',
    borderBottom: '0.5px solid var(--line-1)',
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
          color: 'var(--ink-3)', fontSize: '0.8rem', lineHeight: 1, padding: 0,
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
        style={rowInput({ textAlign: 'center', color: 'var(--accent)', fontWeight: 'bold' })}
      />
      <input
        value={row.size}
        onChange={e => onUpdate(index, 'size', e.target.value)}
        style={rowInput({ color: 'var(--ink-3)', fontSize: '0.78rem' })}
      />
      <input
        value={row.item}
        onChange={e => onUpdate(index, 'item', e.target.value)}
        style={rowInput({ fontWeight: '600', color: 'var(--ink-1)' })}
      />
      <button
        onClick={() => onRemove(index)}
        style={{
          background: 'none', border: 'none', cursor: 'pointer',
          color: 'var(--ink-3)', fontSize: '0.9rem', lineHeight: 1, padding: 0,
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
