import { RequestHandler } from 'express';
import { ZodSchema } from 'zod';

type Source = 'body' | 'query' | 'params';

export function validate(schema?: ZodSchema, source: Source = 'body'): RequestHandler {
  return async (req, res, next) => {
    if (!schema) return next();

    const result = schema.safeParse(req[source]);
    if (!result.success) {
      res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: result.error.flatten(),
      });
      return;
    }

    if (source === 'body') req.body = result.data;
    else if (source === 'query') (req as any).validatedQuery = result.data;
    else (req as any).validatedParams = result.data;
    next();
  };
}
