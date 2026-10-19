export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: unknown[] = [],
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string, details: unknown[] = []) => new AppError(400, code, message, details);
export const unauthorized = (message = 'Missing or invalid credentials') => new AppError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'Insufficient permissions') => new AppError(403, 'FORBIDDEN', message);
export const notFound = (message = 'Landing page not found') => new AppError(404, 'LANDING_PAGE_NOT_FOUND', message);
export const conflict = (code: string, message: string) => new AppError(409, code, message);
export const preconditionFailed = (message = 'The resource was modified; reload and retry') =>
  new AppError(412, 'PRECONDITION_FAILED', message);
export const unprocessable = (code: string, message: string, details: unknown[] = []) => new AppError(422, code, message, details);
export const unavailable = (code: string, message: string) => new AppError(503, code, message);
