import axios from 'axios';

export const API_BASE_URL = process.env.REACT_APP_API_URL
  ? `${process.env.REACT_APP_API_URL}/api`
  : '/api';

const api = axios.create({
  baseURL: API_BASE_URL
});

let onUnauthorized = null;
api.setOnUnauthorized = (fn) => { onUnauthorized = fn; };

api.interceptors.request.use(config => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  res => res,
  err => {
    if (err.response?.status === 401) {
      localStorage.removeItem('token');
      if (onUnauthorized) onUnauthorized('/login');
      else window.location.href = '/login';
    }
    return Promise.reject(err);
  }
);

export default api;
