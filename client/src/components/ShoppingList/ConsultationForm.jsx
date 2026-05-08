import React, { useState, useEffect, useMemo } from 'react';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';

const BAR_TYPES = [
  { value: 'full_bar',      label: 'Full bar' },
  { value: 'sig_beer_wine', label: 'Sigs + beer + wine' },
  { value: 'beer_wine',     label: 'Beer + wine only' },
  { value: 'mocktails',     label: 'Mocktails only' },
];

const SPIRIT_OPTIONS = [
  { value: 'vodka',   label: 'Vodka' },
  { value: 'gin',     label: 'Gin' },
  { value: 'rum',     label: 'Rum' },
  { value: 'tequila', label: 'Tequila' },
  { value: 'bourbon', label: 'Bourbon' },
  { value: 'whiskey', label: 'Whiskey' },
  { value: 'scotch',  label: 'Scotch' },
  { value: 'mezcal',  label: 'Mezcal' },
];

const FULL_BAR_DEFAULT_SPIRITS = ['vodka', 'gin', 'rum', 'tequila', 'bourbon'];

const WINE_OPTIONS = [
  { value: 'red',       label: 'Red' },
  { value: 'white',     label: 'White' },
  { value: 'sparkling', label: 'Sparkling' },
];

const MIXER_OPTIONS = [
  { value: 'full',     label: 'Full', description: 'Standard bar mixers (cola, ginger ale, tonic, juices, etc.)' },
  { value: 'matching', label: 'Matching', description: 'Only mixers paired to the spirits picked above' },
  { value: 'none',     label: 'None', description: "Don't include extra mixers (sig drink ingredients still go on the list)" },
];

// Categorize cocktails by base_spirit (for compact two-column picker layout).
function groupCocktailsBySpirit(list) {
  const groups = {};
  for (const c of list) {
    const key = (c.base_spirit || 'Other').trim() || 'Other';
    if (!groups[key]) groups[key] = [];
    groups[key].push(c);
  }
  return groups;
}

export default function ConsultationForm({ planId, isOpen, onClose, onSaved, cocktails = [], mocktails = [], planContext = {} }) {
  const toast = useToast();
  const [submitting, setSubmitting] = useState(false);
  const [loadError, setLoadError] = useState('');

  const [barType, setBarType] = useState('full_bar');
  const [spirits, setSpirits] = useState(FULL_BAR_DEFAULT_SPIRITS);
  const [sigIds, setSigIds] = useState([]);
  const [customSigs, setCustomSigs] = useState([]);
  const [customSigName, setCustomSigName] = useState('');
  const [customSigIngredients, setCustomSigIngredients] = useState('');
  const [mocktailsEnabled, setMocktailsEnabled] = useState(false);
  const [mocktailIds, setMocktailIds] = useState([]);
  const [customMocktails, setCustomMocktails] = useState([]);
  const [customMockName, setCustomMockName] = useState('');
  const [customMockIngredients, setCustomMockIngredients] = useState('');
  const [beerYes, setBeerYes] = useState(true);
  const [wine, setWine] = useState(['red', 'white']);
  const [mixers, setMixers] = useState('full');
  const [notes, setNotes] = useState('');
  const [guestCountOverride, setGuestCountOverride] = useState('');

  const cocktailGroups = useMemo(() => groupCocktailsBySpirit(cocktails), [cocktails]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setLoadError('');
    api.get(`/drink-plans/${planId}/consult`)
      .then(res => {
        if (cancelled) return;
        const c = res.data?.consult_selections;
        if (!c) return;
        if (c.barType) setBarType(c.barType);
        if (Array.isArray(c.spirits)) setSpirits(c.spirits);
        if (Array.isArray(c.signatureDrinks)) setSigIds(c.signatureDrinks);
        if (Array.isArray(c.customCocktails)) setCustomSigs(c.customCocktails);
        if (typeof c.mocktailsEnabled === 'boolean') setMocktailsEnabled(c.mocktailsEnabled);
        if (Array.isArray(c.mocktails)) setMocktailIds(c.mocktails);
        if (Array.isArray(c.customMocktails)) setCustomMocktails(c.customMocktails);
        if (typeof c.beer === 'boolean') setBeerYes(c.beer);
        if (Array.isArray(c.wine)) setWine(c.wine);
        if (typeof c.mixers === 'string') setMixers(c.mixers);
        if (typeof c.notes === 'string') setNotes(c.notes);
        if (c.guestCountOverride) setGuestCountOverride(String(c.guestCountOverride));
      })
      .catch(err => {
        if (!cancelled && err?.status !== 404) setLoadError('Failed to load existing consult.');
      });
    return () => { cancelled = true; };
  }, [isOpen, planId]);

  const isMocktailOnly = barType === 'mocktails';
  const showSpirits = barType === 'full_bar' || barType === 'sig_beer_wine';
  const showSigs = barType !== 'beer_wine' && !isMocktailOnly;
  const showMocktailAddon = !isMocktailOnly && barType !== 'beer_wine';
  const showBeerWine = !isMocktailOnly;
  const showMixers = barType !== 'beer_wine' && !isMocktailOnly;

  const toggleArr = (arr, value, setter) => {
    setter(arr.includes(value) ? arr.filter(v => v !== value) : [...arr, value]);
  };

  const handleBarTypeChange = (next) => {
    setBarType(next);
    if (next === 'full_bar' && spirits.length === 0) {
      setSpirits(FULL_BAR_DEFAULT_SPIRITS);
    }
  };

  const addCustomSig = () => {
    const name = customSigName.trim();
    if (!name) return;
    const ingredients = customSigIngredients
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    setCustomSigs(prev => [...prev, { name, ingredients }]);
    setCustomSigName('');
    setCustomSigIngredients('');
  };

  const addCustomMocktail = () => {
    const name = customMockName.trim();
    if (!name) return;
    const ingredients = customMockIngredients
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    setCustomMocktails(prev => [...prev, { name, ingredients }]);
    setCustomMockName('');
    setCustomMockIngredients('');
  };

  const removeCustomSig = (idx) => setCustomSigs(prev => prev.filter((_, i) => i !== idx));
  const removeCustomMocktail = (idx) => setCustomMocktails(prev => prev.filter((_, i) => i !== idx));

  const handleSubmit = async () => {
    if (submitting) return;
    if (showSigs && sigIds.length === 0 && customSigs.length === 0 && !isMocktailOnly) {
      toast.error('Pick at least one signature drink (or switch to Beer + wine only).');
      return;
    }
    if (isMocktailOnly && mocktailIds.length === 0 && customMocktails.length === 0) {
      toast.error('Pick at least one mocktail.');
      return;
    }
    setSubmitting(true);
    try {
      const consult = {
        barType,
        spirits: showSpirits ? spirits : [],
        signatureDrinks: showSigs ? sigIds : [],
        customCocktails: showSigs ? customSigs : [],
        mocktailsEnabled: isMocktailOnly ? true : mocktailsEnabled,
        mocktails: (mocktailsEnabled || isMocktailOnly) ? mocktailIds : [],
        customMocktails: (mocktailsEnabled || isMocktailOnly) ? customMocktails : [],
        beer: showBeerWine ? beerYes : false,
        wine: showBeerWine ? wine : [],
        mixers: showMixers ? mixers : 'none',
        notes: notes.trim(),
        guestCountOverride: guestCountOverride ? Number(guestCountOverride) : null,
      };
      await api.put(`/drink-plans/${planId}/consult`, { consult });
      toast.success('Shopping list generated from consult.');
      if (onSaved) onSaved();
      onClose();
    } catch (err) {
      toast.error(err?.message || 'Failed to save consult.');
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;

  const overlayStyle = {
    position: 'fixed', inset: 0, zIndex: 1000,
    background: 'rgba(0,0,0,0.65)',
    display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
    padding: '3rem 1rem', overflowY: 'auto',
  };
  const cardStyle = {
    background: 'var(--bg-1)', border: '1px solid var(--line-1)',
    borderRadius: 6, width: '100%', maxWidth: 720,
    boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
  };
  const headerStyle = {
    padding: '1rem 1.25rem', borderBottom: '1px solid var(--line-1)',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  };
  const sectionStyle = { padding: '0.875rem 1.25rem', borderBottom: '1px solid var(--line-2, var(--line-1))' };
  const labelStyle = { display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted, #888)' };
  const chipBtn = (selected) => ({
    padding: '0.35rem 0.7rem', borderRadius: 4,
    border: `1px solid ${selected ? 'var(--accent, #C17D3C)' : 'var(--line-1)'}`,
    background: selected ? 'var(--accent, #C17D3C)' : 'transparent',
    color: selected ? 'var(--bg-1)' : 'var(--text)',
    cursor: 'pointer', fontSize: 13,
  });

  return (
    <div style={overlayStyle} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={cardStyle}>
        <div style={headerStyle}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 600 }}>Consultation form</div>
            <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
              Capture phone/email-consult info → generate shopping list
            </div>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">×</button>
        </div>

        {loadError && <div style={{ ...sectionStyle, color: 'hsl(var(--danger-h) var(--danger-s) 65%)' }}>{loadError}</div>}

        <div style={sectionStyle}>
          <label style={labelStyle}>Bar type</label>
          <div className="hstack" style={{ gap: 8, flexWrap: 'wrap' }}>
            {BAR_TYPES.map(opt => (
              <button key={opt.value} type="button" style={chipBtn(barType === opt.value)} onClick={() => handleBarTypeChange(opt.value)}>
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {showSpirits && (
          <div style={sectionStyle}>
            <label style={labelStyle}>Spirits</label>
            <div className="hstack" style={{ gap: 8, flexWrap: 'wrap' }}>
              {SPIRIT_OPTIONS.map(opt => (
                <button key={opt.value} type="button" style={chipBtn(spirits.includes(opt.value))} onClick={() => toggleArr(spirits, opt.value, setSpirits)}>
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {showSigs && (
          <div style={sectionStyle}>
            <label style={labelStyle}>Signature drinks</label>
            <CocktailPicker groups={cocktailGroups} selected={sigIds} onToggle={(id) => toggleArr(sigIds, id, setSigIds)} />

            {customSigs.length > 0 && (
              <div className="hstack" style={{ gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                {customSigs.map((c, i) => (
                  <span key={i} style={chipBtn(true)}>
                    {c.name}{c.ingredients?.length ? ` (${c.ingredients.join(', ')})` : ''}
                    <button type="button" onClick={() => removeCustomSig(i)} style={{ marginLeft: 6, background: 'transparent', border: 0, color: 'inherit', cursor: 'pointer' }} aria-label="Remove">×</button>
                  </span>
                ))}
              </div>
            )}

            <div className="hstack" style={{ gap: 6, marginTop: 8 }}>
              <input className="input" style={{ flex: '0 0 200px' }} placeholder="Custom drink name" value={customSigName} onChange={e => setCustomSigName(e.target.value)} />
              <input className="input" style={{ flex: 1 }} placeholder="Ingredients (comma-separated)" value={customSigIngredients} onChange={e => setCustomSigIngredients(e.target.value)} />
              <button type="button" className="btn btn-secondary btn-sm" onClick={addCustomSig} disabled={!customSigName.trim()}>Add</button>
            </div>
          </div>
        )}

        {showMocktailAddon && (
          <div style={sectionStyle}>
            <label style={{ ...labelStyle, marginBottom: 8 }}>
              <input type="checkbox" checked={mocktailsEnabled} onChange={e => setMocktailsEnabled(e.target.checked)} style={{ marginRight: 6 }} />
              Include mocktails as an add-on
            </label>
            {mocktailsEnabled && (
              <>
                <CocktailPicker groups={groupCocktailsBySpirit(mocktails)} selected={mocktailIds} onToggle={(id) => toggleArr(mocktailIds, id, setMocktailIds)} />
                {customMocktails.length > 0 && (
                  <div className="hstack" style={{ gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                    {customMocktails.map((c, i) => (
                      <span key={i} style={chipBtn(true)}>
                        {c.name}{c.ingredients?.length ? ` (${c.ingredients.join(', ')})` : ''}
                        <button type="button" onClick={() => removeCustomMocktail(i)} style={{ marginLeft: 6, background: 'transparent', border: 0, color: 'inherit', cursor: 'pointer' }} aria-label="Remove">×</button>
                      </span>
                    ))}
                  </div>
                )}
                <div className="hstack" style={{ gap: 6, marginTop: 8 }}>
                  <input className="input" style={{ flex: '0 0 200px' }} placeholder="Custom mocktail name" value={customMockName} onChange={e => setCustomMockName(e.target.value)} />
                  <input className="input" style={{ flex: 1 }} placeholder="Ingredients (comma-separated)" value={customMockIngredients} onChange={e => setCustomMockIngredients(e.target.value)} />
                  <button type="button" className="btn btn-secondary btn-sm" onClick={addCustomMocktail} disabled={!customMockName.trim()}>Add</button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Mocktail-only mode shows the mocktail picker as the primary input */}
        {isMocktailOnly && (
          <div style={sectionStyle}>
            <CocktailPicker groups={groupCocktailsBySpirit(mocktails)} selected={mocktailIds} onToggle={(id) => toggleArr(mocktailIds, id, setMocktailIds)} />
            {customMocktails.length > 0 && (
              <div className="hstack" style={{ gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                {customMocktails.map((c, i) => (
                  <span key={i} style={chipBtn(true)}>
                    {c.name}{c.ingredients?.length ? ` (${c.ingredients.join(', ')})` : ''}
                    <button type="button" onClick={() => removeCustomMocktail(i)} style={{ marginLeft: 6, background: 'transparent', border: 0, color: 'inherit', cursor: 'pointer' }} aria-label="Remove">×</button>
                  </span>
                ))}
              </div>
            )}
            <div className="hstack" style={{ gap: 6, marginTop: 8 }}>
              <input className="input" style={{ flex: '0 0 200px' }} placeholder="Custom mocktail name" value={customMockName} onChange={e => setCustomMockName(e.target.value)} />
              <input className="input" style={{ flex: 1 }} placeholder="Ingredients (comma-separated)" value={customMockIngredients} onChange={e => setCustomMockIngredients(e.target.value)} />
              <button type="button" className="btn btn-secondary btn-sm" onClick={addCustomMocktail} disabled={!customMockName.trim()}>Add</button>
            </div>
          </div>
        )}

        {showBeerWine && (
          <div style={sectionStyle}>
            <div className="hstack" style={{ gap: 24, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div style={{ flex: '0 0 auto' }}>
                <label style={labelStyle}>Beer</label>
                <div className="hstack" style={{ gap: 8 }}>
                  <button type="button" style={chipBtn(beerYes)} onClick={() => setBeerYes(true)}>Yes</button>
                  <button type="button" style={chipBtn(!beerYes)} onClick={() => setBeerYes(false)}>No</button>
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 200 }}>
                <label style={labelStyle}>Wine</label>
                <div className="hstack" style={{ gap: 8, flexWrap: 'wrap' }}>
                  {WINE_OPTIONS.map(opt => (
                    <button key={opt.value} type="button" style={chipBtn(wine.includes(opt.value))} onClick={() => toggleArr(wine, opt.value, setWine)}>
                      {opt.label}
                    </button>
                  ))}
                  <button type="button" style={chipBtn(wine.length === 0)} onClick={() => setWine([])}>None</button>
                </div>
              </div>
            </div>
          </div>
        )}

        {showMixers && (
          <div style={sectionStyle}>
            <label style={labelStyle}>Mixers</label>
            <div className="hstack" style={{ gap: 8, flexWrap: 'wrap' }}>
              {MIXER_OPTIONS.map(opt => (
                <button key={opt.value} type="button" style={chipBtn(mixers === opt.value)} onClick={() => setMixers(opt.value)} title={opt.description}>
                  {opt.label}
                </button>
              ))}
            </div>
            <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
              {MIXER_OPTIONS.find(o => o.value === mixers)?.description}
            </div>
          </div>
        )}

        <div style={sectionStyle}>
          <div className="hstack" style={{ gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div style={{ flex: '0 0 140px' }}>
              <label style={labelStyle}>Guest count</label>
              <input
                className="input"
                type="number"
                min="1"
                placeholder={planContext.guest_count ? String(planContext.guest_count) : '—'}
                value={guestCountOverride}
                onChange={e => setGuestCountOverride(e.target.value)}
                style={{ width: '100%' }}
              />
              <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                {planContext.guest_count ? `Event has ${planContext.guest_count}; override only if revised.` : 'Event has no guest count — required.'}
              </div>
            </div>
            <div style={{ flex: 1, minWidth: 240 }}>
              <label style={labelStyle}>Notes</label>
              <textarea
                className="input"
                rows={3}
                placeholder="Anything specific from the consult — e.g., 'no fruity drinks for the men', 'Pacifico instead of Modelo'"
                value={notes}
                onChange={e => setNotes(e.target.value)}
                style={{ width: '100%', height: 'auto', padding: '0.5rem 0.65rem' }}
              />
            </div>
          </div>
        </div>

        <div style={{ padding: '0.875rem 1.25rem', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={submitting}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={handleSubmit} disabled={submitting}>
            {submitting ? 'Generating…' : 'Generate shopping list'}
          </button>
        </div>
      </div>
    </div>
  );
}

function CocktailPicker({ groups, selected, onToggle }) {
  const keys = Object.keys(groups).sort();
  if (keys.length === 0) {
    return <div className="muted" style={{ fontSize: 12 }}>No drinks available.</div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 240, overflowY: 'auto' }}>
      {keys.map(key => (
        <div key={key}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted, #888)', marginBottom: 4 }}>{key}</div>
          <div className="hstack" style={{ gap: 6, flexWrap: 'wrap' }}>
            {groups[key].map(c => {
              const isSelected = selected.includes(c.id);
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => onToggle(c.id)}
                  style={{
                    padding: '0.25rem 0.55rem', borderRadius: 4,
                    border: `1px solid ${isSelected ? 'var(--accent, #C17D3C)' : 'var(--line-1)'}`,
                    background: isSelected ? 'var(--accent, #C17D3C)' : 'transparent',
                    color: isSelected ? 'var(--bg-1)' : 'var(--text)',
                    cursor: 'pointer', fontSize: 12,
                  }}
                >
                  {c.emoji ? `${c.emoji} ` : ''}{c.name}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
