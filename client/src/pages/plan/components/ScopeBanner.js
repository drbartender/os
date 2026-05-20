import React from 'react';

/**
 * Scope banner that frames each step's purpose for the client.
 *
 * Three tones:
 *   - "shopping" (brass): BYOB; the section feeds the shopping list
 *   - "hosted" (teal):    hosted package; we're providing
 *   - "aside" (muted):    not part of shopping (menu design)
 *
 * The seal character (default apothecary alembic) renders on the left in a small circle.
 */
export default function ScopeBanner({ tone = 'shopping', title, body, seal = '⚗' }) {
  return (
    <div className={`potion-scope ${tone}`}>
      <span className="potion-scope-seal" aria-hidden="true">{seal}</span>
      <div className="potion-scope-body">
        <h3 className="potion-scope-title">{title}</h3>
        <p className="potion-scope-text">{body}</p>
      </div>
    </div>
  );
}
