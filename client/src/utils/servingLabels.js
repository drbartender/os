// Shared serving-type display labels (extracted from DrinkPlansDashboard so
// the Potions plans drawer and the drink-plans index render identically).
export const SERVING_LABEL = {
  full_bar: 'Full Bar',
  beer_wine: 'Beer & Wine',
  beer_wine_seltzer: 'Beer, Wine & Seltzer',
  non_alcoholic: 'Non-Alcoholic',
  mocktail: 'Mocktail',
};

export function servingLabel(servingType) {
  return SERVING_LABEL[servingType] || servingType || '';
}
