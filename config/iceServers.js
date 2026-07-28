const logger = require('../utils/logger');

/**
 * Parses and returns the list of STUN and TURN ICE servers configured in environment variables.
 * Fallbacks to public Google STUN servers if nothing is specified.
 */
function getIceServers() {
  const iceServers = [];

  // Parse STUN servers
  const stunEnv = process.env.STUN_SERVERS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302';
  const stunUrls = stunEnv.split(',').map(url => url.trim()).filter(Boolean);
  
  if (stunUrls.length > 0) {
    iceServers.push({
      urls: stunUrls
    });
  }

  // Parse TURN servers (expected as a JSON array of RTCIceServer objects)
  const turnEnv = process.env.TURN_SERVERS;
  if (turnEnv) {
    try {
      const parsedTurn = JSON.parse(turnEnv);
      if (Array.isArray(parsedTurn)) {
        parsedTurn.forEach(server => {
          if (server.urls) {
            iceServers.push(server);
          }
        });
      }
    } catch (error) {
      logger.error(`Failed to parse TURN_SERVERS environment variable: ${error.message}`);
    }
  }

  // If we ended up with nothing, provide a solid default list of public STUN servers
  if (iceServers.length === 0) {
    iceServers.push(
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' }
    );
  }

  return iceServers;
}

module.exports = {
  getIceServers
};
