export type ErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "VALIDATION_ERROR"
  | "RATE_LIMITED"
  | "INTERNAL";

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly statusCode: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function badRequest(message: string, details?: unknown): AppError {
  return new AppError("BAD_REQUEST", message, 400, details);
}

export function unauthorized(message = "Unauthorized"): AppError {
  return new AppError("UNAUTHORIZED", message, 401);
}

export function forbidden(message = "Forbidden"): AppError {
  return new AppError("FORBIDDEN", message, 403);
}

export function notFound(message = "Not found"): AppError {
  return new AppError("NOT_FOUND", message, 404);
}

export function conflict(message: string, details?: unknown): AppError {
  return new AppError("CONFLICT", message, 409, details);
}

export function validationError(message: string, details?: unknown): AppError {
  return new AppError("VALIDATION_ERROR", message, 422, details);
}

export type ErrorEnvelope = {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
};

export function toErrorEnvelope(error: AppError): ErrorEnvelope {
  return {
    error: {
      code: error.code,
      message: error.message,
      details: error.details,
    },
  };
}
