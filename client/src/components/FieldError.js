// FieldError (React component, default export). Header generated from the file's exports by
// migrate-headers on 2026-10-27; replace with what it does.

import React from 'react';

export default function FieldError({ error }) {
  if (!error) return null;
  return (
    <div className="field-error" role="alert" aria-live="polite">
      {error}
    </div>
  );
}
