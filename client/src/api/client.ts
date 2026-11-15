export class ApiError extends Error {
  status: number;
  /**
   * The refusal's own body, where it had one.
   *
   * Most refusals are a sentence and nothing else, and the sentence is what a
   * form prints. A few carry what they did **before** refusing — `/certify`
   * answers 409 over a lot it has just opened and inspected, because the
   * inspection really happened and the certificate is what could not be
   * issued — and a caller that could only see the message would report that
   * as a save which failed. Parsed once here rather than re-read per caller.
   */
  data?: Record<string, unknown>;
  constructor(status: number, message: string, data?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.data = data;
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
    let body: Record<string, unknown> | undefined;
    try {
      const data = await res.json();
      if (data && typeof data === 'object') body = data as Record<string, unknown>;
      if (data?.error) message = data.error;
    } catch { /* non-JSON error body */ }
    if (res.status === 401 && !EXPECTS_401.some((p) => url.startsWith(p))) {
      unauthorizedHandler?.();
    }
    throw new ApiError(res.status, message, body);
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
