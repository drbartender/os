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

api.interceptors.response.use(
  (res) => res,
  (err) => {
    // Network failure — no response received
    if (!err.response) {
      const payload = {
        message: 'Network error — check your connection.',
        code: 'NETWORK_ERROR',
        fieldErrors: undefined,
        status: 0,
        // Backward-compat shim so existing `err.response?.data?.error` callers
        // still surface a usable message. Remove after Phase 3 sweep converts
        // callers to read `err.message` directly.
        response: { data: { error: 'Network error — check your connection.' }, status: 0 },
      };
      return Promise.reject(payload);
    }

    const { status } = err.response;
    const config = err.config;
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
      // Backward-compat shim — see comment above.
      response: { data, status },
    });
  }
);

export default api;
