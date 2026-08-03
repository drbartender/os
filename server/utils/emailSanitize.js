/**
 * Shared allowlist-based sanitizer for admin-authored email HTML.
 *
 * Admin is a trust boundary: a compromised admin/manager account must not be
 * able to inject <script> (or other active content) into outbound mail. Both
 * the simple rich-text campaign body and the rich-text fields inside designed
 * blocks pass through this before they are rendered or stored.
 *
 * Extracted from emailMarketing.js so the route file and the design compiler
 * (emailDesign.js) share ONE allowlist and can't drift apart.
 */

const createDOMPurify = require('dompurify');
const { JSDOM } = require('jsdom');

const DOMPurify = createDOMPurify(new JSDOM('').window);

const EMAIL_SANITIZE_OPTIONS = {
  ALLOWED_TAGS: ['a', 'b', 'br', 'div', 'em', 'h1', 'h2', 'h3', 'h4', 'hr', 'i', 'img',
    'li', 'ol', 'p', 'pre', 'span', 'strong', 'u', 'ul',
    'table', 'tbody', 'td', 'th', 'thead', 'tr'],
  // The presentational table attrs (role..bgcolor) are inert but load-bearing:
  // compileDesign runs the block renderer's own table+inline-style output back
  // through this list, and stripping align/valign/cellpadding/bgcolor silently
  // breaks button/image alignment and Outlook fallbacks in every designed email.
  ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'style', 'width', 'height', 'target', 'rel',
    'role', 'align', 'valign', 'cellpadding', 'cellspacing', 'border', 'bgcolor'],
  ALLOW_DATA_ATTR: false,
};

const sanitizeHtml = (html) =>
  html ? DOMPurify.sanitize(html, EMAIL_SANITIZE_OPTIONS) : html;

module.exports = { sanitizeHtml, EMAIL_SANITIZE_OPTIONS };
