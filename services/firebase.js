const admin = require('firebase-admin');
const logger = require('../utils/logger');
const supabase = require('./supabase');

/**
 * Initializes the Firebase Admin SDK using credentials from environment variables.
 * Safe to call multiple times (checks admin.apps.length).
 */
function initFirebase() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) {
    logger.warn('[FIREBASE_INIT] Firebase Admin credentials are not fully configured in environment variables.');
    logger.warn('[FIREBASE_INIT] FCM notifications will be disabled or fail until configured.');
    return false;
  }

  try {
    if (admin.apps.length === 0) {
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

      logger.info('[FIREBASE_INIT] Firebase Admin SDK initialized successfully.');
    } else {
      logger.info('[FIREBASE_INIT] Firebase Admin SDK is already initialized.');
    }
    return true;
  } catch (error) {
    logger.error(`[FIREBASE_INIT] Failed to initialize Firebase Admin SDK: ${error.message}`);
    return false;
  }
}

/**
 * Registers an FCM device token for a user in Supabase device_tokens table.
 */
async function registerFcmToken(userId, token, deviceName = 'Unknown Device', platform = 'android') {
  if (!userId || !token) return;
  try {
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

    if (error) {
      logger.warn(`[FCM_SYNC] Upsert device_tokens failed: ${error.message}. Attempting delete-insert fallback.`);
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
        logger.error(`[FCM_SYNC] Failed to insert FCM token in Supabase: ${insertError.message}`);
        return;
      }
    }
    logger.info(`[FCM_SYNC] FCM Token registered in Supabase device_tokens for user ${userId}.`);
  } catch (err) {
    logger.error(`[FCM_SYNC] Error registering FCM token in Supabase for user ${userId}: ${err.message}`);
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
      logger.error(`[FCM_PRUNE] Failed to remove FCM token from Supabase for user ${userId}: ${error.message}`);
    } else {
      logger.info(`[FCM_PRUNE] FCM Token removed from Supabase device_tokens for user ${userId}.`);
    }
  } catch (err) {
    logger.error(`[FCM_PRUNE] Error in removeFcmToken for user ${userId}: ${err.message}`);
  }
}

/**
 * Validates if an FCM error specifies that the registration token is invalid/stale/unregistered.
 */
function isInvalidTokenError(err) {
  if (!err) return false;
  const message = (err.message || '').toLowerCase();
  const code = (err.code || '').toLowerCase();
  return (
    code === 'messaging/registration-token-not-registered' ||
    code === 'messaging/invalid-argument' ||
    code === 'messaging/invalid-registration-token' ||
    code === 'messaging/invalid-recipient' ||
    message.includes('not-registered') ||
    message.includes('registration-token-not-registered') ||
    message.includes('invalid-registration-token') ||
    message.includes('requested entity was not found')
  );
}

/**
 * Sends messages with retry of transient failures and automatic removal of invalid tokens.
 */
async function sendEachWithRetry(userId, messages, maxAttempts = 3) {
  let attempts = 0;
  let results = Array(messages.length).fill(null);
  let remainingIndices = messages.map((_, i) => i);

  while (remainingIndices.length > 0 && attempts < maxAttempts) {
    attempts++;
    const batchIndices = [...remainingIndices];
    const batchMessages = batchIndices.map(i => messages[i]);

    try {
      logger.info(`[FCM_DELIVERY] Send attempt ${attempts}/${maxAttempts} for ${batchMessages.length} message(s)...`);
      const response = await admin.messaging().sendEach(batchMessages);
      const nextRemainingIndices = [];

      for (let rIndex = 0; rIndex < response.responses.length; rIndex++) {
        const res = response.responses[rIndex];
        const originalIndex = batchIndices[rIndex];
        const failedToken = messages[originalIndex].token;

        if (res.success) {
          results[originalIndex] = res;
        } else {
          const err = res.error;
          logger.warn(`[FCM_DELIVERY] Send failed for token ${failedToken}: [${err?.code}] ${err?.message}`);

          if (isInvalidTokenError(err)) {
            logger.info(`[FCM_DELIVERY] Pruning invalid token for user ${userId}: ${failedToken}`);
            await removeFcmToken(userId, failedToken);
            results[originalIndex] = res;
          } else {
            const isTransient = err?.code === 'messaging/internal-error' || 
                                err?.code === 'messaging/server-unavailable' ||
                                (err?.message && err.message.toLowerCase().includes('timeout'));

            if (isTransient && attempts < maxAttempts) {
              logger.warn(`[FCM_DELIVERY] Transient FCM error for token ${failedToken}. Retrying...`);
              nextRemainingIndices.push(originalIndex);
            } else {
              results[originalIndex] = res;
            }
          }
        }
      }

      remainingIndices = nextRemainingIndices;
      if (remainingIndices.length > 0 && attempts < maxAttempts) {
        // Wait before retrying (exponential backoff: 500ms, 1000ms, ...)
        await new Promise(resolve => setTimeout(resolve, attempts * 500));
      }
    } catch (error) {
      logger.error(`[FCM_DELIVERY] Exception in sendEachWithRetry (attempt ${attempts}): ${error.message}`);
      if (attempts >= maxAttempts) {
        batchIndices.forEach(originalIndex => {
          results[originalIndex] = { success: false, error: error };
        });
        break;
      }
      await new Promise(resolve => setTimeout(resolve, attempts * 1000));
    }
  }

  return { responses: results };
}

/**
 * Utility function to send FCM payload to all registered tokens of a user.
 * Queries Supabase device_tokens for user_id = userId.
 * Automatically cleans up invalid or unregistered tokens and retries transient errors.
 */
async function sendNotificationToUser(userId, payload) {
  if (!userId) return;
  try {
    let tokenList = [];

    // 1. Try querying device_tokens table
    const { data: records, error } = await supabase
      .from('device_tokens')
      .select('fcm_token')
      .eq('user_id', userId);

    if (!error && records && records.length > 0) {
      tokenList = Array.from(new Set(records.map(r => r.fcm_token).filter(Boolean)));
    }

    // 2. Fallback to users table if device_tokens returns no results
    if (tokenList.length === 0) {
      logger.info(`[FCM_ROUTING] No tokens in device_tokens for user ${userId}, checking fallback users table...`);
      const { data: userRecord, error: userErr } = await supabase
        .from('users')
        .select('fcm_token')
        .eq('firebase_uid', userId)
        .maybeSingle();

      if (!userErr && userRecord && userRecord.fcm_token) {
        tokenList.push(userRecord.fcm_token);
      }
    }

    if (tokenList.length === 0) {
      logger.warn(`[FCM_ROUTING] No registered FCM tokens found for user ${userId}. Notification not sent.`);
      return;
    }

    logger.info(`[FCM_ROUTING] Routing FCM notification to user ${userId} on ${tokenList.length} device(s)...`);

    const messages = tokenList.map(token => ({
      token,
      ...payload
    }));

    await sendEachWithRetry(userId, messages);
  } catch (err) {
    logger.error(`[FCM_ROUTING] Error sending bulk FCM notification for user ${userId}: ${err.message}`);
  }
}

/**
 * Sends an incoming call notification to a user's devices.
 * Uses a data-only payload for maximum control on Android (onMessageReceived is called in background).
 */
async function sendIncomingCallNotification(callerId, callerName, callerPhoto, isVideo, callId, receiverId) {
  const callType = isVideo ? 'video' : 'audio';
  const timestamp = Date.now().toString();

  const payload = {
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
      ttl: 45000, // Duration in milliseconds for firebase-admin SDK (45 seconds)
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
      ttl: 45000, // Duration in milliseconds for firebase-admin SDK (45 seconds)
    }
  };

  await sendNotificationToUser(receiverId, payload);
}

/**
 * Sends a missed call notification to a user's devices.
 */
async function sendMissedCallNotification(callerId, callerName, receiverId, callId, isVideo) {
  const payload = {
    data: {
      type: 'missed_call',
      callerId,
      callerName: callerName || 'Unknown',
      callId: callId || '',
      isVideo: isVideo ? 'true' : 'false',
      timestamp: Date.now().toString(),
    },
    android: {
      priority: 'high',
    }
  };

  await sendNotificationToUser(receiverId, payload);
}

/**
 * Sends a chat message notification to a user's devices.
 * Uses a data-only payload to allow custom notification building in Android.
 */
async function sendMessageNotification(senderId, senderName, receiverId, messageType, messageText, conversationId, messageId) {
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
    data: {
      type: 'new_message',
      senderId,
      senderName: senderName || 'Unknown',
      messageType: messageType || 'text',
      messageText: bodyText,
      conversationId: conversationId || '',
      timestamp: Date.now().toString(),
      messageId: messageId || '',
      id: messageId || ''
    },
    android: {
      priority: 'high',
    }
  };

  await sendNotificationToUser(receiverId, payload);
}

/**
 * Sends a friend request notification.
 */
async function sendFriendRequestNotification(senderId, senderName, receiverId) {
  const payload = {
    data: {
      type: 'friend_request',
      senderId,
      senderName: senderName || 'Someone',
      message: `${senderName} sent you a friend request`,
      timestamp: Date.now().toString(),
    },
    android: {
      priority: 'high',
    }
  };
  await sendNotificationToUser(receiverId, payload);
}

/**
 * Sends a friend accepted notification.
 */
async function sendFriendAcceptedNotification(senderId, senderName, receiverId) {
  const payload = {
    data: {
      type: 'friend_accepted',
      senderId,
      senderName: senderName || 'Someone',
      message: `${senderName} accepted your friend request`,
      timestamp: Date.now().toString(),
    },
    android: {
      priority: 'high',
    }
  };
  await sendNotificationToUser(receiverId, payload);
}

/**
 * Sends a call rejected notification.
 */
async function sendCallRejectedNotification(callerId, callerName, receiverId, callId, reason) {
  const payload = {
    data: {
      type: 'call_rejected',
      callerId,
      callerName: callerName || 'User',
      callId: callId || '',
      reason: reason || 'declined',
      timestamp: Date.now().toString(),
    },
    android: {
      priority: 'high',
    }
  };
  await sendNotificationToUser(receiverId, payload);
}

/**
 * Sends a love auto voice notification to a user's devices.
 */
async function sendLoveAutoVoiceNotification(senderId, senderName, senderAvatar, receiverId, scheduleId, audioPath, scheduledAt, timezone, voiceDuration) {
  const payload = {
    data: {
      type: 'love_auto_voice',
      schedule_id: scheduleId,
      audio_path: audioPath || '',
      sender_id: senderId,
      sender_name: senderName || 'User',
      sender_avatar: senderAvatar || '',
      scheduled_at: String(scheduledAt || ''),
      timezone: timezone || '',
      voice_duration: String(voiceDuration || 0),
      timestamp: Date.now().toString()
    },
    android: {
      priority: 'high'
    }
  };

  try {
    let tokenList = [];
    const { data: records, error } = await supabase
      .from('device_tokens')
      .select('fcm_token')
      .eq('user_id', receiverId);

    if (!error && records && records.length > 0) {
      tokenList = Array.from(new Set(records.map(r => r.fcm_token).filter(Boolean)));
    }

    if (tokenList.length === 0) {
      const { data: userRecord, error: userErr } = await supabase
        .from('users')
        .select('fcm_token')
        .eq('firebase_uid', receiverId)
        .maybeSingle();

      if (!userErr && userRecord && userRecord.fcm_token) {
        tokenList.push(userRecord.fcm_token);
      }
    }

    if (tokenList.length === 0) {
      throw new Error(`No FCM tokens found for receiver ${receiverId}`);
    }

    logger.info(`[FCM_SCHEDULED] Sending Love Auto Voice FCM to ${receiverId} with ${tokenList.length} device(s)...`);

    const messages = tokenList.map(token => ({
      token,
      ...payload
    }));

    const response = await sendEachWithRetry(receiverId, messages);
    const successResp = response.responses.find(r => r.success);
    if (successResp && successResp.messageId) {
      return successResp.messageId;
    } else {
      const firstError = response.responses.find(r => !r.success)?.error?.message || 'FCM send failed for all tokens';
      throw new Error(firstError);
    }
  } catch (err) {
    logger.error(`[FCM_SCHEDULED] Failed to send scheduled voice message: ${err.message}`);
    throw err;
  }
}

module.exports = {
  initFirebase,
  registerFcmToken,
  removeFcmToken,
  sendIncomingCallNotification,
  sendCallCancelledNotification,
  sendMissedCallNotification,
  sendMessageNotification,
  sendFriendRequestNotification,
  sendFriendAcceptedNotification,
  sendCallRejectedNotification,
  sendLoveAutoVoiceNotification
};
