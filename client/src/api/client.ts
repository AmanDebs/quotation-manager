export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Called when a request comes back 401 with a session that was supposed to be
 * good — so the app can return to the login screen instead of leaving every
 * query on the page quietly failing.
 *
 * Not every 401 is an expired session. Three of them are the honest answer to
 * the question asked: a wrong email or password, a registration refused, and a
 * wrong *current* password on the change-password form. Signing someone out
 * because they mistyped their old password would be a worse bug than the one
 * this fixes, so those three paths are excluded by URL.
 */
type UnauthorizedHandler = () => void;
let unauthorizedHandler: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(fn: UnauthorizedHandler | null) {
  unauthorizedHandler = fn;
}

const EXPECTS_401 = ['/api/auth/login', '/api/auth/register', '/api/auth/change-password'];

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch { /* non-JSON error body */ }
    if (res.status === 401 && !EXPECTS_401.some((p) => url.startsWith(p))) {
      unauthorizedHandler?.();
    }
    throw new ApiError(res.status, message);
  }
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body),
  put: <T>(url: string, body?: unknown) => request<T>('PUT', url, body),
  patch: <T>(url: string, body?: unknown) => request<T>('PATCH', url, body),
  del: <T>(url: string) => request<T>('DELETE', url),
};
