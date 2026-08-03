/**
 * Compiles the structured "design" of a marketing email (the ordered blocks
 * authored in the admin drag-and-drop builder) into the persisted, canonical
 * { design_json, html_body, text_body }.
 *
 * The design is the source of truth: html_body/text_body are always rendered
 * FROM the blocks (never trusted from the client), so the email that ships is
 * exactly what the server renderer produces. Rich-text fields inside blocks are
 * sanitized here through the shared email allowlist before rendering/storing.
 */

const { sanitizeHtml } = require('./emailSanitize');
const { renderBlocksToHtml, blocksToText } = require('./emailBlockRenderer');

/**
 * Deep-sanitize the user-authored html fields inside a design's blocks
 * (text blocks, and the two sides of a columns block, and hero rich text).
 */
function sanitizeDesignBlocks(blocks) {
  if (!Array.isArray(blocks)) return [];
  return blocks.map((b) => {
    if (!b || typeof b !== 'object') return null;
    const props = { ...(b.props || {}) };
    if (typeof props.html === 'string') props.html = sanitizeHtml(props.html);
    if (props.left && typeof props.left.html === 'string') {
      props.left = { ...props.left, html: sanitizeHtml(props.left.html) };
    }
    if (props.right && typeof props.right.html === 'string') {
      props.right = { ...props.right, html: sanitizeHtml(props.right.html) };
    }
    return { id: b.id, type: b.type, props };
  }).filter(Boolean);
}

/**
 * @param {{version?:number, blocks:Array}} design
 * @param {{baseUrl?:string}} [opts] absolutizes root-relative image/link URLs for email.
 * @returns {{design_json:object, html_body:string, text_body:(string|null)}|null}
 *   null when there is no real design (caller falls back to legacy html_body).
 */
function compileDesign(design, opts = {}) {
  if (!design || !Array.isArray(design.blocks) || design.blocks.length === 0) return null;
  const blocks = sanitizeDesignBlocks(design.blocks);
  const inner = renderBlocksToHtml(blocks, { baseUrl: opts.baseUrl || '' });
  return {
    design_json: { version: 1, blocks },
    html_body: sanitizeHtml(inner),
    text_body: blocksToText(blocks) || null,
  };
}

module.exports = { compileDesign, sanitizeDesignBlocks };
