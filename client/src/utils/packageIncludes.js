// Shared interpolation for package_includes strings. The DB rows carry
// {hours}, {bartenders}, and {bartenders_s} tokens; every client-facing
// surface that renders the includes list must run them through here.
// Extracted verbatim from the inline copy in proposalView/ProposalView.js;
// consumers: ProposalView, admin ProposalDetail, admin EventDetailPage,
// portal PrescriptionTab.
// A null/undefined ctx value leaves its token untouched (visible braces beat
// silently rendering a wrong number).
export function interpolatePackageIncludes(items, { durationHours, bartenders } = {}) {
  return (items || []).map((item) => {
    let text = item;
    if (durationHours != null) text = text.replace(/\{hours\}/g, durationHours);
    if (bartenders != null) {
      text = text.replace(/\{bartenders\}/g, bartenders);
      text = text.replace(/\{bartenders_s\}/g, bartenders !== 1 ? 's' : '');
    }
    return text;
  });
}
