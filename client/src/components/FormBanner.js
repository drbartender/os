import React, { useEffect, useRef } from 'react';

export default function FormBanner({ error, fieldErrors }) {
  const ref = useRef(null);
  const hasFieldErrors = fieldErrors && Object.keys(fieldErrors).length > 0;
  const hasError = Boolean(error);
  const visible = hasError || hasFieldErrors;

  useEffect(() => {
    if (visible && ref.current) {
      ref.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [visible, error]);

  if (!visible) return null;

  const message = hasFieldErrors && !hasError
    ? 'Please fix the errors below.'
    : error;

  return (
    <div ref={ref} className="form-banner form-banner-error" role="alert">
      {message}
    </div>
  );
}
