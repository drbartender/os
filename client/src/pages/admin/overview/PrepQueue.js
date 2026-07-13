import { dayDiff, fmtDate } from '../../../components/adminos/format';

// Prep queue items over the Potions-enriched drink-plans list (event-side plans
// are the canonical records; /drink-plans/:id is the admin surface for one).
// Vocabulary mirrors potions/PlansDrawer.js: plan statuses
// pending/draft/exploration_saved/submitted/reviewed, plus the shopping-list
// states pending_review ("List to review") and approved.

function proximityPriority(eventDate) {
  if (!eventDate) return 'info';
  const days = dayDiff(String(eventDate).slice(0, 10));
  if (days == null || days < 0) return 'info';
  if (days <= 7) return 'danger';
  if (days <= 14) return 'warn';
  return 'info';
}

const MAX_PREP_ITEMS = 4;

// Needs-you items for the two ball-in-your-court stages. Past events are
// excluded (a submitted plan for a finished event is history, not a queue).
export function buildPrepItems(plans) {
  if (!Array.isArray(plans)) return [];
  const upcomingOnly = plans.filter(p => {
    if (!p.event_date) return true; // undated plans stay actionable
    const days = dayDiff(String(p.event_date).slice(0, 10));
    return days == null || days >= 0;
  });

  const needsList = upcomingOnly.filter(p =>
    p.status === 'submitted'
    && p.shopping_list_status !== 'approved'
    && p.shopping_list_status !== 'pending_review');
  const needsReview = upcomingOnly.filter(p => p.shopping_list_status === 'pending_review');

  const items = [
    ...needsReview.map(p => ({
      id: `prep-review-${p.id}`, type: 'prep', priority: proximityPriority(p.event_date),
      title: `${p.client_name || 'Client'} shopping list needs review`,
      sub: p.event_date ? `event ${fmtDate(String(p.event_date).slice(0, 10))}` : 'no event date',
      meta: 'review', target: 'drink-plan', ref: p.id,
    })),
    ...needsList.map(p => ({
      id: `prep-list-${p.id}`, type: 'prep', priority: proximityPriority(p.event_date),
      title: `${p.client_name || 'Client'} finished the potion planner`,
      sub: p.event_date ? `waiting on shopping list · event ${fmtDate(String(p.event_date).slice(0, 10))}` : 'waiting on shopping list',
      meta: 'needs list', target: 'drink-plan', ref: p.id,
    })),
  ];

  const rank = { danger: 0, warn: 1, info: 2 };
  items.sort((a, b) => (rank[a.priority] ?? 3) - (rank[b.priority] ?? 3));

  if (items.length > MAX_PREP_ITEMS) {
    const overflow = items.length - MAX_PREP_ITEMS;
    return [
      ...items.slice(0, MAX_PREP_ITEMS),
      {
        id: 'prep-overflow', type: 'prep', priority: 'info',
        title: `${overflow} more ${overflow === 1 ? 'plan' : 'plans'} waiting on prep`,
        sub: 'Open the drink plans queue', meta: String(overflow),
        target: 'drink-plans-queue', ref: null,
      },
    ];
  }
  return items;
}
