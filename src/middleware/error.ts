import { Request, Response, NextFunction, RequestHandler } from 'express';
import { config } from '../config';

export class ApiError extends Error {
  public readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
    Error.captureStackTrace(this, ApiError);
  }
}

/** Wraps an async handler so rejected promises reach the error middleware. */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    status: 'error',
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
}

export function errorHandler(
  error: any,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  const statusCode = error instanceof ApiError ? error.statusCode : error.statusCode || 500;

  if (statusCode >= 500) console.error('[Error]', error);

  res.status(statusCode).json({
    status: 'error',
    message: error.message || 'Internal server error',
    ...(config.env === 'development' && statusCode >= 500 ? { stack: error.stack } : {}),
  });
}
