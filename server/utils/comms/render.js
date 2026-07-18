'use strict';

// Renders editable "parts" into a branded email. Parts are the compose-modal
// contract (spec 4.1): the admin edits `subject` and `bodyText` (plain prose);
// `heading` and `cta` are fixed by the action so an edit can never break the
// token link that makes the email work. bodyText is HTML-escaped here, so
// edited prose cannot inject markup.
const { wrapEmail, ctaButton, BRAND } = require('../lifecycleEmailTemplates');
const { esc } = require('../htmlEscape');

/**
 * @param {{subject: string, heading: string, bodyText: string, cta?: {label: string, url: string}}} parts
 * @returns {{subject: string, html: string, text: string}}
 */
function renderPartsEmail({ subject, heading, bodyText, cta }) {
  const paragraphs = String(bodyText)
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n      ');
  const html = wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">${esc(heading)}</h2>
      ${paragraphs}
      ${cta ? ctaButton(cta.url, cta.label) : ''}
    `);
  const text = `${bodyText}${cta ? `\n\n${cta.label}: ${cta.url}` : ''}`;
  return { subject, html, text };
}

module.exports = { renderPartsEmail };
