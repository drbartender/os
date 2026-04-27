// Build the dynamic step list based on alcohol choice
export function getSteps(alcoholProvider) {
  const steps = [{ key: 'event', label: 'Event Details' }];
  steps.push({ key: 'contact', label: 'Your Info' });
  if (alcoholProvider === 'hosted') {
    steps.push({ key: 'package', label: 'Package' });
  }
  steps.push({ key: 'addons', label: 'Extras' });
  steps.push({ key: 'review', label: 'Review' });
  return steps;
}

// Short taglines shown on tile before expanding (Extras step)
export const ADDON_TAGLINES = {
  // BYOB bundles
  'the-foundation': 'Ice, water, cups & napkins — the essentials',
  'the-formula': 'Foundation + mixers, garnishes & bitters',
  'the-full-compound': 'The works — full mixers, premium garnishes & more',
  // Premium
  'champagne-toast': 'We provide the champagne and flutes',
  'real-glassware': 'Rocks glasses, coupes & wine glasses — no plastic',
  'flavor-blaster-rental': 'Aromatic bubbles that burst on the first sip',
  'smoked-cocktail-kit': 'Torch and wood chips — smoke any drink on demand',
  // Beverage
  'soft-drink-addon': 'Required when 10+ guests (or 20%) drink soda on their own',
  'mocktail-bar': 'We bring all the specialty ingredients',
  'pre-batched-mocktail': 'Simple, ready-to-pour NA option',
  'house-made-ginger-beer': 'Fresh-pressed, carbonated live at the bar',
  'carbonated-cocktails': 'Up to 2 signature cocktails fully infused with CO2 for a sparkling, effervescent finish',
  // Staffing
  'barback': 'Keeps your bartender at the bar, not restocking',
  'banquet-server': 'Circulate drinks, bus glasses & more',
  'additional-bartender': 'Beyond our recommended 1-per-100 ratio',
  // Logistics
  'parking-fee': 'Only if your venue charges for parking',
};

export const formatCurrency = (amount) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
