import React from 'react';

export default function FieldError({ error }) {
  if (!error) return null;
  return (
    <div className="field-error" role="alert" aria-live="polite">
      {error}
    </div>
  );
}
