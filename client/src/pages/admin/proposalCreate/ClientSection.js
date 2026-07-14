import React, { useState, useEffect } from 'react';
import api from '../../../utils/api';
import { formatPhoneInput, stripPhone } from '../../../utils/formatPhone';
import Icon from '../../../components/adminos/Icon';
import FieldError from '../../../components/FieldError';
import { fmt$ } from '../../../components/adminos/format';
import { CLIENT_SOURCES as SOURCES } from '../../../utils/clientSources';

function initialsOf(name) {
  if (!name) return '?';
  return name.split(/\s+/).map(s => s[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}

export default function ClientSection({ form, merge, update, fieldErrors }) {
  const [editing, setEditing] = useState(!form.client_name);
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);

  // Quick client lookup
  useEffect(() => {
    if (!editing || !q) { setResults([]); return; }
    const t = setTimeout(() => {
      setSearching(true);
      api.get('/clients', { params: { search: q } })
        .then(r => setResults((r.data || []).slice(0, 5)))
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 200);
    return () => clearTimeout(t);
  }, [q, editing]);

  if (!editing && form.client_name) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', border: '1px solid var(--line-1)', borderRadius: 4, background: 'var(--bg-2)' }}>
        <div className="avatar" style={{ width: 28, height: 28, fontSize: 11 }}>{initialsOf(form.client_name)}</div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink-1)' }}>{form.client_name}</div>
          <div className="tiny" style={{ color: 'var(--ink-3)' }}>
            {form.client_email || 'no email'}
            {form.client_phone && ` · ${formatPhoneInput(form.client_phone)}`}
          </div>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>Change</button>
      </div>
    );
  }

  return (
    <div>
      <div className="input-group" style={{ padding: '0 10px' }}>
        <Icon name="search" />
        <input
          autoFocus={!form.client_name}
          placeholder="Search clients or type a new name…"
          value={q || form.client_name}
          onChange={(e) => {
            setQ(e.target.value);
            // free-typing also seeds the new-client name
            merge({ client_id: null, client_name: e.target.value });
          }}
        />
      </div>

      {/* Search results dropdown */}
      {q && (results.length > 0 || searching) && (
        <div style={{ marginTop: 6, border: '1px solid var(--line-1)', borderRadius: 4, background: 'var(--bg-1)', maxHeight: 200, overflow: 'auto' }}>
          {searching && <div className="muted tiny" style={{ padding: '7px 10px' }}>Searching…</div>}
          {results.map(c => (
            <div
              key={c.id}
              onClick={() => {
                merge({
                  client_id: c.id,
                  client_name: c.name,
                  client_email: c.email || '',
                  client_phone: c.phone || '',
                  client_source: c.source || 'direct',
                });
                setEditing(false);
                setQ('');
              }}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px',
                borderBottom: '1px solid var(--line-1)', cursor: 'pointer',
              }}
            >
              <div className="avatar" style={{ width: 22, height: 22, fontSize: 9 }}>{initialsOf(c.name)}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5 }}>{c.name}</div>
                <div className="tiny" style={{ color: 'var(--ink-3)' }}>{c.email || '—'}</div>
              </div>
              {c.lifetime_value != null && (
                <span className="tiny mono" style={{ color: 'var(--ink-3)' }}>{fmt$(c.lifetime_value)}</span>
              )}
            </div>
          ))}
        </div>
      )}

      <FieldError error={fieldErrors?.client_name} />

      {/* New-client extra fields */}
      {!form.client_id && form.client_name && (
        <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          <input
            className="input"
            placeholder="Email"
            type="email"
            value={form.client_email}
            onChange={e => update('client_email', e.target.value)}
          />
          <input
            className="input"
            placeholder="Phone"
            value={formatPhoneInput(form.client_phone)}
            onChange={e => update('client_phone', stripPhone(e.target.value))}
          />
          <select
            className="select"
            value={form.client_source}
            onChange={e => update('client_source', e.target.value)}
            style={{ gridColumn: 'span 2' }}
          >
            {SOURCES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </div>
      )}
    </div>
  );
}
