import axios from 'axios';

// In production (AWS), REACT_APP_INTERNAL_ALB_URL is the internal ALB DNS
// The nginx proxy forwards /api/* directly to the internal ALB.
// In local development, each service runs on its own port.

const INTERNAL_ALB = process.env.REACT_APP_INTERNAL_ALB_URL || '';

// If INTERNAL_ALB is set, all traffic goes through it (nginx proxies /api/*)
// Otherwise fall back to individual service URLs for local dev
const AUTH_URL = INTERNAL_ALB
  ? `${INTERNAL_ALB}/api/auth`
  : (process.env.REACT_APP_AUTH_SERVICE_URL || '/api/auth');

const PRODUCT_URL = INTERNAL_ALB
  ? `${INTERNAL_ALB}/api/products/`
  : (process.env.REACT_APP_PRODUCT_SERVICE_URL || '/api/products/');

const ORDER_URL = INTERNAL_ALB
  ? `${INTERNAL_ALB}/api/orders/`
  : (process.env.REACT_APP_ORDER_SERVICE_URL || '/api/orders/');

const ANALYTICS_URL = INTERNAL_ALB
  ? `${INTERNAL_ALB}/api/analytics`
  : (process.env.REACT_APP_ANALYTICS_SERVICE_URL || '/api/analytics');

const AI_ASSISTANT_URL = INTERNAL_ALB
  ? `${INTERNAL_ALB}/api/assistant`
  : (process.env.REACT_APP_AI_ASSISTANT_URL || '/api/assistant');

// Helper: get auth headers
const authHeader = () => {
  const token = localStorage.getItem('token');
  return token ? { Authorization: `Bearer ${token}` } : {};
};

// ─── Auth API ─────────────────────────────────────────────────────────────
export const authAPI = {
  register: (data) => axios.post(`${AUTH_URL}/register`, data),
  login: (data) => axios.post(`${AUTH_URL}/login`, data),
  getMe: () => axios.get(`${AUTH_URL}/me`, { headers: authHeader() }),
};

// ─── Product API ──────────────────────────────────────────────────────────
export const productAPI = {
  getAll: (params = {}) => axios.get(`${PRODUCT_URL}`, { params }),
  getById: (id) => axios.get(`${PRODUCT_URL}/${id}`),
  create: (data) => axios.post(`${PRODUCT_URL}`, data, { headers: authHeader() }),
  update: (id, data) => axios.put(`${PRODUCT_URL}/${id}`, data, { headers: authHeader() }),
  delete: (id) => axios.delete(`${PRODUCT_URL}/${id}`, { headers: authHeader() }),
  getUploadUrl: (id, contentType) =>
    axios.post(`${PRODUCT_URL}/${id}/upload-url`, { contentType }, { headers: authHeader() }),
};

// ─── Order API ────────────────────────────────────────────────────────────
export const orderAPI = {
  create: (data) => axios.post(`${ORDER_URL}`, data, { headers: authHeader() }),
  getMyOrders: () => axios.get(`${ORDER_URL}`, { headers: authHeader() }),
  getById: (id) => axios.get(`${ORDER_URL}/${id}`, { headers: authHeader() }),
  updateStatus: (id, status) =>
    axios.patch(`${ORDER_URL}/${id}/status`, { status }, { headers: authHeader() }),
};

// ─── Analytics API (admin only) ───────────────────────────────────────────
export const analyticsAPI = {
  getInventoryForecast: () =>
    axios.get(`${ANALYTICS_URL}/inventory-forecast`, { headers: authHeader() }),
  getDemographics: () =>
    axios.get(`${ANALYTICS_URL}/demographics`, { headers: authHeader() }),
};

// ─── AI Assistant API ─────────────────────────────────────────────────────
export const assistantAPI = {
  chat: (data) => axios.post(`${AI_ASSISTANT_URL}/chat`, data, { headers: authHeader() }),
};
