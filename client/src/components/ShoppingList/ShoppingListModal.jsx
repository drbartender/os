import React, { useState, useCallback } from 'react';
import { pdf } from '@react-pdf/renderer';
import { ShoppingListPDF } from './ShoppingListPDF';
import { generateShoppingList } from './generateShoppingList';

export default function ShoppingListModal({ listData, onClose }) {
  const [edited, setEdited] = useState(() => deepClone(listData));
  const [guestCount, setGuestCount] = useState(listData.guestCount);
  const [downloading, setDownloading] = useState(false);

  function deepClone(d) {
    return {
      ...d,
      liquorBeerWine: d.liquorBeerWine.map(r => ({ ...r })),
      everythingElse: d.everythingElse.map(r => ({ ...r })),
    };
  }

  const resetList = useCallback((count = guestCount) => {
    const fresh = generateShoppingList({
      clientName: listData.clientName,
      guestCount: count,
      signatureCocktails: (listData.signatureCocktailNames || []).map(name => ({ name, ingredients: [] })),
      eventDate: listData.eventDate,
      notes: listData.notes,
    });
    setEdited(deepClone(fresh));
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
      next[section] = next[section].filter((_, i) => i !== index);
      return next;
    });
  };

  const addItem = (section) => {
    setEdited(prev => {
      const next = deepClone(prev);
      next[section] = [...next[section], { item: '', size: '', qty: 1 }];
      return next;
    });
  };

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const finalData = { ...edited, guestCount: parseInt(guestCount, 10) || edited.guestCount };
      const blob = await pdf(<ShoppingListPDF listData={finalData} />).toBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `DRB_ShoppingList_${(edited.clientName || 'Event').replace(/\s+/g, '_')}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('PDF generation failed:', err);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      backgroundColor: 'rgba(0,0,0,0.65)',
      display: 'flex', flexDirection: 'column',
      overflowY: 'auto',
    }}>
      <div style={{
        backgroundColor: 'var(--cream)',
        margin: '1.5rem auto',
        width: '100%',
        maxWidth: 900,
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
                {new Date(edited.eventDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
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
          />
          <EditableSection
            title="Everything Else"
            items={edited.everythingElse}
            onUpdate={(i, f, v) => updateItem('everythingElse', i, f, v)}
            onRemove={(i) => removeItem('everythingElse', i)}
            onAdd={() => addItem('everythingElse')}
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
        }}>
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
          <button className="btn" onClick={handleDownload} disabled={downloading}>
            {downloading ? 'Generating PDF...' : 'Download PDF'}
          </button>
        </div>
      </div>
    </div>
  );
}

function EditableSection({ title, items, onUpdate, onRemove, onAdd }) {
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
        gridTemplateColumns: '40px 60px 1fr 28px',
        gap: '0.25rem',
        backgroundColor: '#2a2a2a',
        padding: '0.3rem 0.4rem',
        borderBottom: '1.5px solid #C17D3C',
        marginBottom: '0.125rem',
      }}>
        {['Qty', 'Size', 'Item', ''].map(h => (
          <span key={h} style={{ color: '#E8DFC4', fontSize: '0.7rem', textAlign: h === 'Qty' ? 'center' : 'left' }}>{h}</span>
        ))}
      </div>

      {/* Item rows */}
      {items.map((row, i) => (
        <div key={i} style={{
          display: 'grid',
          gridTemplateColumns: '40px 60px 1fr 28px',
          gap: '0.25rem',
          alignItems: 'center',
          padding: '0.2rem 0.4rem',
          backgroundColor: i % 2 === 0 ? '#F5F0E8' : '#EDE3CC',
          borderBottom: '0.5px solid rgba(193,125,60,0.2)',
        }}>
          <input
            type="number"
            min="0"
            value={row.qty}
            onChange={e => onUpdate(i, 'qty', e.target.value)}
            style={rowInput({ textAlign: 'center', color: '#6B4226', fontWeight: 'bold' })}
          />
          <input
            value={row.size}
            onChange={e => onUpdate(i, 'size', e.target.value)}
            style={rowInput({ color: '#7A6245', fontSize: '0.78rem' })}
          />
          <input
            value={row.item}
            onChange={e => onUpdate(i, 'item', e.target.value)}
            style={rowInput({ fontWeight: '600', color: '#2C1F0E' })}
          />
          <button
            onClick={() => onRemove(i)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: '#aaa', fontSize: '0.9rem', lineHeight: 1, padding: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
            title="Remove"
          >×</button>
        </div>
      ))}

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
