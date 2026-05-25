/**
 * Escape HTML special characters for safe embedding in email and other HTML.
 * Shared across the four email-template files so a single canonical helper
 * is the single source of truth — and so a deliberate no-deps module breaks
 * the require cycle between emailTemplates.js and its lifecycle/payroll
 * siblings.
 *
 * Returns '' for null/undefined. Coerces every other value (including 0
 * and false) to its string form so valid zero/false values still render.
 */
function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { esc };
