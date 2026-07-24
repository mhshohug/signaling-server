const admin = require('firebase-admin');
const logger = require('../utils/logger');
const supabase = require('./supabase');

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
 * Registers an FCM device token for a user in Supabase device_tokens table.
 */
async function registerFcmToken(userId, token, deviceName = 'Unknown Device', platform = 'android') {
  if (!userId || !token) return;
  try {
    logger.info(`Saving FCM token to Supabase for user ${userId}`);
    const { error } = await supabase
      .from('device_tokens')
      .upsert(
        {
          user_id: userId,
          fcm_token: token,
          device_name: deviceName,
          platform: platform,
          updated_at: new Date().toISOString()
        },
        { onConflict: 'user_id,fcm_token' }
      );
logger.info(`Supabase response: ${JSON.stringify(error)}`);
    if (error) {
      logger.warn(`Upsert device_tokens failed: ${error.message}. Attempting delete-insert fallback.`);
      await supabase
        .from('device_tokens')
        .delete()
        .eq('user_id', userId)
        .eq('fcm_token', token);

      const { error: insertError } = await supabase
        .from('device_tokens')
        .insert({
          user_id: userId,
          fcm_token: token,
          device_name: deviceName,
          platform: platform,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });

      if (insertError) {
        logger.error(`Failed to insert FCM token in Supabase: ${insertError.message}`);
        return;
      }
    }
    logger.info(`FCM Token registered in Supabase device_tokens for user ${userId}.`);
  } catch (err) {
    logger.error(`Error registering FCM token in Supabase for user ${userId}: ${err.message}`);
  }
}

/**
 * Removes an FCM device token for a user from Supabase device_tokens table.
 */
async function removeFcmToken(userId, token) {
  if (!userId || !token) return;
  try {
    const { error } = await supabase
      .from('device_tokens')
      .delete()
      .eq('user_id', userId)
      .eq('fcm_token', token);

    if (error) {
      logger.error(`Failed to remove FCM token from Supabase for user ${userId}: ${error.message}`);
    } else {
      logger.info(`FCM Token removed from Supabase device_tokens for user ${userId}.`);
    }
  } catch (err) {
    logger.error(`Error in removeFcmToken for user ${userId}: ${err.message}`);
  }
}

/**
 * Utility function to send FCM payload to all registered tokens of a user.
 * Queries Supabase device_tokens for user_id = userId.
 * Automatically cleans up invalid or unregistered tokens.
 */
async function sendNotificationToUser(userId, payload) {
  if (!userId) return;
  try {
    const { data: records, error } = await supabase
      .from('device_tokens')
      .select('fcm_token')
      .eq('user_id', userId);

    if (error) {
      logger.error(`Error querying device_tokens from Supabase for user ${userId}: ${error.message}`);
      return;
    }

    if (!records || records.length === 0) {
      logger.warn(`No registered FCM tokens found for user ${userId}. Notification not sent.`);
      return;
    }

    const tokenList = Array.from(new Set(records.map(r => r.fcm_token).filter(Boolean)));
    if (tokenList.length === 0) {
      logger.warn(`No valid FCM tokens found in records for user ${userId}. Notification not sent.`);
      return;
    }

    logger.info(`Sending FCM notification to user ${userId} on ${tokenList.length} device(s)...`);

    const messages = tokenList.map(token => ({
      token,
      ...payload
    }));

    const response = await admin.messaging().sendEach(messages);

    // Clean up failed tokens
    for (let index = 0; index < response.responses.length; index++) {
      const res = response.responses[index];
      if (!res.success) {
        const failedToken = tokenList[index];
        const err = res.error;
        logger.warn(`FCM send failed for token ${failedToken}: ${err?.message}`);

        if (
          err?.code === 'messaging/registration-token-not-registered' ||
          err?.code === 'messaging/invalid-argument' ||
          err?.code === 'messaging/invalid-registration-token'
        ) {
          logger.info(`Pruning invalid token for user ${userId}: ${failedToken}`);
          await removeFcmToken(userId, failedToken);
        }
      }
    }
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
        clickAction: 'FLUTTER_NOTIFICATION_CLICK',
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
  sendMessageNotification
};
