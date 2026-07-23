const logger = require('../utils/logger');

/**
 * Socket.IO authentication middleware.
 * Verifies that the connecting client provides a valid userId.
 * Optionally verifies a JWT token if JWT_SECRET is configured.
 */
function socketAuthMiddleware(socket, next) {
  // Extract credentials from handshake auth or query params
  const userId = socket.handshake.auth?.userId || socket.handshake.query?.userId;
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  const fullName = socket.handshake.auth?.fullName || socket.handshake.query?.fullName || 'Anonymous';

  if (!userId) {
    logger.warn(`Connection rejected: No userId provided in handshake.`);
    return next(new Error('Authentication error: userId is required'));
  }

  // Attach extracted user data to the socket object
  socket.userId = userId;
  socket.fullName = fullName;

  const jwtSecret = process.env.JWT_SECRET;

  // Optional: JWT Token Validation
  if (jwtSecret && jwtSecret !== 'your_super_secret_jwt_key_here' && token) {
    const jwt = require('jsonwebtoken');
    try {
      const decoded = jwt.verify(token, jwtSecret);
      // Double check that the decoded token matches the claimed userId
      if (decoded.sub && decoded.sub !== userId) {
        logger.warn(`Token subject mismatch for userId ${userId}. Connection rejected.`);
        return next(new Error('Authentication error: Token mismatch'));
      }
      logger.info(`User ${userId} (${fullName}) authenticated successfully via JWT.`);
    } catch (err) {
      logger.warn(`Invalid JWT token provided for userId ${userId}: ${err.message}. Connection rejected.`);
      return next(new Error('Authentication error: Invalid Token'));
    }
  } else {
    logger.info(`User ${userId} (${fullName}) connected using direct ID authentication.`);
  }

  return next();
}

module.exports = {
  socketAuthMiddleware
};
