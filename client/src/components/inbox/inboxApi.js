import api from '../../utils/api';

// Every Inbox call, through utils/api.js (spec section 10), against lane
// inbox-engine's routes (spec section 8). Person keys are URL-safe by their
// pattern; encodeURIComponent is belt and braces.
const enc = (key) => encodeURIComponent(String(key));

export const getInbox = () => api.get('/admin/inbox');

// A 404 RESOLVES here instead of rejecting: its body carries the moved_to
// hint (INBOX_MOVED), and utils/api.js keeps only message, code and status
// when it rejects.
export const getItem = (key) => api.get(`/admin/inbox/${enc(key)}`, {
  validateStatus: (s) => (s >= 200 && s < 300) || s === 404,
});

export const postSeen = (key) => api.post(`/admin/inbox/${enc(key)}/seen`);

export const postAction = (key, action, until) => api.post(
  `/admin/inbox/${enc(key)}/actions`,
  until ? { action, until } : { action }
);

export const undoAction = (id) => api.delete(`/admin/inbox/actions/${enc(id)}`);

export const sendText = (key, { body, line, sendId }) => api.post(
  `/admin/inbox/${enc(key)}/text`,
  { body, line, send_id: sendId }
);
