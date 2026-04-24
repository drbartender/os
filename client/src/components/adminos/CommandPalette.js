import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import Icon from './Icon';

export default function CommandPalette({ open, onClose }) {
  const navigate = useNavigate();
  const [q, setQ] = useState('');

  useEffect(() => { if (open) setQ(''); }, [open]);

  if (!open) return null;

  const go = (path) => () => { navigate(path); onClose(); };

  const groups = [
    { group: 'Jump to', items: [
      { label: 'Dashboard',   icon: 'home',      onClick: go('/admin/dashboard') },
      { label: 'Events',      icon: 'calendar',  onClick: go('/admin/events') },
      { label: 'Proposals',   icon: 'clipboard', onClick: go('/admin/proposals') },
      { label: 'Clients',     icon: 'users',     onClick: go('/admin/clients') },
      { label: 'Staff',       icon: 'userplus',  onClick: go('/admin/staffing') },
      { label: 'Hiring',      icon: 'pen',       onClick: go('/admin/hiring') },
      { label: 'Financials',  icon: 'dollar',    onClick: go('/admin/financials') },
      { label: 'Marketing',   icon: 'mail',      onClick: go('/admin/email-marketing') },
      { label: 'Drink Plans', icon: 'flask',     onClick: go('/admin/drink-plans') },
      { label: 'Cocktail Menu', icon: 'book',    onClick: go('/admin/cocktail-menu') },
      { label: 'Lab Notes',   icon: 'pen',       onClick: go('/admin/blog') },
      { label: 'Settings',    icon: 'gear',      onClick: go('/admin/settings') },
    ]},
    { group: 'Create', items: [
      { label: 'New proposal', icon: 'plus', onClick: go('/admin/proposals/new') },
      { label: 'New campaign', icon: 'plus', onClick: go('/admin/email-marketing/campaigns/new') },
    ]},
    // TODO: hook up /api/admin/search in a follow-up PR to populate a live Records group.
  ];

  const filtered = groups
    .map(g => ({ ...g, items: g.items.filter(it => !q || it.label.toLowerCase().includes(q.toLowerCase())) }))
    .filter(g => g.items.length);

  return (
    <div className="palette-scrim open" onClick={onClose} role="dialog" aria-modal="true" aria-label="Command palette">
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <Icon name="search" />
          <input
            autoFocus
            placeholder="Type a command or search…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Command search"
          />
          <span className="kbd">Esc</span>
        </div>
        <div className="palette-list scroll-thin">
          {filtered.map(g => (
            <div key={g.group}>
              <div className="palette-group-label">{g.group}</div>
              {g.items.map(it => (
                <div key={it.label} className="palette-item" onClick={it.onClick} role="button" tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter') it.onClick(); }}>
                  <Icon name={it.icon} />
                  <div>
                    <div>{it.label}</div>
                  </div>
                  <div className="shortcut"><span className="kbd">↵</span></div>
                </div>
              ))}
            </div>
          ))}
          {!filtered.length && <div className="palette-item muted">No results.</div>}
        </div>
      </div>
    </div>
  );
}
