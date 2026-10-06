import React, { useEffect, useRef, useState } from 'react';
import api from '../../utils/api';
import { BUNDLE_INCLUDED } from '../../utils/proposalRules';

// The "Package details" disclosure on Event Detail AND Proposal Detail (it was
// the same 25 lines on both pages). Shows the package's contents, then every
// add-on on the proposal with its catalog description, and for a bundle such
// as The Foundation the items it includes (Dallas, 2026-09-22: "when I click on
// package details I need to see the add-on details as well").
//
// Names come from the pricing snapshot when it has the add-on, so a variant
// reads exactly as the pricing card prints it ("Non-Alcoholic Bubbles Toast"),
// else from the stored row. Descriptions and bundle contents come from the
// admin add-on catalog, fetched once the disclosure is open AND there are
// add-ons to describe, whichever comes second (a disclosure left open while an
// edit reloads the proposal with its first add-on still gets its catalog):
// names never wait on it, and a failed or partial catalog (a retired add-on is
// not in it) only drops the descriptions.

export default function PackageDetails({ packageStructured, includes = [], addons = [], snapshotAddons = [] }) {
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState(null);       // service_addons rows | null
  const [catalogState, setCatalogState] = useState('idle'); // idle | loading | ready | error
  const requested = useRef(false);

  const rows = Array.isArray(addons) ? addons : [];
  const hasRows = rows.length > 0;

  useEffect(() => {
    if (!open || !hasRows || requested.current) return;
    requested.current = true;
    setCatalogState('loading');
    api.get('/proposals/addons')
      .then((res) => { setCatalog(Array.isArray(res.data) ? res.data : []); setCatalogState('ready'); })
      .catch(() => setCatalogState('error'));
  }, [open, hasRows]);

  if (!packageStructured && includes.length === 0 && !hasRows) return null;

  const byId = new Map((catalog || []).map((a) => [Number(a.id), a]));
  const bySlug = new Map((catalog || []).map((a) => [a.slug, a]));
  const snapById = new Map((Array.isArray(snapshotAddons) ? snapshotAddons : []).map((a) => [Number(a.id), a]));

  return (
    <details style={{ marginTop: 12 }} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="meta-k" style={{ cursor: 'pointer' }}>Package details</summary>
      <div style={{ marginTop: 8, fontSize: 12.5 }}>
        {packageStructured ? (
          packageStructured.map((section, si) => (
            <div key={si} style={{ marginBottom: 8 }}>
              <div style={{ fontWeight: 600, marginBottom: 2 }}>{section.heading}</div>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {section.items.map((item, i) => <li key={i}>{item}</li>)}
              </ul>
            </div>
          ))
        ) : includes.length > 0 ? (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {includes.map((item, i) => <li key={i}>{item}</li>)}
          </ul>
        ) : null}

        {rows.length > 0 && (
          <div style={{ marginBottom: 8, marginTop: packageStructured || includes.length > 0 ? 4 : 0 }}>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>Add-ons</div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {rows.map((row) => {
                const cat = byId.get(Number(row.addon_id));
                const snap = snapById.get(Number(row.addon_id));
                const name = (snap && snap.name) || row.addon_name || (cat && cat.name) || 'Add-on';
                const included = cat ? (BUNDLE_INCLUDED[cat.slug] || []) : [];
                return (
                  <li key={row.id || row.addon_id} style={{ marginBottom: 4 }}>
                    <div>{name}</div>
                    {cat && cat.description && <div className="muted">{cat.description}</div>}
                    {included.length > 0 && (
                      <div className="muted">
                        Includes: {included.map((slug) => (bySlug.get(slug) || {}).name || slug).join(', ')}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            {catalogState === 'loading' && <div className="muted tiny">Loading add-on details…</div>}
            {catalogState === 'error' && <div className="muted tiny">Add-on details could not be loaded.</div>}
          </div>
        )}
      </div>
    </details>
  );
}
