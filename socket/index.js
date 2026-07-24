const logger = require('../utils/logger');
const { getIceServers } = require('../config/iceServers');
const firebaseService = require('../services/firebase');

// In-memory store of active online users:
// userId -> { socketId, userId, fullName, isBusy, activeCallWith, activeChatWithUserId }
const onlineUsers = new Map();

// In-memory store of pending call invitations:
// callerId_receiverId -> { callerId, targetUserId, isVideo, timer, callId }
const activeCallInvitations = new Map();

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
      
      // End any call the older socket was engaged in
      handleEndCall(io, userId);
      
      const oldSocket = io.sockets.sockets.get(existingUser.socketId);
      if (oldSocket) {
        oldSocket.emit('force_disconnect', { message: 'Logged in from another device' });
        oldSocket.disconnect(true);
      }
    }

    // Register user as active and available
    onlineUsers.set(userId, {
      socketId: socket.id,
      userId,
      fullName,
      isBusy: false,
      activeCallWith: null,
      activeChatWithUserId: null
    });

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
  logger.info(`register_fcm_token received from ${userId}: ${JSON.stringify(data)}`);

  const { token, deviceName, platform } = data || {};

  if (token) {
    logger.info(`Registering FCM token for ${userId}`);

    await firebaseService.registerFcmToken(userId, token, deviceName, platform);

    logger.info(`registerFcmToken() finished for ${userId}`);

    socket.emit('fcm_token_registered', { success: true });
  } else {
    logger.warn(`register_fcm_token received without token from ${userId}`);

    socket.emit('fcm_token_registered', {
      success: false,
      error: 'Token is required'
    });
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
    });

    socket.on('active_chat_close', () => {
      logger.info(`User ${userId} closed active chat screen.`);
      const user = onlineUsers.get(userId);
      if (user) {
        user.activeChatWithUserId = null;
      }
    });

    socket.on('active_chat_changed', (data) => {
      const { targetUserId } = data;
      logger.info(`User ${userId} changed active chat screen to ${targetUserId || 'none'}`);
      const user = onlineUsers.get(userId);
      if (user) {
        user.activeChatWithUserId = targetUserId || null;
      }
    });

    // ----------------------------------------------------
    // CHAT MESSAGES NOTIFICATION DISPATCH
    // ----------------------------------------------------

    socket.on('send_message_notification', async (data) => {
      const { receiverId, messageType, messageText, conversationId } = data;
      logger.info(`User ${userId} sent a ${messageType || 'text'} message to ${receiverId}`);

      const receiverUser = onlineUsers.get(receiverId);

      // Check if receiver is online and has the conversation actively open
      const isViewingCurrentChat = receiverUser && (receiverUser.activeChatWithUserId === userId);

      if (isViewingCurrentChat) {
        logger.info(`Receiver ${receiverId} is actively viewing the conversation. Suppressing FCM notification.`);
        // Message is delivered via Supabase Realtime directly to client; no signaling server action needed.
        return;
      }

      // Otherwise, receiver is offline, inside app on another screen, backgrounded, or terminated.
      // Dispatch FCM message notification immediately.
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
    socket.on('call_user', async (data) => {
      const { targetUserId, isVideo, callerPhoto } = data;
      logger.info(`User ${userId} is calling ${targetUserId} (Video: ${isVideo})`);

      const callId = data.callId || `call_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      const targetUser = onlineUsers.get(targetUserId);

      // If target is online and already busy, reject immediately
      if (targetUser && targetUser.isBusy) {
        logger.info(`Call failed: Target user ${targetUserId} is busy.`);
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

      // Mark both caller and target as busy
      const callerUser = onlineUsers.get(userId);
      if (callerUser) {
        callerUser.isBusy = true;
        callerUser.activeCallWith = targetUserId;
      }

      if (targetUser) {
        targetUser.isBusy = true;
        targetUser.activeCallWith = userId;

        // Relay live socket incoming call signal to target
        io.to(targetUser.socketId).emit('incoming_call', {
          callerId: userId,
          callerName: fullName,
          callerPhoto: callerPhoto || '',
          isVideo,
          callId
        });
      }

      // Always trigger high-priority FCM notification so Android client gets call background wake-up
      await firebaseService.sendIncomingCallNotification(
        userId,
        fullName,
        callerPhoto || '',
        isVideo,
        callId,
        targetUserId
      );
    });

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
      const { callerId, callId } = data;
      logger.info(`User ${userId} accepted call from ${callerId}`);

      // Clear the call timer
      const invitationKey = `${callerId}_${userId}`;
      const invitation = activeCallInvitations.get(invitationKey);
      if (invitation) {
        clearTimeout(invitation.timer);
        activeCallInvitations.delete(invitationKey);
      }

      const callerUser = onlineUsers.get(callerId);
      if (callerUser) {
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
    socket.on('reject_call', (data) => {
      const { callerId, reason, callId } = data;
      logger.info(`User ${userId} rejected call from ${callerId}. Reason: ${reason || 'declined'}`);

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
      }
    });

    // 5. Busy Signal
    socket.on('busy', (data) => {
      const { callerId, callId } = data;
      logger.info(`User ${userId} returned busy status to ${callerId}`);
      
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
      }

      // Always dispatch call_cancelled FCM notification so peer can stop ringtone
      await firebaseService.sendCallCancelledNotification(userId, fullName, targetUserId, callId);
    });

    // 7. End Call (Either participant terminates connected call)
    socket.on('end_call', (data) => {
      const { targetUserId, callId } = data;
      logger.info(`User ${userId} ended call with ${targetUserId}`);

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

    socket.on('offer', (data) => {
      const { targetUserId, sdp } = data;
      logger.debug(`Relaying WebRTC OFFER from ${userId} to ${targetUserId}`);

      const targetUser = onlineUsers.get(targetUserId);
      if (targetUser) {
        io.to(targetUser.socketId).emit('offer', {
          senderId: userId,
          sdp
        });
      }
    });

    socket.on('answer', (data) => {
      const { targetUserId, sdp } = data;
      logger.debug(`Relaying WebRTC ANSWER from ${userId} to ${targetUserId}`);

      const targetUser = onlineUsers.get(targetUserId);
      if (targetUser) {
        io.to(targetUser.socketId).emit('answer', {
          senderId: userId,
          sdp
        });
      }
    });

    socket.on('ice_candidate', (data) => {
      const { targetUserId, candidate } = data;
      logger.debug(`Relaying ICE Candidate from ${userId} to ${targetUserId}`);

      const targetUser = onlineUsers.get(targetUserId);
      if (targetUser) {
        io.to(targetUser.socketId).emit('ice_candidate', {
          senderId: userId,
          candidate
        });
      }
    });

    // ----------------------------------------------------
    // SYSTEM AND CLEANUP EVENTS
    // ----------------------------------------------------

    socket.on('disconnect', () => {
      logger.info(`Socket disconnected: ${socket.id} for user: ${userId}`);
      
      // Clean up call invite timers related to this user
      const invitationKeyA = `${userId}_${socket.activeCallWith}`;
      const invitationKeyB = `${socket.activeCallWith}_${userId}`;

      const invitationA = activeCallInvitations.get(invitationKeyA);
      if (invitationA) {
        clearTimeout(invitationA.timer);
        activeCallInvitations.delete(invitationKeyA);
      }
      const invitationB = activeCallInvitations.get(invitationKeyB);
      if (invitationB) {
        clearTimeout(invitationB.timer);
        activeCallInvitations.delete(invitationKeyB);
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
