const admin = require('firebase-admin');
const logger = require('../utils/logger');

// In-memory token store: userId -> Set of active FCM tokens
const userTokens = new Map();

/**
 * Initializes the Firebase Admin SDK using credentials from environment variables.
 */
function initFirebase() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) {
    logger.warn('Firebase Admin credentials are not fully configured in environment variables.');
    logger.warn('FCM notifications will be disabled or fail until configured.');
    return false;
  }

  try {
    // Format the private key to handle newline characters properly
    if (privateKey.startsWith('"') && privateKey.endsWith('"')) {
      privateKey = privateKey.substring(1, privateKey.length - 1);
    }
    privateKey = privateKey.replace(/\\n/g, '\n');

    admin.initializeApp({
      credential: admin.credential.cert({
        projectId,
        clientEmail,
        privateKey,
      }),
    });

    logger.info('Firebase Admin SDK initialized successfully.');
    return true;
  } catch (error) {
    logger.error(`Failed to initialize Firebase Admin SDK: ${error.message}`);
    return false;
  }
}

/**
 * Registers an FCM device token for a user.
 */
function registerFcmToken(userId, token) {
  if (!userId || !token) return;
  if (!userTokens.has(userId)) {
    userTokens.set(userId, new Set());
  }
  userTokens.get(userId).add(token);
  logger.info(`FCM Token registered for user ${userId}. Total tokens: ${userTokens.get(userId).size}`);
}

/**
 * Removes an FCM device token for a user.
 */
function removeFcmToken(userId, token) {
  if (!userId || !token) return;
  if (userTokens.has(userId)) {
    const tokens = userTokens.get(userId);
    tokens.delete(token);
    if (tokens.size === 0) {
      userTokens.delete(userId);
    }
    logger.info(`FCM Token removed for user ${userId}.`);
  }
}

/**
 * Utility function to send FCM payload to all registered tokens of a user.
 * Automatically cleans up invalid or unregistered tokens.
 */
async function sendNotificationToUser(userId, payload) {
  const tokens = userTokens.get(userId);
  if (!tokens || tokens.size === 0) {
    logger.warn(`No registered FCM tokens found for user ${userId}. Notification not sent.`);
    return;
  }

  const tokenList = Array.from(tokens);
  logger.info(`Sending FCM notification to user ${userId} on ${tokenList.length} device(s)...`);

  const messages = tokenList.map(token => ({
    token,
    ...payload
  }));

  try {
    // Send messages using Firebase Admin SDK
    const response = await admin.messaging().sendEach(messages);
    
    // Clean up failed tokens
    response.responses.forEach((res, index) => {
      if (!res.success) {
        const failedToken = tokenList[index];
        const error = res.error;
        logger.warn(`FCM send failed for token ${failedToken}: ${error.message}`);
        
        // Remove token if it is no longer registered or is invalid
        if (
          error.code === 'messaging/registration-token-not-registered' ||
          error.code === 'messaging/invalid-argument'
        ) {
          logger.info(`Pruning invalid token for user ${userId}: ${failedToken}`);
          removeFcmToken(userId, failedToken);
        }
      }
    });
  } catch (err) {
    logger.error(`Error sending bulk FCM notification for user ${userId}: ${err.message}`);
  }
}

/**
 * Sends an incoming call notification to a user's devices.
 */
async function sendIncomingCallNotification(callerId, callerName, callerPhoto, isVideo, callId, receiverId) {
  const callType = isVideo ? 'video' : 'audio';
  const timestamp = Date.now().toString();

  const payload = {
    notification: {
      title: isVideo ? 'Incoming Video Call' : 'Incoming Audio Call',
      body: `${callerName} is calling you...`,
    },
    data: {
      type: 'incoming_call',
      callerId,
      callerName: callerName || 'Unknown Caller',
      callerPhoto: callerPhoto || '',
      callType,
      callId: callId || '',
      timestamp,
    },
    android: {
      priority: 'high',
      notification: {
        sound: 'default',
        clickAction: 'FLUTTER_NOTIFICATION_CLICK', // standard click action for handling notifications
      },
    }
  };

  await sendNotificationToUser(receiverId, payload);
}

/**
 * Sends a call cancelled notification to a user's devices.
 */
async function sendCallCancelledNotification(callerId, callerName, receiverId, callId) {
  const payload = {
    data: {
      type: 'call_cancelled',
      callerId,
      callerName: callerName || 'Unknown',
      callId: callId || '',
      timestamp: Date.now().toString(),
    },
    android: {
      priority: 'high',
    }
  };

  await sendNotificationToUser(receiverId, payload);
}

/**
 * Sends a missed call notification to a user's devices.
 */
async function sendMissedCallNotification(callerId, callerName, receiverId, callId, isVideo) {
  const payload = {
    notification: {
      title: 'Missed Call',
      body: `You missed a ${isVideo ? 'video' : 'audio'} call from ${callerName}`,
    },
    data: {
      type: 'missed_call',
      callerId,
      callerName: callerName || 'Unknown',
      callId: callId || '',
      timestamp: Date.now().toString(),
    },
    android: {
      priority: 'high',
      notification: {
        sound: 'default',
      },
    }
  };

  await sendNotificationToUser(receiverId, payload);
}

/**
 * Sends a chat message notification to a user's devices.
 */
async function sendMessageNotification(senderId, senderName, receiverId, messageType, messageText, conversationId) {
  let bodyText = '';

  switch (messageType?.toLowerCase()) {
    case 'image':
      bodyText = '📷 Photo';
      break;
    case 'video':
      bodyText = '🎥 Video';
      break;
    case 'voice':
      bodyText = '🎤 Voice Message';
      break;
    case 'file':
      bodyText = '📎 File';
      break;
    case 'text':
    default:
      bodyText = messageText || '';
      break;
  }

  const payload = {
    notification: {
      title: senderName || 'New Message',
      body: bodyText,
    },
    data: {
      type: 'new_message',
      senderId,
      senderName: senderName || 'Unknown',
      messageType: messageType || 'text',
      messageText: messageText || '',
      conversationId: conversationId || '',
      timestamp: Date.now().toString(),
    },
    android: {
      priority: 'high',
      notification: {
        sound: 'default',
      },
    }
  };

  await sendNotificationToUser(receiverId, payload);
}

module.exports = {
  initFirebase,
  registerFcmToken,
  removeFcmToken,
  sendIncomingCallNotification,
  sendCallCancelledNotification,
  sendMissedCallNotification,
  sendMessageNotification,
  userTokens
};
