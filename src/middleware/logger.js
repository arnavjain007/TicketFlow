/**
 * Request logging middleware.
 *
 * Logs every incoming HTTP request with timestamp, method, and URL.
 * Lightweight — no external dependency (morgan, etc.) needed.
 */

function requestLogger(req, res, next) {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
}

module.exports = requestLogger;
