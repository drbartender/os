import React from 'react';

export default function EquipmentDisplay({ profile, editing, editForm, updateField }) {
  const items = [
    ['equipment_portable_bar', 'Portable Bar'],
    ['equipment_cooler', 'Cooler'],
    ['equipment_table_with_spandex', '6ft Table w/ Spandex'],
    ['equipment_none_but_open', 'Open to Getting Equipment'],
    ['equipment_no_space', 'No Space'],
    ['equipment_will_pickup', 'Will Pick Up from Storage'],
  ];

  if (editing) {
    return (
      <div className="vstack" style={{ gap: 6 }}>
        {items.map(([key, label]) => (
          <label key={key} className="hstack" style={{ gap: 8, fontSize: 12.5, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={!!editForm[key]}
              onChange={(e) => updateField(key, e.target.checked)}
            />
            {label}
          </label>
        ))}
      </div>
    );
  }
  const owned = items.filter(([k]) => profile?.[k]);
  if (owned.length === 0) return <div className="muted tiny">No equipment listed.</div>;
  return (
    <div className="hstack" style={{ flexWrap: 'wrap', gap: 6 }}>
      {owned.map(([k, label]) => <span key={k} className="tag">{label}</span>)}
    </div>
  );
}
