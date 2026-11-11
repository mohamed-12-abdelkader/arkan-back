import { RequestHandler } from 'express';

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

/** Periodic cleanup so long-running processes don't retain stale keys forever. */
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, 60_000).unref?.();

export function rateLimit(options: {
  windowMs: number;
  max: number;
  key?: (req: Parameters<RequestHandler>[0]) => string;
  message?: string;
}): RequestHandler {
  return (req, res, next) => {
    const key = options.key?.(req) ?? `${req.ip}:${req.path}`;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + options.windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    const remaining = Math.max(0, options.max - bucket.count);
    const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    res.setHeader('X-RateLimit-Limit', String(options.max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));
    if (bucket.count > options.max) {
      res.setHeader('Retry-After', String(retryAfterSec));
      return res.status(429).json({
        success: false,
        message:
          options.message ||
          'Too many requests. Please try again later.',
        retry_after: retryAfterSec,
      });
    }
    next();
  };
}
