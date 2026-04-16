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

module.exports = {
  AppError,
  ValidationError,
  ConflictError,
  NotFoundError,
  PermissionError,
  ExternalServiceError,
};
