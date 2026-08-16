export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static badRequest(message: string, details?: unknown) {
    return new ApiError(400, 'bad_request', message, details);
  }

  static unauthorized(message = 'Authentication required') {
    return new ApiError(401, 'unauthorized', message);
  }

  static forbidden(message = 'You do not have access to this resource') {
    return new ApiError(403, 'forbidden', message);
  }

  static notFound(message = 'Not found') {
    return new ApiError(404, 'not_found', message);
  }

  static conflict(message: string) {
    return new ApiError(409, 'conflict', message);
  }

  static gone(message: string) {
    return new ApiError(410, 'gone', message);
  }

  static tooManyRequests(message = 'Too many requests') {
    return new ApiError(429, 'too_many_requests', message);
  }

  static internal(message = 'Internal server error') {
    return new ApiError(500, 'internal_error', message);
  }

  static unavailable(message: string) {
    return new ApiError(503, 'service_unavailable', message);
  }
}
