import logger from './logger.js';

/**
 * Wraps an async route handler so rejections flow to the error middleware
 * instead of each route needing its own try/catch.
 */
export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

export const notFoundHandler = (req, res) => {
  res.status(404).json({
    success: false,
    error: `Route ${req.method} ${req.path} not found`
  });
};

// eslint-disable-next-line no-unused-vars -- Express identifies error middleware by arity
export const errorHandler = (err, req, res, next) => {
  logger.error('Unhandled error:', {
    error: err.message || err.error,
    path: req.path,
    method: req.method
  });

  const statusCode = err.statusCode || err.status || 500;
  // CodexExecutor rejects with plain {error} objects rather than Error instances
  const message = err.message || err.error || 'Internal server error';

  res.status(statusCode).json({
    success: false,
    error: process.env.NODE_ENV === 'production' && statusCode === 500
      ? 'Internal server error'
      : message
  });
};
