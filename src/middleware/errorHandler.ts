import { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';
import { HttpError, logger } from '../utils';

interface ErrorBody {
  success: boolean;
  status: number;
  message: string;
  name: string;
  errors?: unknown;
}

const routerNotFound: RequestHandler = (_, _res, _next) => {
  throw new HttpError(404, 'Route not found');
};

const errorHandler = (err: Error, req: Request, res: Response<ErrorBody>, _: NextFunction) => {
  const loggerMsg = 'ErrorHandler';

  if (err instanceof HttpError) {
    logger.warn(err, loggerMsg);
    res.status(err.status).send({
      success: false,
      status: err.status,
      message: err.message,
      name: err.name,
    });
    return;
  } else if (err instanceof ZodError) {
    logger.warn(err, loggerMsg);
    res.status(400).send({
      success: false,
      status: 400,
      message: 'Invalid request',
      name: 'ZodError',
      errors: err.flatten(),
    });
    return;
  }

  logger.error(err, loggerMsg);
  res.status(500).send({
    success: false,
    status: 500,
    message: 'Something went wrong',
    name: 'InternalServerError',
  });
};

export const errorHandlerMiddleware = [routerNotFound, errorHandler];
