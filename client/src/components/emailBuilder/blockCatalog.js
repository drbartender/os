// Catalog of email block types for the drag-and-drop designer.
// The shape here MUST stay in sync with the server renderer
// (server/utils/emailBlockRenderer.js), which is the source of truth for the
// HTML that actually ships.

export const BRAND = {
  primary: '#3b2314',
  secondary: '#6b4226',
  bg: '#f9f6f3',
  white: '#ffffff',
};

// Ordered list shown in the "Add block" palette.
export const BLOCK_TYPES = [
  { type: 'heading', label: 'Heading', hint: 'A big title line' },
  { type: 'text', label: 'Text', hint: 'A paragraph of rich text' },
  { type: 'image', label: 'Image', hint: 'A single photo' },
  { type: 'button', label: 'Button', hint: 'A call-to-action button' },
  { type: 'hero', label: 'Hero', hint: 'Banner image + headline + button' },
  { type: 'columns', label: 'Two columns', hint: 'Side-by-side image/text' },
  { type: 'divider', label: 'Divider', hint: 'A horizontal line' },
  { type: 'spacer', label: 'Spacer', hint: 'Vertical breathing room' },
];

const LABELS = BLOCK_TYPES.reduce((m, b) => { m[b.type] = b.label; return m; }, {});
export const blockLabel = (type) => LABELS[type] || type;

function newId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `b_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

// Default props for a freshly added block of each type.
const DEFAULTS = {
  heading: () => ({ text: 'Your headline here', level: 'h2', align: 'left' }),
  text: () => ({ html: '<p>Write your message here. Highlight what makes this event or offer special.</p>' }),
  image: () => ({ src: '', alt: '', href: '', align: 'center', width: 'full' }),
  button: () => ({ label: 'Book Dr. Bartender', href: 'https://drbartender.com', align: 'center', bg: BRAND.primary, color: BRAND.white }),
  hero: () => ({ src: '', alt: '', heading: 'Raise the bar at your next event', subtext: 'Craft cocktails, mocktails, and pro bartenders — for weddings, parties, and everything in between.', buttonLabel: 'Get a quote', buttonHref: 'https://drbartender.com' }),
  columns: () => ({ left: { src: '', alt: '', html: '<p>Left column text.</p>' }, right: { src: '', alt: '', html: '<p>Right column text.</p>' } }),
  divider: () => ({}),
  spacer: () => ({ height: 24 }),
};

export function makeBlock(type) {
  const build = DEFAULTS[Object.prototype.hasOwnProperty.call(DEFAULTS, type) ? type : 'text'];
  return { id: newId(), type, props: build() };
}

// Deep-ish clone for duplicating a block (props are plain JSON-safe objects).
export function cloneBlock(block) {
  return { id: newId(), type: block.type, props: JSON.parse(JSON.stringify(block.props || {})) };
}

// Give any incoming blocks (e.g. loaded from a saved campaign) fresh ids if
// they're missing, so drag-and-drop keys are always stable/unique.
export function normalizeBlocks(blocks) {
  if (!Array.isArray(blocks)) return [];
  return blocks
    .filter((b) => b && typeof b.type === 'string')
    .map((b) => ({ id: b.id || newId(), type: b.type, props: b.props || {} }));
}
