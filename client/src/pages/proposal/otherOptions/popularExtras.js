// The chips the extras strip surfaces before the full a la carte list.
//
// Curated, not a catalog field: "popular" is a merchandising judgement, and
// putting it in service_addons would mean an admin edit to change which four
// show first. Seeded from the design artifact's own four. The strip UNIONS this
// with everything already committed or drafted, so a client never has to expand
// the full list to find something they already have on.
export const POPULAR_EXTRA_SLUGS = [
  'champagne-toast',
  'house-made-ginger-beer',
  'real-glassware',
  'garnish-package-only',
];

export default POPULAR_EXTRA_SLUGS;
