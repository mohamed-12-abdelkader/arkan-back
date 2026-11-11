import { Response } from 'express';

export function ok<T>(res: Response, data: T, status = 200) {
  return res.status(status).json({ success: true, data });
}

export function created<T>(res: Response, data: T) {
  return ok(res, data, 201);
}

export function paginated<T>(
  res: Response,
  data: T[],
  meta: { total: number; page: number; limit: number },
) {
  return res.status(200).json({
    success: true,
    data,
    meta: {
      ...meta,
      totalPages: Math.ceil(meta.total / meta.limit) || 0,
    },
  });
}

export function fail(res: Response, status: number, message: string, errors?: unknown) {
  return res.status(status).json({
    success: false,
    message,
    ...(errors !== undefined ? { errors } : {}),
  });
}
