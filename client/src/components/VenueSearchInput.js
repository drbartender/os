import React, { useState, useRef, useEffect, useCallback } from 'react';
import api from '../utils/api';

// Typeahead for the venue-name field, backed by the Google Places proxy
// (/api/venues/*). Self-contained: owns its suggestion list, dropdown state,
// keyboard highlight, and Google session token. Parents pass only `value`
// plus two callbacks.
//
//   onChange(name)  — fires on every keystroke with the raw text.
//   onSelect(venue) — fires when a suggestion is chosen, with an object
//                     holding only the venue_* fields that have a value
//                     (always venue_name; address fields present only for an
//                     in-area match — see server/utils/googlePlaces.js).
//
// If the proxy returns nothing (key unset, API down, or no matches) the
// dropdown never appears and the field behaves as a plain text input.

const DEBOUNCE_MS = 250;
// Mirrors MIN_QUERY_LEN in server/utils/googlePlaces.js (the server re-checks).
const MIN_CHARS = 3;

export default function VenueSearchInput({
  value = '',
  onChange,
  onSelect,
  id = 'venue-name',
  inputClassName = 'form-input',
  placeholder = 'Start typing your venue name',
  disabled = false,
  ariaInvalid = false,
}) {
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);

  const wrapRef = useRef(null);
  const debounceRef = useRef(null);
  const sessionTokenRef = useRef('');
  const reqSeqRef = useRef(0);

  // Lazily mint a Google session token; reused across keystrokes of one
  // search, regenerated after a selection so each search bills as one session.
  const sessionToken = useCallback(() => {
    if (!sessionTokenRef.current) {
      sessionTokenRef.current =
        (window.crypto && window.crypto.randomUUID && window.crypto.randomUUID())
        || `${Date.now()}-${Math.random()}`;
    }
    return sessionTokenRef.current;
  }, []);

  // Close the dropdown on an outside click.
  useEffect(() => {
    function onDocClick(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  // Clear a pending debounce on unmount.
  useEffect(() => () => clearTimeout(debounceRef.current), []);

  const runSearch = useCallback(async (text) => {
    const seq = ++reqSeqRef.current;
    try {
      const res = await api.get('/venues/search', {
        params: { q: text, token: sessionToken() },
      });
      if (seq !== reqSeqRef.current) return; // a newer keystroke superseded this
      const results = (res.data && res.data.results) || [];
      setSuggestions(results);
      setHighlight(-1);
      setOpen(results.length > 0);
    } catch {
      if (seq !== reqSeqRef.current) return;
      setSuggestions([]);
      setOpen(false);
    }
  }, [sessionToken]);

  const handleInput = (e) => {
    const text = e.target.value;
    onChange(text);
    clearTimeout(debounceRef.current);
    if (text.trim().length < MIN_CHARS) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    debounceRef.current = setTimeout(() => runSearch(text.trim()), DEBOUNCE_MS);
  };

  const choose = async (suggestion) => {
    setOpen(false);
    setSuggestions([]);
    // Show the picked name immediately, before the details round-trip resolves.
    onChange(suggestion.name);
    // Same stale guard as runSearch: a slow details call must not overwrite a
    // newer selection, or a newer search the user started after picking.
    const seq = ++reqSeqRef.current;
    try {
      const res = await api.get(
        `/venues/details/${encodeURIComponent(suggestion.place_id)}`,
        { params: { token: sessionToken() } },
      );
      if (seq !== reqSeqRef.current) return;
      const venue = (res.data && res.data.venue) || {};
      onSelect({ ...venue, venue_name: venue.venue_name || suggestion.name });
    } catch {
      if (seq !== reqSeqRef.current) return;
      onSelect({ venue_name: suggestion.name });
    } finally {
      sessionTokenRef.current = ''; // next keystroke starts a fresh billing session
    }
  };

  const handleKeyDown = (e) => {
    if (!open || suggestions.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (highlight >= 0) choose(suggestions[highlight]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div className="venue-search" ref={wrapRef} style={{ position: 'relative' }}>
      <input
        id={id}
        className={inputClassName}
        value={value}
        onChange={handleInput}
        onKeyDown={handleKeyDown}
        onFocus={() => { if (suggestions.length > 0) setOpen(true); }}
        placeholder={placeholder}
        autoComplete="off"
        disabled={disabled}
        aria-invalid={ariaInvalid || undefined}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls={`${id}-listbox`}
        aria-activedescendant={open && highlight >= 0 ? `${id}-opt-${highlight}` : undefined}
      />
      {open && suggestions.length > 0 && (
        <ul className="venue-search-dropdown" role="listbox" id={`${id}-listbox`}>
          {suggestions.map((s, i) => (
            <li
              key={s.place_id}
              id={`${id}-opt-${i}`}
              className={`venue-search-option${i === highlight ? ' highlighted' : ''}`}
              role="option"
              aria-selected={i === highlight}
              onMouseDown={(e) => { e.preventDefault(); choose(s); }}
              onMouseEnter={() => setHighlight(i)}
            >
              <span className="venue-search-name">{s.name}</span>
              {s.address && <span className="venue-search-address">{s.address}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
