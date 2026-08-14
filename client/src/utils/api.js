import axios from 'axios';

export const API_BASE_URL = process.env.REACT_APP_API_URL
  ? `${process.env.REACT_APP_API_URL}/api`
  : '/api';

const api = axios.create({
  baseURL: API_BASE_URL
});

api.interceptors.request.use(config => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Offline reads (spec section 7): admin-sw.js stamps cache-served responses
// with x-sw-cached-at. Surface it as response.staleAt so screens can render
// "as of <time>" instead of presenting stale data as live.
export function markStaleFromHeaders(response) {
  const t = response && response.headers
    ? response.headers['x-sw-cached-at']
    : null;
  if (t) response.staleAt = t;
  return response;
}

api.interceptors.response.use(
  (res) => markStaleFromHeaders(res),
  (err) => {
    // Network failure — no response received
    // eslint-disable-next-line no-restricted-syntax
    if (!err.response) {
      return Promise.reject({
        message: 'Network error. Check your connection.',
        code: 'NETWORK_ERROR',
        fieldErrors: undefined,
        status: 0,
      });
    }

    // eslint-disable-next-line no-restricted-syntax
    const { status } = err.response;
    const config = err.config;
    // eslint-disable-next-line no-restricted-syntax
    const data = err.response.data || {};
    const url = config?.url || '';

    // Session expired (any 401 outside the auth/login endpoints)
    if (status === 401 && !url.startsWith('/auth/') && !url.startsWith('/client-auth/')) {
      // Tag the URL so SessionExpiryHandler picks the right login redirect
      window.dispatchEvent(new CustomEvent('session-expired', { detail: { url } }));
    }

    const message = data.error || 'Something went wrong. Please try again.';
    return Promise.reject({
      message,
      code: data.code,
      fieldErrors: data.fieldErrors,
      status,
    });
  }
);

export default api;
