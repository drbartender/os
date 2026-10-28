// ShareButton (React component, default export). Header generated from the file's exports by
// migrate-headers on 2026-10-27; replace with what it does.

import React from 'react';
import { useToast } from '../../../context/ToastContext';
export default function ShareButton({ url, label }) {
  const toast = useToast();
  const absolute = `${window.location.origin}${url}`;
  const onShare = async () => {
    if (navigator.share) { try { await navigator.share({ url: absolute }); return; } catch { /* fall to copy */ } }
    try { await navigator.clipboard.writeText(absolute); toast.success('Link copied'); }
    catch { toast.error('Could not copy the link'); }
  };
  return (<div className="cp-share">
    <button type="button" className="btn client-btn-outline" onClick={onShare}>{label}</button>
    <span className="cp-share-hint">Anyone with this link can view it.</span>
  </div>);
}
