// Centralized API client for cloud mode.
// Adds the Authorization: Bearer header from the stored session token, and turns
// a 402 (quota exceeded) into a typed QuotaError the UI can catch to prompt a top-up.
import { getApiUrl } from '../config';

export const AUTH_TOKEN_KEY = 'sahu-shorts_auth';

export const getToken = () => localStorage.getItem(AUTH_TOKEN_KEY) || '';
export const setToken = (t) => localStorage.setItem(AUTH_TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(AUTH_TOKEN_KEY);

export class QuotaError extends Error {
  constructor(detail) {
    super('quota_exceeded');
    this.name = 'QuotaError';
    this.minutesRequired = detail?.minutes_required;
    this.minutesRemaining = detail?.minutes_remaining;
    // Minutes of the source the server offers to clip instead (0 = no offer).
    this.partialMinutes = Number(detail?.partial_minutes) || 0;
    // The server's reason: 'quota_exceeded', 'no_plan', or 'free_queue_full'
    // (the free queue's brake refused the submission; nothing was spent).
    this.code = detail?.error || 'quota_exceeded';
  }
}

// A 402 caught outside the main clip flow (thumbnails, clip editor, autopilot):
// ask the app shell to open the quota wall instead of a dead-end error. `source`
// tags CheckoutStarted so each surface can be measured.
export const QUOTA_WALL_EVENT = 'os:quota-wall';
export function openQuotaWall(err, source) {
  try {
    window.dispatchEvent(new CustomEvent(QUOTA_WALL_EVENT, {
      detail: { required: err?.minutesRequired, remaining: err?.minutesRemaining, source },
    }));
  } catch (_) { /* ignore */ }
}

// --- Backend auto-wake -----------------------------------------------------
// The backend lives on a GitHub Codespace that stops after ~30 min idle.
// When a request fails because the backend is unreachable, this wakes it
// (via the /api/wake serverless function on the same origin) and polls
// /health until it answers, then the original request is retried once.
// Nothing here changes the normal path: a reachable backend never sees a
// wake call. Concurrent callers share one wake attempt.
export const BACKEND_WAKING_EVENT = 'os:backend-waking';
const WAKE_POLL_MS = 15000;
const WAKE_TIMEOUT_MS = 4 * 60 * 1000;

function setWaking(on) {
  try {
    window.dispatchEvent(new CustomEvent(BACKEND_WAKING_EVENT, {
      detail: { waking: !!on },
    }));
  } catch (_) { /* ignore */ }
}

async function backendHealthy() {
  try {
    const res = await fetch(getApiUrl('/health'), { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return false;
    const body = await res.json().catch(() => ({}));
    return body?.status === 'ok';
  } catch (_) {
    return false;
  }
}

async function wakeAndWait() {
  setWaking(true);
  try {
    // Ask the wake endpoint to start the Codespace (a no-op when it is
    // already up or starting). Any failure here is non-fatal: the poll
    // below still waits, because the backend may be starting on its own
    // (e.g. someone started the Codespace by hand).
    try {
      await fetch('/api/wake', { method: 'POST', signal: AbortSignal.timeout(10000) });
    } catch (_) { /* wake unavailable — keep polling */ }
    const started = Date.now();
    while (Date.now() - started < WAKE_TIMEOUT_MS) {
      if (await backendHealthy()) return true;
      await new Promise((r) => setTimeout(r, WAKE_POLL_MS));
    }
    return await backendHealthy();
  } finally {
    setWaking(false);
  }
}

let wakePromise = null;
function wakeOnce() {
  if (!wakePromise) wakePromise = wakeAndWait().finally(() => { wakePromise = null; });
  return wakePromise;
}

// Drop-in fetch wrapper. Always attaches the bearer token when present.
export async function apiFetch(path, options = {}) {
  const headers = new Headers(options.headers || {});
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);

  let res;
  try {
    res = await fetch(getApiUrl(path), { ...options, headers });
  } catch (e) {
    // Network failure (the backend is unreachable, usually because the
    // Codespace stopped): wake it once, then retry the request once.
    if (e instanceof TypeError) {
      const up = await wakeOnce();
      if (up) return fetch(getApiUrl(path), { ...options, headers });
    }
    throw e;
  }

  if (res.status === 402) {
    let detail = {};
    try {
      const body = await res.clone().json();
      detail = body.detail || body;
    } catch (_) { /* ignore */ }
    throw new QuotaError(detail);
  }
  return res;
}

// A failed request, carrying the server's own explanation. Callers that show an
// alert should prefer `detail` — the generic "something went wrong" strings hid
// real, actionable messages (e.g. a declined card blocking checkout).
export class ApiError extends Error {
  constructor(status, detail, raw) {
    super(`${status}: ${raw}`);   // message kept verbatim for existing callers
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

// Convenience JSON helper.
export async function apiJson(path, options = {}) {
  const res = await apiFetch(path, options);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let detail = '';
    try {
      const d = JSON.parse(text).detail;
      // FastAPI details are strings here, but validation errors arrive as objects.
      if (typeof d === 'string') detail = d;
    } catch (_) { /* not JSON — leave detail empty and fall back to the caller's copy */ }
    throw new ApiError(res.status, detail, text);
  }
  return res.json();
}

