const logger = require('../utils/logger');
const { getIceServers } = require('../config/iceServers');
const firebaseService = require('../services/firebase');
const supabase = require('../services/supabase');

// In-memory store of active online users:
// userId -> { socketId, userId, fullName, isBusy, activeCallWith, activeChatWithUserId }
const onlineUsers = new Map();

// In-memory store of pending call invitations:
// callerId_receiverId -> { callerId, targetUserId, isVideo, timer, callId }
const activeCallInvitations = new Map();
const activeCallSessions = new Map(); // callId -> { callerId, receiverId, callType, startTime }

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
    const fullName = socket.fullName;
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

    // Re-emit any pending incoming call invitation for this reconnecting user
    for (const invitation of activeCallInvitations.values()) {
      if (invitation.targetUserId === userId) {
        // FCM is already responsible for delivering the initial incoming call.
        // We do not rely on Socket.IO for ringing.
      }
    }

    // Notify all other clients that this user is now online
    socket.broadcast.emit('user_online', { userId, fullName });

    // Send the current list of online users to the newly connected user
    const usersList = Array.from(onlineUsers.values()).map(user => ({
      userId: user.userId,
      fullName: user.fullName,
      isBusy: user.isBusy
    }));
    socket.emit('online_users_list', usersList);

    // Relays ICE servers list to the newly connected client
    socket.emit('ice_servers', getIceServers());

    // ----------------------------------------------------
    // FCM TOKEN MANAGEMENT
    // ----------------------------------------------------

    socket.on('register_fcm_token', async (data) => {
      const { token, deviceName, platform } = data || {};
      if (token) {
        await firebaseService.registerFcmToken(userId, token, deviceName, platform);
        socket.emit('fcm_token_registered', { success: true });
      } else {
        socket.emit('fcm_token_registered', { success: false, error: 'Token is required' });
      }
    });

    socket.on('unregister_fcm_token', async (data) => {
      const { token } = data || {};
      if (token) {
        await firebaseService.removeFcmToken(userId, token);
        socket.emit('fcm_token_unregistered', { success: true });
      }
    });

    // ----------------------------------------------------
    // APP LIFECYCLE STATE TRACKING (FOREGROUND / BACKGROUND)
    // ----------------------------------------------------

    socket.on('app_state', (data) => {
      const user = onlineUsers.get(userId);
      if (user) {
        user.isForeground = !!(data && (data.isForeground === true || data.isForeground === 'true'));
        logger.info(`Updated app_state for user ${userId}: isForeground=${user.isForeground}`);
      }
    });

    socket.on('app_foreground', () => {
      const user = onlineUsers.get(userId);
      if (user) {
        user.isForeground = true;
        logger.info(`User ${userId} reported app_foreground`);
      }
    });

    socket.on('app_background', () => {
      const user = onlineUsers.get(userId);
      if (user) {
        user.isForeground = false;
        logger.info(`User ${userId} reported app_background`);
      }
    });

    // ----------------------------------------------------
    // CHAT SCREEN TRACKING (ACTIVE CONVERSATION)
    // ----------------------------------------------------

    socket.on('active_chat_open', (data) => {
      const { targetUserId } = data;
      logger.info(`User ${userId} is actively viewing chat screen with ${targetUserId}`);
      const user = onlineUsers.get(userId);
      if (user) {
        user.activeChatWithUserId = targetUserId;
      }
      updatePresence(userId, { current_chat_id: targetUserId });
    });

    socket.on('active_chat_close', () => {
      logger.info(`User ${userId} closed active chat screen.`);
      const user = onlineUsers.get(userId);
      if (user) {
        user.activeChatWithUserId = null;
      }
      updatePresence(userId, { current_chat_id: null });
    });

    socket.on('active_chat_changed', (data) => {
      const { targetUserId } = data;
      logger.info(`User ${userId} changed active chat screen to ${targetUserId || 'none'}`);
      const user = onlineUsers.get(userId);
      if (user) {
        user.activeChatWithUserId = targetUserId || null;
      }
      updatePresence(userId, { current_chat_id: targetUserId || null });
    });

    socket.on('typing', (data) => {
      const targetUserId = data?.targetUserId || data?.receiverId || data?.target_user_id;
      updatePresence(userId, { is_typing: true, current_chat_id: targetUserId });
      const targetUser = onlineUsers.get(targetUserId);
      if (targetUser) {
        io.to(targetUser.socketId).emit('typing', { senderId: userId, isTyping: true });
      }
    });

    socket.on('stop_typing', (data) => {
      const targetUserId = data?.targetUserId || data?.receiverId || data?.target_user_id;
      updatePresence(userId, { is_typing: false });
      const targetUser = onlineUsers.get(targetUserId);
      if (targetUser) {
        io.to(targetUser.socketId).emit('stop_typing', { senderId: userId, isTyping: false });
      }
    });

    socket.on('user_typing', (data) => {
      const targetUserId = data?.targetUserId || data?.receiverId || data?.target_user_id;
      updatePresence(userId, { is_typing: true, current_chat_id: targetUserId });
      const targetUser = onlineUsers.get(targetUserId);
      if (targetUser) {
        io.to(targetUser.socketId).emit('user_typing', data);
      }
    });

    socket.on('stop-typing', (data) => {
      const targetUserId = data?.targetUserId || data?.receiverId || data?.target_user_id;
      updatePresence(userId, { is_typing: false });
      const targetUser = onlineUsers.get(targetUserId);
      if (targetUser) {
        io.to(targetUser.socketId).emit('stop-typing', data);
      }
    });

    // ----------------------------------------------------
    // SOCKET.IO REALTIME MESSAGING ARCHITECTURE
    // ----------------------------------------------------

    const handleSendMessage = async (data) => {
      if (!data) return;
      const senderId = data.senderId || data.sender_id || userId;
      const receiverId = data.receiverId || data.receiver_id || data.targetUserId || data.target_user_id || data.to;
      const content = data.content || data.messageText || data.message_text || data.message || data.body || '';
      const messageType = data.messageType || data.message_type || data.type || 'text';
      const msgId = data.id || data.messageId || `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      const timestamp = data.timestamp || data.createdAt || data.created_at || new Date().toISOString();
      const senderName = data.senderName || data.sender_name || fullName || 'User';
      const senderAvatar = data.senderAvatar || data.sender_avatar || '';

      const normalizedMsg = {
        id: msgId,
        senderId,
        receiverId,
        sender_id: senderId,
        receiver_id: receiverId,
        content,
        messageText: content,
        type: messageType,
        messageType,
        mediaUrl: data.mediaUrl || data.media_url || null,
        fileName: data.fileName || data.file_name || null,
        fileSize: data.fileSize || data.file_size || null,
        mimeType: data.mimeType || data.mime_type || null,
        duration: data.duration || null,
        replyToMessageId: data.replyToMessageId || data.reply_to_message_id || null,
        timestamp,
        created_at: timestamp,
        senderName,
        senderAvatar
      };

      logger.info(`[SOCKET_MSG] Sender ${senderId} -> Receiver ${receiverId} (Type: ${messageType}, ID: ${msgId})`);

      // 1. Asynchronously save message to Supabase
      supabase.saveMessage(normalizedMsg).catch(err => {
        logger.error(`[SOCKET_MSG] Async Supabase save error: ${err.message}`);
      });

      const receiverUser = onlineUsers.get(receiverId);
      const isOnline = !!receiverUser;
      const isViewingCurrentChat = isOnline && (receiverUser.activeChatWithUserId === senderId);

      // 2. Instantly deliver to receiver if online via Socket.IO
      if (isOnline) {
        logger.info(`[SOCKET_MSG] Receiver ${receiverId} is online. Delivering via Socket.IO.`);
        io.to(receiverUser.socketId).emit('receive_message', normalizedMsg);
        io.to(receiverUser.socketId).emit('new_message', normalizedMsg);

        // 3. Emit delivered status immediately to sender
        socket.emit('message_delivered', {
          messageId: msgId,
          receiverId,
          senderId,
          deliveredAt: new Date().toISOString()
        });

        // 4. Emit seen status immediately if receiver is actively viewing chat screen
        if (isViewingCurrentChat) {
          logger.info(`[SOCKET_MSG] Receiver ${receiverId} is actively viewing chat screen. Emitting seen status immediately.`);
          socket.emit('message_seen', {
            readerId: receiverId,
            senderId,
            targetUserId: senderId,
            seenAt: new Date().toISOString()
          });
          socket.emit('message_read', {
            readerId: receiverId,
            senderId,
            targetUserId: senderId,
            seenAt: new Date().toISOString()
          });
          supabase.markMessagesSeen(receiverId, senderId).catch(err => {
            logger.error(`[SOCKET_MSG] Async markMessagesSeen error: ${err.message}`);
          });
        }
      }

      // 5. Use FCM ONLY if receiver is offline or NOT actively viewing chat
      if (!isViewingCurrentChat) {
        logger.info(`[SOCKET_MSG] Receiver ${receiverId} is offline or backgrounded. Dispatching FCM message notification.`);
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

    socket.on('send_message', handleSendMessage);
    socket.on('new_message', handleSendMessage);
    socket.on('chat_message', handleSendMessage);

    const handleMessageRead = async (data) => {
      if (!data) return;
      const readerId = data.readerId || data.reader_id || userId;
      const targetUserId = data.targetUserId || data.target_user_id || data.senderId || data.sender_id || data.receiverId;
      if (!targetUserId) return;

      logger.info(`[SOCKET_READ] Reader ${readerId} marked messages as read from ${targetUserId}`);

      // 1. Asynchronously update Supabase
      supabase.markMessagesSeen(readerId, targetUserId).catch(err => {
        logger.error(`[SOCKET_READ] Async markMessagesSeen error: ${err.message}`);
      });

      // 2. Notify sender via Socket.IO if online
      const targetUser = onlineUsers.get(targetUserId);
      if (targetUser) {
        io.to(targetUser.socketId).emit('message_read', { readerId, targetUserId, senderId: targetUserId, readAt: new Date().toISOString() });
        io.to(targetUser.socketId).emit('message_seen', { readerId, targetUserId, senderId: targetUserId, seenAt: new Date().toISOString() });
      }
    };

    socket.on('message_read', handleMessageRead);
    socket.on('messages_read', handleMessageRead);
    socket.on('message_seen', handleMessageRead);
    
    socket.on('send_friend_request', async (data) => {
      const { receiverId } = data;
      logger.info(`User ${userId} sent a friend request to ${receiverId}`);
      const receiver = onlineUsers.get(receiverId);
      if (receiver) {
        io.to(receiver.socketId).emit('friend_request', { senderId: userId, senderName: fullName });
      } else {
        await firebaseService.sendFriendRequestNotification(userId, fullName, receiverId);
      }
    });

    socket.on('accept_friend_request', async (data) => {
      const { receiverId } = data;
      logger.info(`User ${userId} accepted a friend request from ${receiverId}`);
      const receiver = onlineUsers.get(receiverId);
      if (receiver) {
        io.to(receiver.socketId).emit('friend_accepted', { senderId: userId, senderName: fullName });
      } else {
        await firebaseService.sendFriendAcceptedNotification(userId, fullName, receiverId);
      }
    });

    socket.on('send_message_notification', async (data) => {
      const { receiverId, messageType, messageText, conversationId } = data;
      logger.info(`User ${userId} sent a ${messageType || 'text'} message to ${receiverId}`);

      const receiverUser = onlineUsers.get(receiverId);
      const isViewingCurrentChat = receiverUser && (receiverUser.activeChatWithUserId === userId);

      if (isViewingCurrentChat) {
        logger.info(`Receiver ${receiverId} is actively viewing the conversation. Suppressing FCM notification.`);
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
    });

    // ----------------------------------------------------
    // CALL MANAGEMENT EVENTS (AUDIO & VIDEO)
    // ----------------------------------------------------

    // 1. Initiate a Call
    const handleCallUser = async (data) => {
      const { targetUserId, isVideo, callerPhoto } = data;
      logger.info(`User ${userId} is calling ${targetUserId} (Video: ${isVideo})`);

      const callId = data.callId || `call_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      const callType = isVideo ? 'video' : 'audio';
      activeCallSessions.set(callId, { callerId: userId, receiverId: targetUserId, callType, startTime: Date.now() });
      recordCall(callId, userId, targetUserId, callType, 'outgoing');

      const targetUser = onlineUsers.get(targetUserId);

      // If target is online and already busy, reject immediately
      if (targetUser && targetUser.isBusy) {
        logger.info(`Call failed: Target user ${targetUserId} is busy.`);
        recordCall(callId, userId, targetUserId, callType, 'rejected');
        activeCallSessions.delete(callId);
        socket.emit('call_rejected', { targetUserId, reason: 'busy', callId });
        return;
      }

      // Setup state for active call invitation
      const invitationKey = `${userId}_${targetUserId}`;
      
      // Clear existing invitation for this pair if any exists
      const oldInvitation = activeCallInvitations.get(invitationKey);
      if (oldInvitation) {
        clearTimeout(oldInvitation.timer);
      }

      // Setup call timeout (Missed Call detection after 45 seconds of ringing/no-answer)
      const callTimer = setTimeout(async () => {
        logger.info(`Call invitation ${callId} from ${userId} to ${targetUserId} timed out.`);
        
        recordCall(callId, userId, targetUserId, isVideo ? 'video' : 'audio', 'missed');
        activeCallSessions.delete(callId);

        // Reset states
        clearCallState(userId, targetUserId);
        activeCallInvitations.delete(invitationKey);

        // Send Missed Call FCM Notification
        await firebaseService.sendMissedCallNotification(userId, fullName, targetUserId, callId, isVideo);

        // Notify client devices
        socket.emit('call_timeout', { targetUserId, callId });
        const targetUserObj = onlineUsers.get(targetUserId);
        if (targetUserObj) {
          io.to(targetUserObj.socketId).emit('call_timeout', { callerId: userId, callId });
        }
      }, 45000);

      activeCallInvitations.set(invitationKey, {
        callerId: userId,
        targetUserId,
        isVideo,
        timer: callTimer,
        callId
      });

      // Mark caller as busy (receiver becomes busy when they accept)
      const callerUser = onlineUsers.get(userId);
      if (callerUser) {
        callerUser.isBusy = true;
        callerUser.activeCallWith = targetUserId;
      }

      // Check if target user is currently in foreground
      const isTargetInForeground = !!(targetUser && targetUser.isForeground !== false);
      logger.info(`[CALL_ROUTING] Target user ${targetUserId}: online=${!!targetUser}, isForeground=${targetUser ? targetUser.isForeground : 'N/A'} => isTargetInForeground=${isTargetInForeground}`);

      if (isTargetInForeground) {
        // Receiver is FOREGROUND: deliver through Socket.IO ONLY
        logger.info(`[SOCKET_CALL] Target user ${targetUserId} is in FOREGROUND. Emitting incoming_call via Socket.IO ONLY.`);
        io.to(targetUser.socketId).emit('incoming_call', {
          callerId: userId,
          callerName: fullName,
          callerPhoto: callerPhoto || '',
          isVideo,
          callId,
          targetUserId
        });
      } else {
        // Receiver is BACKGROUND or TERMINATED: deliver through FCM ONLY
        logger.info(`[FCM_CALL] Target user ${targetUserId} is in BACKGROUND or TERMINATED. Sending FCM notification ONLY.`);
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

    socket.on('call_user', handleCallUser);
    socket.on('call-user', handleCallUser);

    // 2. Ringing Signal
    socket.on('ringing', (data) => {
      const { callerId, callId } = data;
      logger.info(`Receiver ${userId} is ringing for caller ${callerId}`);
      
      const callerUser = onlineUsers.get(callerId);
      if (callerUser) {
        io.to(callerUser.socketId).emit('ringing', { receiverId: userId, callId });
      }
    });

    // 3. Accept Call
    socket.on('accept_call', (data) => {
      const callerId = data.callerId || data.targetUserId;
      const { callId } = data;
      logger.info(`User ${userId} accepted call from ${callerId}`);

      const session = activeCallSessions.get(callId) || { callerId, receiverId: userId, callType: 'audio', startTime: Date.now() };
      session.isAccepted = true;
      activeCallSessions.set(callId, session);
      recordCall(callId, session.callerId, session.receiverId, session.callType, 'accepted');

      // Clear the call timer
      const invitationKey = `${callerId}_${userId}`;
      const invitation = activeCallInvitations.get(invitationKey);
      if (invitation) {
        clearTimeout(invitation.timer);
        activeCallInvitations.delete(invitationKey);
      }

      // Mark both receiver and caller as busy on call accept
      const receiverUser = onlineUsers.get(userId);
      if (receiverUser) {
        receiverUser.isBusy = true;
        receiverUser.activeCallWith = callerId;
      }

      const callerUser = onlineUsers.get(callerId);
      if (callerUser) {
        callerUser.isBusy = true;
        callerUser.activeCallWith = userId;
        io.to(callerUser.socketId).emit('call_accepted', { receiverId: userId, callId });
      } else {
        // If caller disconnected in the meantime, clean up the receiver's state
        const receiverUser = onlineUsers.get(userId);
        if (receiverUser) {
          receiverUser.isBusy = false;
          receiverUser.activeCallWith = null;
        }
        socket.emit('call_ended', { reason: 'Caller disconnected', callId });
      }
    });

    // 4. Reject Call
    socket.on('reject_call', async (data) => {
      const callerId = data.callerId || data.targetUserId;
      const { reason, callId } = data;
      logger.info(`User ${userId} rejected call from ${callerId}. Reason: ${reason || 'declined'}`);

      const session = activeCallSessions.get(callId) || { callerId, receiverId: userId, callType: 'audio' };
      recordCall(callId, session.callerId || callerId, session.receiverId || userId, session.callType || 'audio', 'rejected');
      activeCallSessions.delete(callId);

      // Clear the call timer
      const invitationKey = `${callerId}_${userId}`;
      const invitation = activeCallInvitations.get(invitationKey);
      if (invitation) {
        clearTimeout(invitation.timer);
        activeCallInvitations.delete(invitationKey);
      }

      // Reset states
      clearCallState(userId, callerId);

      const callerUser = onlineUsers.get(callerId);
      if (callerUser) {
        io.to(callerUser.socketId).emit('call_rejected', {
          receiverId: userId,
          reason: reason || 'declined',
          callId
        });
      } else {
        // Peer is offline, send FCM
        await firebaseService.sendCallRejectedNotification(userId, fullName, callerId, callId, reason);
      }
    });

    // 5. Busy Signal
    socket.on('busy', (data) => {
      const callerId = data.callerId || data.targetUserId;
      const { callId } = data;
      logger.info(`User ${userId} returned busy status to ${callerId}`);
      
      const session = activeCallSessions.get(callId) || { callerId, receiverId: userId, callType: 'audio' };
      recordCall(callId, session.callerId || callerId, session.receiverId || userId, session.callType || 'audio', 'rejected');
      activeCallSessions.delete(callId);

      // Clear the call timer
      const invitationKey = `${callerId}_${userId}`;
      const invitation = activeCallInvitations.get(invitationKey);
      if (invitation) {
        clearTimeout(invitation.timer);
        activeCallInvitations.delete(invitationKey);
      }

      clearCallState(userId, callerId);

      const callerUser = onlineUsers.get(callerId);
      if (callerUser) {
        io.to(callerUser.socketId).emit('call_rejected', {
          receiverId: userId,
          reason: 'busy',
          callId
        });
      }
    });

    // 6. Cancel Call (Caller cancels before receiver answers)
    socket.on('cancel_call', async (data) => {
      const { targetUserId, callId } = data;
      logger.info(`Caller ${userId} cancelled call to ${targetUserId}`);

      const session = activeCallSessions.get(callId) || { callerId: userId, receiverId: targetUserId, callType: 'audio' };
      recordCall(callId, session.callerId || userId, session.receiverId || targetUserId, session.callType || 'audio', 'cancelled');
      activeCallSessions.delete(callId);

      // Clear the call timer
      const invitationKey = `${userId}_${targetUserId}`;
      const invitation = activeCallInvitations.get(invitationKey);
      if (invitation) {
        clearTimeout(invitation.timer);
        activeCallInvitations.delete(invitationKey);
      }

      clearCallState(userId, targetUserId);

      const targetUser = onlineUsers.get(targetUserId);
      if (targetUser) {
        io.to(targetUser.socketId).emit('call_cancelled', { callerId: userId, callId });
      } else {
        // Dispatch call_cancelled FCM notification only if peer is offline or backgrounded
        await firebaseService.sendCallCancelledNotification(userId, fullName, targetUserId, callId);
      }
    });

    // 7. End Call (Either participant terminates connected call)
    socket.on('end_call', (data) => {
      const { targetUserId, callId } = data;
      logger.info(`User ${userId} ended call with ${targetUserId}`);

      const session = activeCallSessions.get(callId) || { callerId: userId, receiverId: targetUserId, callType: 'audio', startTime: Date.now() };
      const durationSeconds = session.startTime ? Math.floor((Date.now() - session.startTime) / 1000) : 0;
      recordCall(callId, session.callerId || userId, session.receiverId || targetUserId, session.callType || 'audio', 'ended', durationSeconds);
      activeCallSessions.delete(callId);

      // Clear timers if present
      const invitationKeyA = `${userId}_${targetUserId}`;
      const invitationKeyB = `${targetUserId}_${userId}`;
      const invitationA = activeCallInvitations.get(invitationKeyA);
      const invitationB = activeCallInvitations.get(invitationKeyB);

      if (invitationA) {
        clearTimeout(invitationA.timer);
        activeCallInvitations.delete(invitationKeyA);
      }
      if (invitationB) {
        clearTimeout(invitationB.timer);
        activeCallInvitations.delete(invitationKeyB);
      }

      clearCallState(userId, targetUserId);

      const targetUser = onlineUsers.get(targetUserId);
      if (targetUser) {
        io.to(targetUser.socketId).emit('call_ended', { senderId: userId, callId });
      }
    });

    // ----------------------------------------------------
    // WEBRTC SIGNALING RELAYS (OFFER, ANSWER, ICE)
    // ----------------------------------------------------

    const handleOffer = (data) => {
      const targetUserId = data?.targetUserId || data?.target_user_id || data?.receiverId || data?.receiver_id;
      const sdp = data?.sdp;
      logger.info(`Relaying WebRTC OFFER from ${userId} to ${targetUserId}. SDP length: ${sdp?.length}`);

      if (!targetUserId) return;
      const targetUser = onlineUsers.get(targetUserId);
      if (targetUser) {
        io.to(targetUser.socketId).emit('offer', {
          senderId: userId,
          sdp
        });
        io.to(targetUser.socketId).emit('sdp_offer', {
          senderId: userId,
          sdp
        });
      } else {
        logger.info(`Failed to relay OFFER: Target user ${targetUserId} not found.`);
      }
    };
    socket.on('offer', handleOffer);
    socket.on('sdp_offer', handleOffer);

    const handleAnswer = (data) => {
      const targetUserId = data?.targetUserId || data?.target_user_id || data?.receiverId || data?.receiver_id;
      const sdp = data?.sdp;
      logger.info(`Relaying WebRTC ANSWER from ${userId} to ${targetUserId}. SDP length: ${sdp?.length}`);

      if (!targetUserId) return;
      const targetUser = onlineUsers.get(targetUserId);
      if (targetUser) {
        io.to(targetUser.socketId).emit('answer', {
          senderId: userId,
          sdp
        });
        io.to(targetUser.socketId).emit('sdp_answer', {
          senderId: userId,
          sdp
        });
      } else {
        logger.info(`Failed to relay ANSWER: Target user ${targetUserId} not found.`);
      }
    };
    socket.on('answer', handleAnswer);
    socket.on('sdp_answer', handleAnswer);

    const handleIceCandidate = (data) => {
      const targetUserId = data?.targetUserId || data?.target_user_id || data?.receiverId || data?.receiver_id;
      const candidate = data?.candidate;
      logger.info(`Relaying ICE Candidate from ${userId} to ${targetUserId}. Candidate: ${JSON.stringify(candidate)}`);

      if (!targetUserId) return;
      const targetUser = onlineUsers.get(targetUserId);
      if (targetUser) {
        io.to(targetUser.socketId).emit('ice_candidate', {
          senderId: userId,
          candidate
        });
        io.to(targetUser.socketId).emit('ice-candidate', {
          senderId: userId,
          candidate
        });
      } else {
        logger.info(`Failed to relay ICE Candidate: Target user ${targetUserId} not found.`);
      }
    };
    socket.on('ice_candidate', handleIceCandidate);
    socket.on('ice-candidate', handleIceCandidate);

    // ----------------------------------------------------
    // SYSTEM AND CLEANUP EVENTS
    // ----------------------------------------------------

    socket.on('disconnect', () => {
      logger.info(`Socket disconnected: ${socket.id} for user: ${userId}`);

      // If this socket is not the currently active socket for the user (e.g., replaced by reconnect), skip
      const currentOnline = onlineUsers.get(userId);
      if (currentOnline && currentOnline.socketId !== socket.id) {
        logger.info(`Old socket ${socket.id} disconnected for ${userId}, but active socket is ${currentOnline.socketId}. Skipping cleanup.`);
        return;
      }

      updatePresence(userId, { is_online: false, last_seen: new Date().toISOString(), current_chat_id: null, is_typing: false });
      
      // Clean up call invite timers related to this user
      for (const [key, invitation] of activeCallInvitations.entries()) {
        if (invitation.callerId === userId || invitation.targetUserId === userId) {
          clearTimeout(invitation.timer);
          activeCallInvitations.delete(key);
        }
      }

      // Clean up active calling status of the peer, if any
      handleEndCall(io, userId);

      // Remove from active online list
      onlineUsers.delete(userId);

      // Broadcast offline presence
      socket.broadcast.emit('user_offline', { userId });
    });
  });
}

/**
 * Clean up call states for two users
 */
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

/**
 * End an ongoing call session for a user who disconnected suddenly or reconnected
 */
function handleEndCall(io, disconnectedUserId) {
  const user = onlineUsers.get(disconnectedUserId);
  if (user && user.activeCallWith) {
    const peerId = user.activeCallWith;

    // Check if there is an accepted active call session
    let isAcceptedCall = false;
    for (const session of activeCallSessions.values()) {
      if (session.isAccepted && 
         ((session.callerId === disconnectedUserId && session.receiverId === peerId) ||
          (session.callerId === peerId && session.receiverId === disconnectedUserId))) {
        isAcceptedCall = true;
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
      io.to(peerUser.socketId).emit('call_ended', {
        senderId: disconnectedUserId,
        reason: 'Peer disconnected'
      });
    }
    user.isBusy = false;
    user.activeCallWith = null;
  }
}

module.exports = {
  initSocket,
  onlineUsers
};
