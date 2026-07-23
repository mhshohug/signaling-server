const logger = require('../utils/logger');
const { getIceServers } = require('../config/iceServers');

// In-memory store of active online users: userId -> { socketId, userId, fullName, isBusy, activeCallWith }
const onlineUsers = new Map();

function initSocket(io) {
  io.on('connection', (socket) => {
    const { userId, fullName } = socket;
    logger.info(`User connected: ${userId} (${fullName}) with socket ID: ${socket.id}`);

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
      activeCallWith: null
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
    // CALL MANAGEMENT EVENTS
    // ----------------------------------------------------

    // 1. Initiate a Call
    socket.on('call_user', (data) => {
      const { targetUserId, isVideo } = data;
      logger.info(`User ${userId} is calling ${targetUserId} (Video: ${isVideo})`);

      const targetUser = onlineUsers.get(targetUserId);

      if (!targetUser) {
        logger.warn(`Call failed: Target user ${targetUserId} is offline.`);
        socket.emit('user_offline', { targetUserId });
        return;
      }

      if (targetUser.isBusy) {
        logger.info(`Call failed: Target user ${targetUserId} is busy.`);
        socket.emit('call_rejected', { targetUserId, reason: 'busy' });
        return;
      }

      // Mark both caller and target as busy
      const callerUser = onlineUsers.get(userId);
      if (callerUser) {
        callerUser.isBusy = true;
        callerUser.activeCallWith = targetUserId;
      }
      targetUser.isBusy = true;
      targetUser.activeCallWith = userId;

      // Notify target of the incoming call
      io.to(targetUser.socketId).emit('incoming_call', {
        callerId: userId,
        callerName: fullName,
        isVideo
      });
    });

    // 2. Ringing Signal
    socket.on('ringing', (data) => {
      const { callerId } = data;
      logger.info(`Receiver ${userId} is ringing for caller ${callerId}`);
      
      const callerUser = onlineUsers.get(callerId);
      if (callerUser) {
        io.to(callerUser.socketId).emit('ringing', { receiverId: userId });
      }
    });

    // 3. Accept Call
    socket.on('accept_call', (data) => {
      const { callerId } = data;
      logger.info(`User ${userId} accepted call from ${callerId}`);

      const callerUser = onlineUsers.get(callerId);
      if (callerUser) {
        io.to(callerUser.socketId).emit('call_accepted', { receiverId: userId });
      } else {
        // If caller disconnected in the meantime, clean up the receiver's state
        const receiverUser = onlineUsers.get(userId);
        if (receiverUser) {
          receiverUser.isBusy = false;
          receiverUser.activeCallWith = null;
        }
        socket.emit('call_ended', { reason: 'Caller disconnected' });
      }
    });

    // 4. Reject Call
    socket.on('reject_call', (data) => {
      const { callerId, reason } = data;
      logger.info(`User ${userId} rejected call from ${callerId}. Reason: ${reason || 'declined'}`);

      // Reset states
      clearCallState(userId, callerId);

      const callerUser = onlineUsers.get(callerId);
      if (callerUser) {
        io.to(callerUser.socketId).emit('call_rejected', {
          receiverId: userId,
          reason: reason || 'declined'
        });
      }
    });

    // 5. Busy Signal
    socket.on('busy', (data) => {
      const { callerId } = data;
      logger.info(`User ${userId} returned busy status to ${callerId}`);
      
      clearCallState(userId, callerId);

      const callerUser = onlineUsers.get(callerId);
      if (callerUser) {
        io.to(callerUser.socketId).emit('call_rejected', {
          receiverId: userId,
          reason: 'busy'
        });
      }
    });

    // 6. Cancel Call (Caller cancels before receiver answers)
    socket.on('cancel_call', (data) => {
      const { targetUserId } = data;
      logger.info(`Caller ${userId} cancelled call to ${targetUserId}`);

      clearCallState(userId, targetUserId);

      const targetUser = onlineUsers.get(targetUserId);
      if (targetUser) {
        io.to(targetUser.socketId).emit('call_cancelled', { callerId: userId });
      }
    });

    // 7. End Call (Either participant terminates connected call)
    socket.on('end_call', (data) => {
      const { targetUserId } = data;
      logger.info(`User ${userId} ended call with ${targetUserId}`);

      clearCallState(userId, targetUserId);

      const targetUser = onlineUsers.get(targetUserId);
      if (targetUser) {
        io.to(targetUser.socketId).emit('call_ended', { senderId: userId });
      }
    });

    // ----------------------------------------------------
    // WEBRTC SIGNALING RELAYS (OFFER, ANSWER, ICE)
    // ----------------------------------------------------

    // Relay Offer
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

    // Relay Answer
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

    // Relay ICE Candidate
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

    // Handle user disconnect
    socket.on('disconnect', () => {
      logger.info(`Socket disconnected: ${socket.id} for user: ${userId}`);
      
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
  initSocket
};
