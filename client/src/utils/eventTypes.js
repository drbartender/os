// Resolves an event type id to a human label.
// Mirrors server/utils/eventTypes.js — keep both files in sync when adding types.

import EVENT_TYPES from '../data/eventTypes';

export { default as EVENT_TYPES } from '../data/eventTypes';

export function getEventTypeLabel(arg) {
  const { event_type, event_type_custom } = arg || {};
  if (event_type_custom) return event_type_custom;
  if (event_type === 'other' || event_type === 'Other') return 'event';
  const found = EVENT_TYPES.find(t => t.id === event_type || t.label === event_type);
  return found ? found.label : 'event';
}
