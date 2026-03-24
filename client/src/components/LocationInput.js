import React, { useState, useEffect, useRef, useCallback } from 'react';

/**
 * Address autocomplete using Nominatim (OpenStreetMap) — free, no API key.
 */
export default function LocationInput({ value, onChange, onSelect, placeholder = 'Start typing an address...', className = 'form-input' }) {
  const [query, setQuery] = useState(value || '');
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const debounceRef = useRef(null);
  const containerRef = useRef(null);

  // Keep local query in sync if parent changes value externally
  useEffect(() => { setQuery(value || ''); }, [value]);

  // Close on outside click
  useEffect(() => {
    const handler = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const formatAddress = (d) => {
    const a = d.address || {};
    const street = [a.house_number, a.road].filter(Boolean).join(' ');
    const city = a.city || a.town || a.village || a.hamlet || '';
    const state = a.state || '';
    const zip = a.postcode || '';
    const stateZip = [state, zip].filter(Boolean).join(' ');
    return [street, city, stateZip].filter(Boolean).join(', ');
  };

  const fetchSuggestions = useCallback((q) => {
    if (q.length < 3) { setSuggestions([]); setOpen(false); return; }
    fetch(
      `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=5&countrycodes=us&q=${encodeURIComponent(q)}`,
      { headers: { 'Accept-Language': 'en' } }
    )
      .then(r => r.json())
      .then(data => {
        const results = data.map(d => ({
          address: formatAddress(d),
          lat: parseFloat(d.lat),
          lng: parseFloat(d.lon),
        })).filter(r => r.address);
        setSuggestions(results);
        setOpen(results.length > 0);
        setActiveIdx(-1);
      })
      .catch(() => { setSuggestions([]); setOpen(false); });
  }, []); // eslint-disable-line

  const handleChange = (e) => {
    const q = e.target.value;
    setQuery(q);
    onChange(q);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchSuggestions(q), 350);
  };

  const select = (item) => {
    const address = typeof item === 'string' ? item : item.address;
    setQuery(address);
    onChange(address);
    if (onSelect && item.lat != null && item.lng != null) {
      onSelect(address, { lat: item.lat, lng: item.lng });
    }
    setSuggestions([]);
    setOpen(false);
  };

  const handleKeyDown = (e) => {
    if (!open || suggestions.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx(i => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && activeIdx >= 0 && suggestions[activeIdx]) {
      e.preventDefault();
      select(suggestions[activeIdx]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <input
        className={className}
        value={query}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onFocus={() => { if (suggestions.length > 0) setOpen(true); }}
        placeholder={placeholder}
        autoComplete="off"
      />
      {open && suggestions.length > 0 && (
        <ul style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 1000,
          background: '#fff', border: '1px solid #c8b99a', borderRadius: '6px',
          boxShadow: '0 4px 16px rgba(0,0,0,0.15)', margin: '2px 0 0', padding: 0,
          listStyle: 'none', maxHeight: '220px', overflowY: 'auto',
        }}>
          {suggestions.map((s, i) => (
            <li
              key={i}
              onMouseDown={() => select(s)}
              style={{
                padding: '0.55rem 0.85rem',
                cursor: 'pointer',
                fontSize: '0.88rem',
                color: '#2C1F0E',
                background: i === activeIdx ? '#f5ede0' : '#fff',
                borderBottom: i < suggestions.length - 1 ? '1px solid #ede3d3' : 'none',
              }}
            >
              {s.address || s}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
