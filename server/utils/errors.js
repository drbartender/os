class AppError extends Error {
  constructor(message, statusCode, code, fieldErrors) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

class ValidationError extends AppError {
  constructor(fieldErrors, message = 'Please fix the errors below') {
    super(message, 400, 'VALIDATION_ERROR', fieldErrors);
  }
}

class ConflictError extends AppError {
  constructor(message, code = 'CONFLICT') {
    super(message, 409, code);
  }
}

class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(message, 404, 'NOT_FOUND');
  }
}

class PermissionError extends AppError {
  constructor(message = "You don't have permission to do this") {
    super(message, 403, 'PERMISSION_DENIED');
  }
}

class ExternalServiceError extends AppError {
  constructor(service, originalError, message = 'Service temporarily unavailable. Please try again.') {
    super(message, 502, 'EXTERNAL_SERVICE_ERROR');
    this.service = service;
    this.originalError = originalError;
  }
}

class PaymentError extends AppError {
  constructor(message, code = 'PAYMENT_ERROR') {
    super(message, 402, code);
  }
}

/**
 * Dispatcher contract: handlers throw this to mark their scheduled_messages row
 * as `status='suppressed'` with the given reason, without alerting Sentry or
 * routing through the global error middleware. NOT an AppError subclass on
 * purpose: this error is internal to the dispatcher and must never surface to
 * a client. Only handlers may throw it; lookup helpers must NOT, or the
 * dispatcher's discriminator would silently mask real failures.
 */
class SuppressMessageError extends Error {
  constructor(reason) {
    super(`message suppressed: ${reason}`);
    this.name = 'SuppressMessageError';
    this.reason = reason;
  }
}

/**
 * Transport-layer signal that the email provider (Resend) rejected a send
 * because the account's daily sending quota / rate limit is exhausted. Like
 * SuppressMessageError this is a plain Error subclass (NOT an AppError): it is a
 * transient, retryable internal condition that must never surface to a client.
 * The scheduled-message dispatcher catches it to DEFER the row (retry after the
 * quota resets) instead of marking it permanently 'failed' and dropping the
 * notification.
 */
class QuotaExceededError extends Error {
  constructor(message = 'email sending quota exceeded') {
    super(message);
    this.name = 'QuotaExceededError';
    this.retryable = true;
  }
}

module.exports = {
  AppError,
  ValidationError,
  ConflictError,
  NotFoundError,
  PermissionError,
  ExternalServiceError,
  PaymentError,
  SuppressMessageError,
  QuotaExceededError,
};
