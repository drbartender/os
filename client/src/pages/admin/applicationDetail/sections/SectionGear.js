import React from 'react';

// Bar tools + equipment derived from the boolean columns on `applications`,
// plus availability summary (Saturdays + other commitments).
const TOOLS = [
  ['tools_mixing_tins', 'Mixing tins'],
  ['tools_strainer',    'Strainer'],
  ['tools_ice_scoop',   'Ice scoop'],
  ['tools_bar_spoon',   'Bar spoon'],
  ['tools_tongs',       'Tongs'],
  ['tools_ice_bin',     'Ice bin'],
  ['tools_bar_mats',    'Bar mats'],
  ['tools_bar_towels',  'Bar towels'],
];
const EQUIPMENT = [
  ['equipment_portable_bar',       'Portable bar'],
  ['equipment_cooler',             'Cooler'],
  ['equipment_table_with_spandex', '6ft Table w/ Spandex'],
];

export default function SectionGear({ a }) {
  const tools = TOOLS.filter(([k]) => a[k]).map(([, l]) => l);
  const equip = EQUIPMENT.filter(([k]) => a[k]).map(([, l]) => l);

  const toolsPlaceholder = a.tools_none_will_start
    ? 'None — will start with team kit'
    : 'None listed';
  const equipPlaceholder = a.equipment_none_but_open
    ? 'None — open to acquiring'
    : a.equipment_no_space
    ? 'No space for equipment'
    : 'None listed';

  return (
    <div className="card">
      <div className="card-head"><h3>Tools &amp; equipment</h3></div>
      <div className="card-body">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
          <div>
            <div className="tiny muted" style={{
              textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 10, marginBottom: 6,
            }}>Bar tools owned</div>
            <div className="hstack" style={{ flexWrap: 'wrap', gap: 6 }}>
              {tools.length === 0
                ? <span className="tiny muted">{toolsPlaceholder}</span>
                : tools.map(t => <span key={t} className="tag">{t}</span>)}
            </div>
          </div>
          <div>
            <div className="tiny muted" style={{
              textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 10, marginBottom: 6,
            }}>Bar equipment</div>
            <div className="hstack" style={{ flexWrap: 'wrap', gap: 6 }}>
              {equip.length === 0
                ? <span className="tiny muted">{equipPlaceholder}</span>
                : equip.map(t => <span key={t} className="tag">{t}</span>)}
            </div>
          </div>
        </div>
        <div style={{ borderTop: '1px solid var(--line-1)', paddingTop: 12, marginTop: 14 }}>
          <dl className="dl">
            <dt>Saturdays</dt><dd>{a.available_saturdays || '—'}</dd>
            <dt>Other commitments</dt><dd>{a.other_commitments || '—'}</dd>
          </dl>
        </div>
      </div>
    </div>
  );
}
