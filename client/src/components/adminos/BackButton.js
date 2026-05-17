import React, { useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import Icon from './Icon';

// react-router-dom@6 stamps the first history entry with key === 'default'.
// That means the user arrived cold (deep link, hard refresh, new tab, or a
// command-palette jump) and there is no in-app "back" — fall back to the
// section list. Otherwise navigate(-1) returns them exactly where they were.
export function useSmartBack(fallback) {
  const navigate = useNavigate();
  const location = useLocation();
  return useCallback(() => {
    if (location.key && location.key !== 'default') navigate(-1);
    else navigate(fallback);
  }, [navigate, location.key, fallback]);
}

export default function BackButton({ fallback }) {
  const onBack = useSmartBack(fallback);
  return (
    <button type="button" className="btn btn-ghost btn-sm" onClick={onBack}>
      <Icon name="left" size={11} />Back
    </button>
  );
}
