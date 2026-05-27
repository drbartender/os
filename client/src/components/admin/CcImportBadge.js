import React from 'react';

// Small badge rendered next to a title (proposal, client, event) when the
// underlying row carries a non-null cc_id. Marks a record as imported from
// Check Cherry so the operator can spot legacy provenance at a glance.
//
// Null-safe: renders nothing when ccId is falsy, so the caller can drop it
// in unconditionally next to a title without a parent ternary.
//
// Spec §6.7 deliberately excludes the public-facing client portal — the
// badge lives on admin surfaces only.
export default function CcImportBadge({ ccId }) {
  if (!ccId) return null;
  return (
    <span
      className="badge badge-cc-import"
      title={`CC id: ${ccId}`}
      aria-label="Imported from Check Cherry"
    >
      Imported from CC
    </span>
  );
}
