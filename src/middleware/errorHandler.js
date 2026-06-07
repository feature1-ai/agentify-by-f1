import logger from '../utils/logger.js';
import config from '../config/index.js';

export const errorHandler = (err, req, res, next) => {
  logger.error('Error occurred:', {
    error: err.message,
    stack: config.isDevelopment ? err.stack : undefined,
    path: req.path,
    method: req.method,
    body: req.body,
    query: req.query,
    headers: req.headers
  });

  if (err.name === 'ValidationError') {
    return res.status(400).json({
      success: false,
      error: 'Validation Error',
      details: err.details || err.message
    });
  }

  if (err.name === 'UnauthorizedError') {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized',
      message: 'Invalid or missing authentication'
    });
  }

  if (err.code === 'unsupported-workflow') {
    return res.status(400).json({
      success: false,
      error: 'Unsupported workflow',
      code: 'unsupported-workflow',
      message: 'Unsupported workflow',
      ...(err.workflowId && { workflowId: err.workflowId })
    });
  }

  if (err.name === 'WorkflowError') {
    return res.status(422).json({
      success: false,
      error: 'Workflow Execution Error',
      message: err.message,
      workflowId: err.workflowId
    });
  }

  if (err.code === 'ECONNREFUSED') {
    return res.status(503).json({
      success: false,
      error: 'Service Unavailable',
      message: 'Unable to connect to required service'
    });
  }

  const statusCode = err.statusCode || err.status || 500;
  const message = config.isProduction 
    ? 'An error occurred processing your request'
    : err.message;

  res.status(statusCode).json({
    success: false,
    error: statusCode === 500 ? 'Internal Server Error' : 'Error',
    message,
    ...(config.isDevelopment && { stack: err.stack })
  });
};

export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

export const notFoundHandler = (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Not Found',
    message: `Route ${req.method} ${req.path} not found`
  });
};

export class WorkflowError extends Error {
  constructor(message, workflowId, statusCode = 422) {
    super(message);
    this.name = 'WorkflowError';
    this.workflowId = workflowId;
    this.statusCode = statusCode;
  }
}

export class ValidationError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'ValidationError';
    this.details = details;
  }
}

export default {
  errorHandler,
  asyncHandler,
  notFoundHandler,
  WorkflowError,
  ValidationError
};
