const logger = require('../utils/logger');
const { getIceServers } = require('../config/iceServers');
const firebaseService = require('../services/firebase');
const supabase = require('../services/supabase');

// In-memory store of active online users:
// userId -> { socketId, userId, fullName, isBusy, activeCallWith, activeChatWithUserId, isForeground }
const onlineUsers = new Map();

// In-memory store of pending call invitations:
// callerId_receiverId -> { callerId, targetUserId, isVideo, timer, callId }
const activeCallInvitations = new Map();
const activeCallSessions = new Map(); // callId -> { callerId, receiverId, callType, startTime, isAccepted }

function logIncomingEvent(eventName, payload, socketId, userId) {
  logger.info(`[SOCKET]
Incoming Event: ${eventName}
User: ${userId || 'unknown'} (Socket: ${socketId})
Payload: ${JSON.stringify(payload || {})}`);
}

function emitEvents(target, events, payload, receiverLabel = '') {
  if (!target) return;
  const eventList = Array.isArray(events) ? events : [events];
  for (const eventName of eventList) {
    logger.info(`[SOCKET]
Outgoing Event: ${eventName}
Receiver: ${receiverLabel}
Payload: ${JSON.stringify(payload || {})}`);
    target.emit(eventName, payload);
  }
}

async function updatePresence(userId, data) {
  if (!userId) return;
  try {
    const now = new Date().toISOString();
    const payload = {
      user_id: userId,
      ...data,
      updated_at: now
    };
    if (data.is_online === false && !data.last_seen) {
      payload.last_seen = now;
    }
    await supabase.from('user_presence').upsert(payload, { onConflict: 'user_id' });
    logger.info(`Updated user_presence for ${userId}: ${JSON.stringify(payload)}`);
  } catch (err) {
    logger.error(`Error updating user_presence for ${userId}: ${err.message}`);
  }
}

async function recordCall(callId, callerId, receiverId, callType, status, durationSeconds = 0) {
  if (!callId) return;
  try {
    const now = new Date().toISOString();
    const payload = {
      call_id: callId,
      caller_id: callerId,
      receiver_id: receiverId,
      call_type: callType,
      status: status,
      duration_seconds: durationSeconds,
      created_at: now
    };
    await supabase.from('call_history').upsert(payload, { onConflict: 'call_id' });
    logger.info(`Recorded call_history ${callId} status=${status}`);
  } catch (err) {
    logger.error(`Error recording call_history ${callId}: ${err.message}`);
  }
}

function initSocket(io) {
  io.on('connection', (socket) => {
    const userId = socket.userId;
    const fullName = socket.fullName || 'User';
    logger.info(`User connected: ${userId} (${fullName}) with socket ID: ${socket.id}`);

    // Register FCM Token if provided during handshake
    const handshakeToken = socket.handshake.auth?.fcmToken || socket.handshake.query?.fcmToken;
    if (handshakeToken) {
      firebaseService.registerFcmToken(userId, handshakeToken);
    }

    // If user is already logged in elsewhere, update their socket or disconnect older one
    if (onlineUsers.has(userId)) {
      const existingUser = onlineUsers.get(userId);
      logger.info(`User ${userId} reconnected. Terminating old socket session: ${existingUser.socketId}`);
      
      const oldSocket = io.sockets.sockets.get(existingUser.socketId);
      if (oldSocket) {
        oldSocket.removeAllListeners('disconnect');
        oldSocket.emit('force_disconnect', { message: 'Logged in from another device' });
        oldSocket.disconnect(true);
      }
    }

    // Register user as active and available, preserving existing call/chat state if reconnecting
    const existingState = onlineUsers.get(userId) || {};
    const handshakeIsForeground = socket.handshake.auth?.isForeground ?? socket.handshake.query?.isForeground;
    const initialIsForeground = (handshakeIsForeground === 'false' || handshakeIsForeground === false) ? false : true;

    onlineUsers.set(userId, {
      socketId: socket.id,
      userId,
      fullName,
      isBusy: existingState.isBusy || false,
      activeCallWith: existingState.activeCallWith || null,
      activeChatWithUserId: existingState.activeChatWithUserId || null,
      isForeground: initialIsForeground
    });
    logger.info(`User connected & registered: ${userId} (${fullName}), isForeground=${initialIsForeground}`);
    updatePresence(userId, { is_online: true });

    // Notify all other clients that this user is now online
    emitEvents(socket.broadcast, ['user_online', 'user-online', 'user_connected', 'user-connected'], { userId, fullName }, 'ALL_BROADCAST');

    // Send current list of online users to newly connected user
    const usersList = Array.from(onlineUsers.values()).map(user => ({
      userId: user.userId,
      fullName: user.fullName,
      isBusy: user.isBusy
    }));
    emitEvents(socket, ['online_users', 'online-users', 'online_users_list', 'users_online', 'users-online'], usersList, userId);

    // Relays ICE servers list to the newly connected client
    emitEvents(socket, ['ice_servers', 'ice-servers'], getIceServers(), userId);

    // ----------------------------------------------------
    // USER REGISTRATION EVENTS
    // ----------------------------------------------------

    const handleRegisterUser = (eventName) => (data) => {
      logIncomingEvent(eventName, data, socket.id, userId);
      const regUserId = data?.userId || data?.user_id || userId;
      const regFullName = data?.fullName || data?.full_name || fullName || 'User';
      if (regUserId) {
        const state = onlineUsers.get(regUserId) || {};
        onlineUsers.set(regUserId, {
          socketId: socket.id,
          userId: regUserId,
          fullName: regFullName,
          isBusy: state.isBusy || false,
          activeCallWith: state.activeCallWith || null,
          activeChatWithUserId: state.activeChatWithUserId || null,
          isForeground: state.isForeground !== undefined ? state.isForeground : true
        });
        updatePresence(regUserId, { is_online: true });
        emitEvents(socket.broadcast, ['user_online', 'user-online', 'user_connected', 'user-connected'], { userId: regUserId, fullName: regFullName }, 'ALL_BROADCAST');
        const list = Array.from(onlineUsers.values()).map(u => ({ userId: u.userId, fullName: u.fullName, isBusy: u.isBusy }));
        emitEvents(socket, ['online_users', 'online-users', 'online_users_list', 'users_online', 'users-online'], list, regUserId);
      }
    };

    socket.on('register_user', handleRegisterUser('register_user'));
    socket.on('register-user', handleRegisterUser('register-user'));

    const handleGetOnlineUsers = (eventName) => (data) => {
      logIncomingEvent(eventName, data, socket.id, userId);
      const list = Array.from(onlineUsers.values()).map(u => ({ userId: u.userId, fullName: u.fullName, isBusy: u.isBusy }));
      emitEvents(socket, ['online_users', 'online-users', 'online_users_list', 'users_online', 'users-online'], list, userId);
    };

    socket.on('get_online_users', handleGetOnlineUsers('get_online_users'));
    socket.on('get-online-users', handleGetOnlineUsers('get-online-users'));
    socket.on('get_online_user_list', handleGetOnlineUsers('get_online_user_list'));
    socket.on('get-online-user-list', handleGetOnlineUsers('get-online-user-list'));
    socket.on('get_users_online', handleGetOnlineUsers('get_users_online'));
    socket.on('get-users-online', handleGetOnlineUsers('get-users-online'));

    // ----------------------------------------------------
    // FCM TOKEN MANAGEMENT
    // ----------------------------------------------------

    const handleRegisterFcmToken = (eventName) => async (data) => {
      logIncomingEvent(eventName, data, socket.id, userId);
      const { token, deviceName, platform } = data || {};
      if (token) {
        await firebaseService.registerFcmToken(userId, token, deviceName, platform);
        emitEvents(socket, ['fcm_token_registered', 'fcm-token-registered'], { success: true }, userId);
      } else {
        emitEvents(socket, ['fcm_token_registered', 'fcm-token-registered'], { success: false, error: 'Token is required' }, userId);
      }
    };

    socket.on('register_fcm_token', handleRegisterFcmToken('register_fcm_token'));
    socket.on('register-fcm-token', handleRegisterFcmToken('register-fcm-token'));

    const handleUnregisterFcmToken = (eventName) => async (data) => {
      logIncomingEvent(eventName, data, socket.id, userId);
      const { token } = data || {};
      if (token) {
        await firebaseService.removeFcmToken(userId, token);
        emitEvents(socket, ['fcm_token_unregistered', 'fcm-token-unregistered'], { success: true }, userId);
      }
    };

    socket.on('unregister_fcm_token', handleUnregisterFcmToken('unregister_fcm_token'));
    socket.on('unregister-fcm-token', handleUnregisterFcmToken('unregister-fcm-token'));

    // ----------------------------------------------------
    // APP LIFECYCLE STATE TRACKING (FOREGROUND / BACKGROUND)
    // ----------------------------------------------------

    socket.on('app_state', (data) => {
      logIncomingEvent('app_state', data, socket.id, userId);
      const user = onlineUsers.get(userId);
      if (user) {
        user.isForeground = !!(data && (data.isForeground === true || data.isForeground === 'true'));
      }
    });

    socket.on('app-state', (data) => {
      logIncomingEvent('app-state', data, socket.id, userId);
      const user = onlineUsers.get(userId);
      if (user) {
        user.isForeground = !!(data && (data.isForeground === true || data.isForeground === 'true'));
      }
    });

    socket.on('app_foreground', () => {
      logIncomingEvent('app_foreground', {}, socket.id, userId);
      const user = onlineUsers.get(userId);
      if (user) user.isForeground = true;
    });

    socket.on('app-foreground', () => {
      logIncomingEvent('app-foreground', {}, socket.id, userId);
      const user = onlineUsers.get(userId);
      if (user) user.isForeground = true;
    });

    socket.on('app_background', () => {
      logIncomingEvent('app_background', {}, socket.id, userId);
      const user = onlineUsers.get(userId);
      if (user) user.isForeground = false;
    });

    socket.on('app-background', () => {
      logIncomingEvent('app-background', {}, socket.id, userId);
      const user = onlineUsers.get(userId);
      if (user) user.isForeground = false;
    });

    // ----------------------------------------------------
    // CHAT SCREEN TRACKING (ACTIVE CONVERSATION)
    // ----------------------------------------------------

    socket.on('active_chat_open', (data) => {
      logIncomingEvent('active_chat_open', data, socket.id, userId);
      const targetUserId = data?.targetUserId || data?.target_user_id;
      const user = onlineUsers.get(userId);
      if (user) user.activeChatWithUserId = targetUserId;
      updatePresence(userId, { current_chat_id: targetUserId });
    });

    socket.on('active-chat-open', (data) => {
      logIncomingEvent('active-chat-open', data, socket.id, userId);
      const targetUserId = data?.targetUserId || data?.target_user_id;
      const user = onlineUsers.get(userId);
      if (user) user.activeChatWithUserId = targetUserId;
      updatePresence(userId, { current_chat_id: targetUserId });
    });

    socket.on('active_chat_close', () => {
      logIncomingEvent('active_chat_close', {}, socket.id, userId);
      const user = onlineUsers.get(userId);
      if (user) user.activeChatWithUserId = null;
      updatePresence(userId, { current_chat_id: null });
    });

    socket.on('active-chat-close', () => {
      logIncomingEvent('active-chat-close', {}, socket.id, userId);
      const user = onlineUsers.get(userId);
      if (user) user.activeChatWithUserId = null;
      updatePresence(userId, { current_chat_id: null });
    });

    socket.on('active_chat_changed', (data) => {
      logIncomingEvent('active_chat_changed', data, socket.id, userId);
      const targetUserId = data?.targetUserId || data?.target_user_id;
      const user = onlineUsers.get(userId);
      if (user) user.activeChatWithUserId = targetUserId || null;
      updatePresence(userId, { current_chat_id: targetUserId || null });
    });

    socket.on('active-chat-changed', (data) => {
      logIncomingEvent('active-chat-changed', data, socket.id, userId);
      const targetUserId = data?.targetUserId || data?.target_user_id;
      const user = onlineUsers.get(userId);
      if (user) user.activeChatWithUserId = targetUserId || null;
      updatePresence(userId, { current_chat_id: targetUserId || null });
    });

    // ----------------------------------------------------
    // TYPING INDICATORS
    // ----------------------------------------------------

    const handleTyping = (eventName) => (data) => {
      logIncomingEvent(eventName, data, socket.id, userId);
      const targetUserId = data?.targetUserId || data?.receiverId || data?.target_user_id || data?.receiver_id;
      updatePresence(userId, { is_typing: true, current_chat_id: targetUserId });
      const targetUser = onlineUsers.get(targetUserId);
      if (targetUser) {
        const payload = { senderId: userId, sender_id: userId, targetUserId, target_user_id: targetUserId, isTyping: true, is_typing: true };
        emitEvents(io.to(targetUser.socketId), ['typing', 'user_typing', 'user-typing'], payload, targetUserId);
      }
    };

    const handleStopTyping = (eventName) => (data) => {
      logIncomingEvent(eventName, data, socket.id, userId);
      const targetUserId = data?.targetUserId || data?.receiverId || data?.target_user_id || data?.receiver_id;
      updatePresence(userId, { is_typing: false });
      const targetUser = onlineUsers.get(targetUserId);
      if (targetUser) {
        const payload = { senderId: userId, sender_id: userId, targetUserId, target_user_id: targetUserId, isTyping: false, is_typing: false };
        emitEvents(io.to(targetUser.socketId), ['stop_typing', 'stop-typing'], payload, targetUserId);
      }
    };

    socket.on('typing', handleTyping('typing'));
    socket.on('user_typing', handleTyping('user_typing'));
    socket.on('user-typing', handleTyping('user-typing'));
    socket.on('stop_typing', handleStopTyping('stop_typing'));
    socket.on('stop-typing', handleStopTyping('stop-typing'));

    // ----------------------------------------------------
    // SOCKET.IO REALTIME MESSAGING
    // ----------------------------------------------------

    const handleSendMessage = (eventName) => async (data) => {
      logIncomingEvent(eventName, data, socket.id, userId);
      if (!data) return;
      const senderId = data.senderId || data.sender_id || userId;
      const receiverId = data.receiverId || data.receiver_id || data.targetUserId || data.target_user_id || data.to;
      const content = data.content || data.messageText || data.message_text || data.message || data.body || '';
      const messageType = data.messageType || data.message_type || data.type || 'text';
      const msgId = data.id || data.messageId || data.message_id || `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      const timestamp = data.timestamp || data.createdAt || data.created_at || new Date().toISOString();
      const senderName = data.senderName || data.sender_name || fullName || 'User';
      const senderAvatar = data.senderAvatar || data.sender_avatar || '';

      const normalizedMsg = {
        id: msgId,
        messageId: msgId,
        message_id: msgId,
        senderId,
        sender_id: senderId,
        receiverId,
        receiver_id: receiverId,
        targetUserId: receiverId,
        target_user_id: receiverId,
        content,
        messageText: content,
        message_text: content,
        message: content,
        type: messageType,
        messageType,
        message_type: messageType,
        mediaUrl: data.mediaUrl || data.media_url || null,
        fileName: data.fileName || data.file_name || null,
        fileSize: data.fileSize || data.file_size || null,
        mimeType: data.mimeType || data.mime_type || null,
        duration: data.duration || null,
        replyToMessageId: data.replyToMessageId || data.reply_to_message_id || null,
        timestamp,
        created_at: timestamp,
        senderName,
        sender_name: senderName,
        senderAvatar,
        sender_avatar: senderAvatar
      };

      supabase.saveMessage(normalizedMsg).catch(err => {
        logger.error(`[SOCKET_MSG] Async Supabase save error: ${err.message}`);
      });

      const receiverUser = onlineUsers.get(receiverId);
      const isOnline = !!receiverUser;
      const isViewingCurrentChat = isOnline && (receiverUser.activeChatWithUserId === senderId);

      if (isOnline) {
        emitEvents(io.to(receiverUser.socketId), ['receive_message', 'receive-message', 'new_message', 'new-message', 'chat_message', 'chat-message'], normalizedMsg, receiverId);

        const deliveredPayload = {
          id: msgId,
          messageId: msgId,
          message_id: msgId,
          receiverId,
          receiver_id: receiverId,
          senderId,
          sender_id: senderId,
          deliveredAt: new Date().toISOString(),
          delivered_at: new Date().toISOString()
        };
        emitEvents(socket, ['message_delivered', 'message-delivered'], deliveredPayload, senderId);

        if (isViewingCurrentChat) {
          const readSeenPayload = {
            readerId: receiverId,
            reader_id: receiverId,
            senderId,
            sender_id: senderId,
            targetUserId: senderId,
            target_user_id: senderId,
            seenAt: new Date().toISOString(),
            seen_at: new Date().toISOString(),
            readAt: new Date().toISOString(),
            read_at: new Date().toISOString()
          };
          emitEvents(socket, ['message_seen', 'message-seen', 'message_read', 'message-read'], readSeenPayload, senderId);
          supabase.markMessagesSeen(receiverId, senderId).catch(err => {
            logger.error(`[SOCKET_MSG] Async markMessagesSeen error: ${err.message}`);
          });
        }
      }

      if (!isViewingCurrentChat) {
        firebaseService.sendMessageNotification(
          senderId,
          senderName,
          receiverId,
          messageType,
          content,
          data.conversationId || '',
          msgId
        ).catch(err => {
          logger.error(`[SOCKET_MSG] FCM notification error: ${err.message}`);
        });
      }
    };

    socket.on('send_message', handleSendMessage('send_message'));
    socket.on('send-message', handleSendMessage('send-message'));
    socket.on('new_message', handleSendMessage('new_message'));
    socket.on('new-message', handleSendMessage('new-message'));
    socket.on('chat_message', handleSendMessage('chat_message'));
    socket.on('chat-message', handleSendMessage('chat-message'));

    const handleMessageRead = (eventName) => async (data) => {
      logIncomingEvent(eventName, data, socket.id, userId);
      if (!data) return;
      const readerId = data.readerId || data.reader_id || userId;
      const targetUserId = data.targetUserId || data.target_user_id || data.senderId || data.sender_id || data.receiverId || data.receiver_id;
      if (!targetUserId) return;

      supabase.markMessagesSeen(readerId, targetUserId).catch(err => {
        logger.error(`[SOCKET_READ] Async markMessagesSeen error: ${err.message}`);
      });

      const targetUser = onlineUsers.get(targetUserId);
      if (targetUser) {
        const payload = {
          readerId,
          reader_id: readerId,
          targetUserId,
          target_user_id: targetUserId,
          senderId: targetUserId,
          sender_id: targetUserId,
          readAt: new Date().toISOString(),
          read_at: new Date().toISOString(),
          seenAt: new Date().toISOString(),
          seen_at: new Date().toISOString()
        };
        emitEvents(io.to(targetUser.socketId), ['message_read', 'message-read', 'messages_read', 'messages-read', 'message_seen', 'message-seen'], payload, targetUserId);
      }
    };

    socket.on('message_read', handleMessageRead('message_read'));
    socket.on('message-read', handleMessageRead('message-read'));
    socket.on('messages_read', handleMessageRead('messages_read'));
    socket.on('messages-read', handleMessageRead('messages-read'));
    socket.on('message_seen', handleMessageRead('message_seen'));
    socket.on('message-seen', handleMessageRead('message-seen'));

    const handleSendFriendRequest = (eventName) => async (data) => {
      logIncomingEvent(eventName, data, socket.id, userId);
      const receiverId = data?.receiverId || data?.receiver_id;
      if (!receiverId) return;
      const receiver = onlineUsers.get(receiverId);
      const payload = { senderId: userId, sender_id: userId, senderName: fullName, sender_name: fullName };
      if (receiver) {
        emitEvents(io.to(receiver.socketId), ['friend_request', 'friend-request'], payload, receiverId);
      } else {
        await firebaseService.sendFriendRequestNotification(userId, fullName, receiverId);
      }
    };

    socket.on('send_friend_request', handleSendFriendRequest('send_friend_request'));
    socket.on('send-friend-request', handleSendFriendRequest('send-friend-request'));

    const handleAcceptFriendRequest = (eventName) => async (data) => {
      logIncomingEvent(eventName, data, socket.id, userId);
      const receiverId = data?.receiverId || data?.receiver_id;
      if (!receiverId) return;
      const receiver = onlineUsers.get(receiverId);
      const payload = { senderId: userId, sender_id: userId, senderName: fullName, sender_name: fullName };
      if (receiver) {
        emitEvents(io.to(receiver.socketId), ['friend_accepted', 'friend-accepted'], payload, receiverId);
      } else {
        await firebaseService.sendFriendAcceptedNotification(userId, fullName, receiverId);
      }
    };

    socket.on('accept_friend_request', handleAcceptFriendRequest('accept_friend_request'));
    socket.on('accept-friend-request', handleAcceptFriendRequest('accept-friend-request'));

    const handleSendMessageNotification = (eventName) => async (data) => {
      logIncomingEvent(eventName, data, socket.id, userId);
      const receiverId = data?.receiverId || data?.receiver_id;
      const messageType = data?.messageType || data?.message_type || 'text';
      const messageText = data?.messageText || data?.message_text || data?.content || '';
      const conversationId = data?.conversationId || data?.conversation_id || '';
      if (!receiverId) return;

      const receiverUser = onlineUsers.get(receiverId);
      const isViewingCurrentChat = receiverUser && (receiverUser.activeChatWithUserId === userId);

      if (isViewingCurrentChat) {
        logger.info(`Receiver ${receiverId} is actively viewing conversation. Suppressing FCM notification.`);
        return;
      }

      await firebaseService.sendMessageNotification(
        userId,
        fullName,
        receiverId,
        messageType,
        messageText,
        conversationId
      );
    };

    socket.on('send_message_notification', handleSendMessageNotification('send_message_notification'));
    socket.on('send-message-notification', handleSendMessageNotification('send-message-notification'));

    // ----------------------------------------------------
    // CALL MANAGEMENT EVENTS (AUDIO & VIDEO)
    // ----------------------------------------------------

    const handleCallUser = (eventName) => async (data) => {
      logIncomingEvent(eventName, data, socket.id, userId);
      const targetUserId = data?.targetUserId || data?.target_user_id || data?.receiverId || data?.receiver_id || data?.targetId || data?.target_id || data?.to;
      const isVideo = !!(data?.isVideo || data?.is_video || data?.callType === 'video' || data?.call_type === 'video');
      const callerPhoto = data?.callerPhoto || data?.caller_photo || data?.senderAvatar || data?.sender_avatar || '';

      const callId = data?.callId || data?.call_id || data?.roomId || data?.room_id || `call_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      const callType = isVideo ? 'video' : 'audio';
      activeCallSessions.set(callId, { callerId: userId, receiverId: targetUserId, callType, startTime: Date.now(), isAccepted: false });
      recordCall(callId, userId, targetUserId, callType, 'outgoing');

      const targetUser = onlineUsers.get(targetUserId);

      // If target is online and already busy, reject immediately
      if (targetUser && targetUser.isBusy) {
        recordCall(callId, userId, targetUserId, callType, 'rejected');
        activeCallSessions.delete(callId);
        const busyPayload = {
          targetUserId,
          target_user_id: targetUserId,
          receiverId: targetUserId,
          receiver_id: targetUserId,
          reason: 'busy',
          callId,
          call_id: callId,
          senderId: targetUserId,
          sender_id: targetUserId
        };
        emitEvents(socket, ['call_rejected', 'call-rejected', 'reject_call', 'reject-call'], busyPayload, userId);
        return;
      }

      const invitationKey = `${userId}_${targetUserId}`;
      const oldInvitation = activeCallInvitations.get(invitationKey);
      if (oldInvitation) clearTimeout(oldInvitation.timer);

      const callTimer = setTimeout(async () => {
        logger.info(`Call invitation ${callId} from ${userId} to ${targetUserId} timed out.`);
        recordCall(callId, userId, targetUserId, isVideo ? 'video' : 'audio', 'missed');
        activeCallSessions.delete(callId);
        clearCallState(userId, targetUserId);
        activeCallInvitations.delete(invitationKey);

        await firebaseService.sendMissedCallNotification(userId, fullName, targetUserId, callId, isVideo);

        const timeoutPayload = {
          targetUserId,
          target_user_id: targetUserId,
          callerId: userId,
          caller_id: userId,
          senderId: userId,
          sender_id: userId,
          callId,
          call_id: callId,
          reason: 'timeout'
        };
        emitEvents(socket, ['call_timeout', 'call-timeout', 'timeout'], timeoutPayload, userId);

        const targetUserObj = onlineUsers.get(targetUserId);
        if (targetUserObj) {
          emitEvents(io.to(targetUserObj.socketId), ['call_timeout', 'call-timeout', 'timeout'], timeoutPayload, targetUserId);
        }
      }, 45000);

      activeCallInvitations.set(invitationKey, {
        callerId: userId,
        targetUserId,
        isVideo,
        timer: callTimer,
        callId
      });

      const callerUser = onlineUsers.get(userId);
      if (callerUser) {
        callerUser.isBusy = true;
        callerUser.activeCallWith = targetUserId;
      }

      const isTargetInForeground = !!(targetUser && targetUser.isForeground !== false);
      const incomingCallPayload = {
        callerId: userId,
        caller_id: userId,
        senderId: userId,
        sender_id: userId,
        callerName: fullName,
        caller_name: fullName,
        callerPhoto: callerPhoto || '',
        caller_photo: callerPhoto || '',
        isVideo,
        is_video: isVideo,
        callType: isVideo ? 'video' : 'audio',
        call_type: isVideo ? 'video' : 'audio',
        callId,
        call_id: callId,
        roomId: callId,
        room_id: callId,
        targetUserId,
        target_user_id: targetUserId
      };

      if (isTargetInForeground) {
        emitEvents(io.to(targetUser.socketId), ['incoming_call', 'incoming-call'], incomingCallPayload, targetUserId);
      } else {
        await firebaseService.sendIncomingCallNotification(
          userId,
          fullName,
          callerPhoto || '',
          isVideo,
          callId,
          targetUserId
        );
      }
    };

    socket.on('call_user', handleCallUser('call_user'));
    socket.on('call-user', handleCallUser('call-user'));

    const handleRinging = (eventName) => (data) => {
      logIncomingEvent(eventName, data, socket.id, userId);
      const callerId = data?.callerId || data?.caller_id || data?.senderId || data?.sender_id || data?.targetUserId || data?.target_user_id;
      const callId = data?.callId || data?.call_id;

      const callerUser = onlineUsers.get(callerId);
      if (callerUser) {
        const payload = {
          receiverId: userId,
          receiver_id: userId,
          senderId: userId,
          sender_id: userId,
          callerId,
          caller_id: callerId,
          callId,
          call_id: callId
        };
        emitEvents(io.to(callerUser.socketId), ['ringing', 'call_ringing', 'call-ringing'], payload, callerId);
      }
    };

    socket.on('ringing', handleRinging('ringing'));
    socket.on('call_ringing', handleRinging('call_ringing'));
    socket.on('call-ringing', handleRinging('call-ringing'));

    const handleAcceptCall = (eventName) => (data) => {
      logIncomingEvent(eventName, data, socket.id, userId);
      const callerId = data?.callerId || data?.caller_id || data?.targetUserId || data?.target_user_id || data?.senderId || data?.sender_id;
      const callId = data?.callId || data?.call_id;

      const session = activeCallSessions.get(callId) || { callerId, receiverId: userId, callType: 'audio', startTime: Date.now() };
      session.isAccepted = true;
      activeCallSessions.set(callId, session);
      recordCall(callId, session.callerId, session.receiverId, session.callType, 'accepted');

      const invitationKey = `${callerId}_${userId}`;
      const invitation = activeCallInvitations.get(invitationKey);
      if (invitation) {
        clearTimeout(invitation.timer);
        activeCallInvitations.delete(invitationKey);
      }

      const receiverUser = onlineUsers.get(userId);
      if (receiverUser) {
        receiverUser.isBusy = true;
        receiverUser.activeCallWith = callerId;
      }

      const callerUser = onlineUsers.get(callerId);
      const acceptPayload = {
        receiverId: userId,
        receiver_id: userId,
        senderId: userId,
        sender_id: userId,
        callerId,
        caller_id: callerId,
        callId,
        call_id: callId
      };

      if (callerUser) {
        callerUser.isBusy = true;
        callerUser.activeCallWith = userId;
        emitEvents(io.to(callerUser.socketId), ['call_accepted', 'call-accepted', 'accept_call', 'accept-call'], acceptPayload, callerId);
      } else {
        if (receiverUser) {
          receiverUser.isBusy = false;
          receiverUser.activeCallWith = null;
        }
        const endPayload = {
          callId: callId || '',
          call_id: callId || '',
          senderId: callerId || '',
          sender_id: callerId || '',
          reason: 'Caller disconnected'
        };
        emitEvents(socket, ['call_ended', 'call-ended', 'end_call', 'end-call'], endPayload, userId);
      }
    };

    socket.on('accept_call', handleAcceptCall('accept_call'));
    socket.on('accept-call', handleAcceptCall('accept-call'));

    const handleRejectCall = (eventName) => async (data) => {
      logIncomingEvent(eventName, data, socket.id, userId);
      const callerId = data?.callerId || data?.caller_id || data?.targetUserId || data?.target_user_id || data?.senderId || data?.sender_id;
      const reason = data?.reason || (eventName === 'busy' ? 'busy' : 'declined');
      const callId = data?.callId || data?.call_id;

      const session = activeCallSessions.get(callId) || { callerId, receiverId: userId, callType: 'audio' };
      recordCall(callId, session.callerId || callerId, session.receiverId || userId, session.callType || 'audio', 'rejected');
      activeCallSessions.delete(callId);

      const invitationKey = `${callerId}_${userId}`;
      const invitation = activeCallInvitations.get(invitationKey);
      if (invitation) {
        clearTimeout(invitation.timer);
        activeCallInvitations.delete(invitationKey);
      }

      clearCallState(userId, callerId);

      const rejectPayload = {
        receiverId: userId,
        receiver_id: userId,
        senderId: userId,
        sender_id: userId,
        callerId,
        caller_id: callerId,
        reason,
        callId,
        call_id: callId
      };

      const callerUser = onlineUsers.get(callerId);
      if (callerUser) {
        emitEvents(io.to(callerUser.socketId), ['call_rejected', 'call-rejected', 'reject_call', 'reject-call'], rejectPayload, callerId);
      } else {
        await firebaseService.sendCallRejectedNotification(userId, fullName, callerId, callId, reason);
      }
    };

    socket.on('reject_call', handleRejectCall('reject_call'));
    socket.on('reject-call', handleRejectCall('reject-call'));
    socket.on('busy', handleRejectCall('busy'));

    const handleCancelCall = (eventName) => async (data) => {
      logIncomingEvent(eventName, data, socket.id, userId);
      const targetUserId = data?.targetUserId || data?.target_user_id || data?.receiverId || data?.receiver_id;
      const callId = data?.callId || data?.call_id;

      const session = activeCallSessions.get(callId) || { callerId: userId, receiverId: targetUserId, callType: 'audio' };
      recordCall(callId, session.callerId || userId, session.receiverId || targetUserId, session.callType || 'audio', 'cancelled');
      activeCallSessions.delete(callId);

      const invitationKey = `${userId}_${targetUserId}`;
      const invitation = activeCallInvitations.get(invitationKey);
      if (invitation) {
        clearTimeout(invitation.timer);
        activeCallInvitations.delete(invitationKey);
      }

      clearCallState(userId, targetUserId);

      const cancelPayload = {
        callerId: userId,
        caller_id: userId,
        senderId: userId,
        sender_id: userId,
        targetUserId,
        target_user_id: targetUserId,
        receiverId: targetUserId,
        receiver_id: targetUserId,
        callId,
        call_id: callId,
        reason: 'cancelled'
      };

      const targetUser = onlineUsers.get(targetUserId);
      if (targetUser) {
        emitEvents(io.to(targetUser.socketId), ['call_cancelled', 'call-cancelled', 'cancel_call', 'cancel-call'], cancelPayload, targetUserId);
      } else {
        await firebaseService.sendCallCancelledNotification(userId, fullName, targetUserId, callId);
      }
    };

    socket.on('cancel_call', handleCancelCall('cancel_call'));
    socket.on('cancel-call', handleCancelCall('cancel-call'));

    const handleEndCallEvent = (eventName) => (data) => {
      logIncomingEvent(eventName, data, socket.id, userId);
      const targetUserId = data?.targetUserId || data?.target_user_id || data?.receiverId || data?.receiver_id || data?.callerId || data?.caller_id;
      const callId = data?.callId || data?.call_id || '';
      const reason = data?.reason || 'Call ended';

      const session = activeCallSessions.get(callId) || { callerId: userId, receiverId: targetUserId, callType: 'audio', startTime: Date.now() };
      const durationSeconds = session.startTime ? Math.floor((Date.now() - session.startTime) / 1000) : 0;
      recordCall(callId, session.callerId || userId, session.receiverId || targetUserId, session.callType || 'audio', 'ended', durationSeconds);
      activeCallSessions.delete(callId);

      const invitationKeyA = `${userId}_${targetUserId}`;
      const invitationKeyB = `${targetUserId}_${userId}`;
      const invitationA = activeCallInvitations.get(invitationKeyA);
      const invitationB = activeCallInvitations.get(invitationKeyB);
      if (invitationA) { clearTimeout(invitationA.timer); activeCallInvitations.delete(invitationKeyA); }
      if (invitationB) { clearTimeout(invitationB.timer); activeCallInvitations.delete(invitationKeyB); }

      clearCallState(userId, targetUserId);

      // Requirement 7: Every call_ended payload MUST contain callId, senderId, reason (if available).
      const endPayload = {
        callId: callId || '',
        call_id: callId || '',
        senderId: userId || '',
        sender_id: userId || '',
        callerId: userId || '',
        caller_id: userId || '',
        targetUserId: targetUserId || '',
        target_user_id: targetUserId || '',
        reason: reason
      };

      const targetUser = onlineUsers.get(targetUserId);
      if (targetUser) {
        emitEvents(io.to(targetUser.socketId), ['call_ended', 'call-ended', 'end_call', 'end-call'], endPayload, targetUserId);
      }
    };

    socket.on('end_call', handleEndCallEvent('end_call'));
    socket.on('end-call', handleEndCallEvent('end-call'));
    socket.on('call_ended', handleEndCallEvent('call_ended'));
    socket.on('call-ended', handleEndCallEvent('call-ended'));

    // ----------------------------------------------------
    // WEBRTC SIGNALING RELAYS (OFFER, ANSWER, ICE CANDIDATES)
    // ----------------------------------------------------

    socket.on('offer', (data) => {
      logIncomingEvent('offer', data, socket.id, userId);
      const targetUserId = data?.targetUserId || data?.target_user_id || data?.receiverId || data?.receiver_id;
      const sdp = data?.sdp;

      const targetUser = onlineUsers.get(targetUserId);
      if (targetUser) {
        const payload = { senderId: userId, sender_id: userId, sdp, targetUserId, target_user_id: targetUserId };
        emitEvents(io.to(targetUser.socketId), ['offer'], payload, targetUserId);
      }
    });

    socket.on('answer', (data) => {
      logIncomingEvent('answer', data, socket.id, userId);
      const targetUserId = data?.targetUserId || data?.target_user_id || data?.receiverId || data?.receiver_id;
      const sdp = data?.sdp;

      const targetUser = onlineUsers.get(targetUserId);
      if (targetUser) {
        const payload = { senderId: userId, sender_id: userId, sdp, targetUserId, target_user_id: targetUserId };
        emitEvents(io.to(targetUser.socketId), ['answer'], payload, targetUserId);
      }
    });

    const handleIceCandidate = (eventName) => (data) => {
      logIncomingEvent(eventName, data, socket.id, userId);
      const targetUserId = data?.targetUserId || data?.target_user_id || data?.receiverId || data?.receiver_id;
      const candidate = data?.candidate;

      const targetUser = onlineUsers.get(targetUserId);
      if (targetUser) {
        const payload = { senderId: userId, sender_id: userId, candidate, targetUserId, target_user_id: targetUserId };
        emitEvents(io.to(targetUser.socketId), ['ice_candidate', 'ice-candidate'], payload, targetUserId);
      }
    };

    socket.on('ice_candidate', handleIceCandidate('ice_candidate'));
    socket.on('ice-candidate', handleIceCandidate('ice-candidate'));

    // ----------------------------------------------------
    // SYSTEM AND CLEANUP EVENTS
    // ----------------------------------------------------

    socket.on('disconnect', () => {
      logger.info(`Socket disconnected: ${socket.id} for user: ${userId}`);

      const currentOnline = onlineUsers.get(userId);
      if (currentOnline && currentOnline.socketId !== socket.id) {
        logger.info(`Old socket ${socket.id} disconnected for ${userId}, but active socket is ${currentOnline.socketId}. Skipping cleanup.`);
        return;
      }

      updatePresence(userId, { is_online: false, last_seen: new Date().toISOString(), current_chat_id: null, is_typing: false });
      
      for (const [key, invitation] of activeCallInvitations.entries()) {
        if (invitation.callerId === userId || invitation.targetUserId === userId) {
          clearTimeout(invitation.timer);
          activeCallInvitations.delete(key);
        }
      }

      handleEndCall(io, userId);
      onlineUsers.delete(userId);
      emitEvents(socket.broadcast, ['user_offline', 'user-offline', 'user_disconnected', 'user-disconnected'], { userId }, 'ALL_BROADCAST');
    });
  });
}

function clearCallState(userAId, userBId) {
  const userA = onlineUsers.get(userAId);
  const userB = onlineUsers.get(userBId);

  if (userA) {
    userA.isBusy = false;
    userA.activeCallWith = null;
  }
  if (userB) {
    userB.isBusy = false;
    userB.activeCallWith = null;
  }
}

function handleEndCall(io, disconnectedUserId) {
  const user = onlineUsers.get(disconnectedUserId);
  if (user && user.activeCallWith) {
    const peerId = user.activeCallWith;

    let isAcceptedCall = false;
    let foundCallId = '';
    for (const [cId, session] of activeCallSessions.entries()) {
      if (session.isAccepted && 
         ((session.callerId === disconnectedUserId && session.receiverId === peerId) ||
          (session.callerId === peerId && session.receiverId === disconnectedUserId))) {
        isAcceptedCall = true;
        foundCallId = cId;
        break;
      }
    }

    if (!isAcceptedCall) {
      logger.info(`Ignoring sudden disconnect cleanup for ${disconnectedUserId}: Call invitation is not accepted yet.`);
      return;
    }

    logger.info(`Cleaning up sudden calling session between ${disconnectedUserId} and ${peerId}`);
    
    const peerUser = onlineUsers.get(peerId);
    if (peerUser) {
      peerUser.isBusy = false;
      peerUser.activeCallWith = null;
      const endPayload = {
        callId: foundCallId || '',
        call_id: foundCallId || '',
        senderId: disconnectedUserId || '',
        sender_id: disconnectedUserId || '',
        reason: 'Peer disconnected'
      };
      emitEvents(io.to(peerUser.socketId), ['call_ended', 'call-ended', 'end_call', 'end-call'], endPayload, peerId);
    }
    user.isBusy = false;
    user.activeCallWith = null;
  }
}

module.exports = {
  initSocket,
  onlineUsers
};
