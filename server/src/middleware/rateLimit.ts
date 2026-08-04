import type { Request, Response, NextFunction } from 'express';

/**
 * A small in-memory sliding window, used to stop password guessing.
 *
 * In-memory is the right choice here rather than a shortcut: the app runs as a
 * single process against a single SQLite file, so there is no second instance
 * for a shared store to coordinate with. If that ever changes, this is the
 * piece to replace.
 */

interface Window { hits: number[] }
const buckets = new Map<string, Window>();

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

// Keep the map from growing without bound on a long-running server.
setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [key, w] of buckets) {
    w.hits = w.hits.filter((t) => t > cutoff);
    if (w.hits.length === 0) buckets.delete(key);
  }
}, WINDOW_MS).unref?.();

/**
 * Limit by IP *and* submitted email together: one office behind a single NAT
 * address must not lock itself out because a colleague mistyped a password.
 */
export function loginRateLimit(req: Request, res: Response, next: NextFunction) {
  const email = String((req.body ?? {}).email ?? '').toLowerCase();
  const key = `${req.ip ?? 'unknown'}|${email}`;
  const now = Date.now();
  const bucket = buckets.get(key) ?? { hits: [] };

  bucket.hits = bucket.hits.filter((t) => t > now - WINDOW_MS);
  if (bucket.hits.length >= MAX_ATTEMPTS) {
    const retryMs = bucket.hits[0] + WINDOW_MS - now;
    buckets.set(key, bucket);
    res.setHeader('Retry-After', String(Math.ceil(retryMs / 1000)));
    return res.status(429).json({
      error: `Too many sign-in attempts. Try again in ${Math.ceil(retryMs / 60000)} minute(s).`,
    });
  }

  bucket.hits.push(now);
  buckets.set(key, bucket);

  // A successful sign-in clears the count, so normal use never accumulates.
  const done = res.end.bind(res);
  res.end = ((...args: Parameters<typeof done>) => {
    if (res.statusCode < 400) buckets.delete(key);
    return done(...args);
  }) as typeof res.end;

  next();
}
