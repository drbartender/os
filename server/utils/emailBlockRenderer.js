/**
 * Email block renderer — turns the structured "design" of a marketing email
 * (an ordered list of blocks authored in the admin drag-and-drop builder) into
 * bulletproof, email-client-safe HTML using nested tables + inline styles.
 *
 * This is the SINGLE SOURCE OF TRUTH for how a designed campaign looks. The
 * client builder renders a lightweight approximation for editing; the actual
 * email that ships (and the admin preview) is produced here so "what you send"
 * always matches one implementation.
 *
 * The output is the INNER content only — it is meant to be passed to
 * wrapMarketingEmail(innerHtml, unsubscribeUrl), which supplies the outer
 * 600px branded shell (header + footer + unsubscribe).
 *
 * Security note: callers MUST sanitize any user-authored HTML (text/columns/
 * hero rich-text fields) BEFORE handing blocks to this renderer. The renderer
 * treats those html fields as already-trusted and does not re-sanitize.
 */

const { esc } = require('./htmlEscape');

// Mirrors BRAND in emailTemplates.js. Kept local so this module has no
// coupling to the template file's internals.
const BRAND = {
  dark: '#2d1810',
  primary: '#3b2314',
  secondary: '#6b4226',
  bg: '#f9f6f3',
  white: '#ffffff',
  border: '#e0d6cf',
};

// Single quotes only: FONT lands inside double-quoted style="..." attributes,
// where a double quote would terminate the attribute and drop every
// declaration after font-family.
const FONT = "Georgia, 'Times New Roman', serif";
// Usable content width inside wrapMarketingEmail's padded 600px shell
// (600 - 28*2 padding). Images/heroes size to this.
const CONTENT_WIDTH = 544;

const ALIGNS = ['left', 'center', 'right'];
const safeAlign = (a) => (ALIGNS.includes(a) ? a : 'left');

/**
 * Absolutize a root-relative URL (e.g. "/api/blog/images/x.jpg") against the
 * public API base so email clients can load it. Leaves absolute URLs and
 * anchors/mailto untouched. Returns '' for empty input.
 */
function absolutize(url, baseUrl) {
  if (!url) return '';
  const u = String(url).trim();
  if (u.startsWith('/') && baseUrl) {
    return `${String(baseUrl).replace(/\/$/, '')}${u}`;
  }
  return u;
}

// Scheme allowlist for anything that becomes an href/src in outbound mail.
// esc() only escapes HTML metacharacters — it does NOT neutralize
// `javascript:` URLs, so every URL prop must pass through here before
// rendering rather than relying on a downstream sanitize pass.
const SAFE_URL_SCHEME = /^(https?:|mailto:|tel:)/i;
function safeUrl(url, baseUrl) {
  const u = absolutize(url, baseUrl);
  return SAFE_URL_SCHEME.test(u) ? u : '';
}

// ─── Individual block renderers ──────────────────────────────────
// Each returns a string of email-safe HTML. `ctx` carries { baseUrl }.

function renderHeading(p, _ctx) {
  const level = ['h1', 'h2', 'h3'].includes(p.level) ? p.level : 'h2';
  const sizes = { h1: 28, h2: 22, h3: 18 };
  const align = safeAlign(p.align);
  const text = esc(p.text || '');
  if (!text) return '';
  return `<${level} style="margin:0 0 14px;font-family:${FONT};font-weight:bold;color:${BRAND.primary};text-align:${align};font-size:${sizes[level]}px;line-height:1.25;">${text}</${level}>`;
}

function renderText(p, _ctx) {
  const html = p.html || '';
  if (!html.trim()) return '';
  return `<div style="margin:0 0 14px;font-family:${FONT};font-size:16px;line-height:1.6;color:${BRAND.primary};">${html}</div>`;
}

function renderImage(p, ctx) {
  const src = safeUrl(p.src, ctx.baseUrl);
  if (!src) return '';
  const align = safeAlign(p.align || 'center');
  const alt = esc(p.alt || '');
  const href = safeUrl(p.href, ctx.baseUrl);
  const widthPct = p.width === 'half' ? 50 : p.width === 'third' ? 33 : 100;
  const px = Math.round((CONTENT_WIDTH * widthPct) / 100);
  const img = `<img src="${esc(src)}" alt="${alt}" width="${px}" style="display:block;width:100%;max-width:${px}px;height:auto;border:0;outline:none;text-decoration:none;border-radius:6px;margin:0 auto;" />`;
  const inner = href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${img}</a>` : img;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px;"><tr><td align="${align}">${inner}</td></tr></table>`;
}

function renderButton(p, ctx) {
  const label = esc(p.label || 'Click here');
  const href = safeUrl(p.href, ctx.baseUrl) || '#';
  const align = safeAlign(p.align || 'center');
  const bg = /^#[0-9a-fA-F]{3,8}$/.test(p.bg || '') ? p.bg : BRAND.primary;
  const color = /^#[0-9a-fA-F]{3,8}$/.test(p.color || '') ? p.color : BRAND.white;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 18px;"><tr><td align="${align}">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${bg}" style="border-radius:6px;">
      <a href="${esc(href)}" target="_blank" rel="noopener" style="display:inline-block;padding:14px 32px;background:${bg};color:${color};text-decoration:none;border-radius:6px;font-weight:bold;font-size:16px;font-family:${FONT};">${label}</a>
    </td></tr></table>
  </td></tr></table>`;
}

function renderDivider(_p, _ctx) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:10px 0 24px;"><div style="border-top:1px solid ${BRAND.border};font-size:0;line-height:0;">&nbsp;</div></td></tr></table>`;
}

function renderSpacer(p, _ctx) {
  const h = Math.min(120, Math.max(4, parseInt(p.height, 10) || 24));
  return `<div style="height:${h}px;line-height:${h}px;font-size:0;">&nbsp;</div>`;
}

function renderHero(p, ctx) {
  const src = safeUrl(p.src, ctx.baseUrl);
  const heading = esc(p.heading || '');
  const subtext = esc(p.subtext || '');
  const rows = [];
  if (src) {
    rows.push(`<tr><td style="padding:0 0 16px;"><img src="${esc(src)}" alt="${esc(p.alt || '')}" width="${CONTENT_WIDTH}" style="display:block;width:100%;max-width:100%;height:auto;border:0;border-radius:8px;" /></td></tr>`);
  }
  if (heading) {
    rows.push(`<tr><td style="text-align:center;padding:0 0 8px;"><span style="font-family:${FONT};font-weight:bold;font-size:26px;color:${BRAND.primary};line-height:1.25;">${heading}</span></td></tr>`);
  }
  if (subtext) {
    rows.push(`<tr><td style="text-align:center;padding:0 0 14px;"><span style="font-family:${FONT};font-size:16px;color:${BRAND.secondary};line-height:1.5;">${subtext}</span></td></tr>`);
  }
  if (!rows.length && !p.buttonLabel) return '';
  const btn = p.buttonLabel
    ? renderButton({ label: p.buttonLabel, href: p.buttonHref, align: 'center' }, ctx)
    : '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px;">${rows.join('')}</table>${btn}`;
}

function renderColumnSide(side, ctx) {
  const parts = [];
  const src = safeUrl(side && side.src, ctx.baseUrl);
  if (src) {
    parts.push(`<img src="${esc(src)}" alt="${esc((side && side.alt) || '')}" width="256" style="display:block;width:100%;max-width:100%;height:auto;border:0;border-radius:6px;margin:0 0 8px;" />`);
  }
  if (side && side.html && side.html.trim()) {
    parts.push(`<div style="font-family:${FONT};font-size:15px;line-height:1.55;color:${BRAND.primary};">${side.html}</div>`);
  }
  return parts.join('');
}

function renderColumns(p, ctx) {
  const left = renderColumnSide(p.left, ctx);
  const right = renderColumnSide(p.right, ctx);
  if (!left && !right) return '';
  // Note: side-by-side at all widths in v1 (no mobile stacking). At the 544px
  // content width each column is ~256px, which stays legible on phones.
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px;"><tr>
    <td width="50%" valign="top" style="padding:0 8px 0 0;">${left}</td>
    <td width="50%" valign="top" style="padding:0 0 0 8px;">${right}</td>
  </tr></table>`;
}

const RENDERERS = {
  heading: renderHeading,
  text: renderText,
  image: renderImage,
  button: renderButton,
  divider: renderDivider,
  spacer: renderSpacer,
  hero: renderHero,
  columns: renderColumns,
};

/**
 * Render an ordered list of blocks into inner email HTML.
 * @param {Array<{type:string, props:object}>} blocks
 * @param {{baseUrl?: string}} [opts] baseUrl absolutizes root-relative image/link URLs.
 * @returns {string} inner HTML (pass to wrapMarketingEmail)
 */
function renderBlocksToHtml(blocks, opts = {}) {
  if (!Array.isArray(blocks)) return '';
  const ctx = { baseUrl: opts.baseUrl || '' };
  const has = (t) => typeof t === 'string' && Object.prototype.hasOwnProperty.call(RENDERERS, t);
  return blocks
    .map((b) => {
      if (!b || !has(b.type)) return ''; // ignore unknown / prototype-key types
      try {
        return RENDERERS[b.type](b.props || {}, ctx);
      } catch (_e) {
        return '';
      }
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Best-effort plain-text version of a design, used as the text/plain MIME part
 * (helps deliverability + accessibility). Strips tags from rich-text fields.
 */
function stripTags(html) {
  return String(html || '')
    .replace(/<br\s*\/?>(?=)/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function blockToText(b) {
  const p = (b && b.props) || {};
  switch (b && b.type) {
    case 'heading': return stripTags(p.text);
    case 'text': return stripTags(p.html);
    case 'button': return p.label && p.href ? `${stripTags(p.label)}: ${p.href}` : stripTags(p.label);
    case 'hero': {
      const bits = [stripTags(p.heading), stripTags(p.subtext)];
      if (p.buttonLabel && p.buttonHref) bits.push(`${stripTags(p.buttonLabel)}: ${p.buttonHref}`);
      return bits.filter(Boolean).join('\n');
    }
    case 'columns': return [stripTags(p.left && p.left.html), stripTags(p.right && p.right.html)].filter(Boolean).join('\n');
    case 'image': return p.alt ? stripTags(p.alt) : '';
    default: return '';
  }
}

function blocksToText(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks.map(blockToText).filter(Boolean).join('\n\n');
}

module.exports = { renderBlocksToHtml, blocksToText, absolutize, CONTENT_WIDTH };
