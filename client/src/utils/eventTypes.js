// Resolves an event type id to a human label.
// Mirrors server/utils/eventTypes.js — keep both files in sync when adding types.

import EVENT_TYPES from '../data/eventTypes';

export { default as EVENT_TYPES } from '../data/eventTypes';

export function getEventTypeLabel({ event_type, event_type_custom } = {}) {
  if (event_type === 'other') return event_type_custom || 'event';
  const found = EVENT_TYPES.find(t => t.id === event_type);
  return found ? found.label : 'event';
}
