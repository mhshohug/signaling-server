const logger = require('../utils/logger');

/**
 * Parses and returns the list of STUN and TURN ICE servers configured in environment variables.
 * Fallbacks to public Google STUN servers if nothing is specified.
 */
function getIceServers() {
  const iceServers = [];

  // Parse STUN servers
  const stunEnv = process.env.STUN_SERVERS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302,stun:stun2.l.google.com:19302,stun:stun3.l.google.com:19302,stun:stun4.l.google.com:19302,stun:stun.cloudflare.com:3478,stun:stun.services.mozilla.com:3478';
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

  // Always include reliable fallback TURN servers for cross-network (different Wi-Fi / NAT) relay
  iceServers.push(
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:80?transport=udp',
        'turn:openrelay.metered.ca:80?transport=tcp',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=udp',
        'turn:openrelay.metered.ca:443?transport=tcp',
        'turns:openrelay.metered.ca:443',
        'turns:openrelay.metered.ca:443?transport=tcp'
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  );

  return iceServers;
}

module.exports = {
  getIceServers
};
