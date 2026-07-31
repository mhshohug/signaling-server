const supabase = require('./supabase');
const { sendLoveAutoVoiceNotification } = require('./firebase');
const logger = require('../utils/logger');

let schedulerInterval = null;

function initScheduler() {
  logger.info('Initializing Love Auto Voice Scheduler (runs every 1 minute)...');
  
  // Run immediately on start, then every 60 seconds
  processPendingScheduledVoices();
  schedulerInterval = setInterval(() => {
    processPendingScheduledVoices();
  }, 60000);
}

async function processPendingScheduledVoices() {
  try {
    const nowEpoch = Date.now();
    const nowIso = new Date().toISOString();

    // 1. Query pending scheduled voices where scheduled_at <= now
    const { data: messages, error } = await supabase
      .from('scheduled_voice_messages')
      .select('*')
      .eq('status', 'pending')
      .lte('scheduled_at', nowIso);

    if (error) {
      logger.error(`Scheduler query error: ${error.message}`);
      return;
    }

    if (!messages || messages.length === 0) {
      return;
    }

    logger.info(`Found ${messages.length} pending scheduled voice message(s) to process.`);

    for (const msg of messages) {
      try {
        const bdtTime = new Date().toLocaleString("en-US", { timeZone: "Asia/Dhaka" });
        const serverTime = new Date().toISOString();
        
        logger.info(`[Voice Schedule Processing] ID: ${msg.id}`);
        logger.info(`  - Current server time: ${serverTime}`);
        logger.info(`  - Current Bangladesh time: ${bdtTime}`);
        logger.info(`  - scheduled_at: ${msg.scheduled_at}`);

        // Prevent duplicate processing / concurrency: atomically mark as 'sent'
        const { data: updated, error: lockErr } = await supabase
          .from('scheduled_voice_messages')
          .update({ status: 'sent', updated_at: nowIso })
          .eq('id', msg.id)
          .eq('status', 'pending')
          .select()
          .maybeSingle();

        if (lockErr || !updated) {
          logger.warn(`  - Status transition: Lock failed for ${msg.id}, skipping...`);
          continue;
        }

        logger.info(`  - Status transition: pending -> sent (Locked for processing)`);

        const senderId = msg.sender_id;
        const receiverId = msg.receiver_id;

        // 2. Verify love_permissions.status == 'accepted' still exists between sender and receiver
        const { data: permData, error: permErr } = await supabase
          .from('love_permissions')
          .select('*')
          .or(`and(requester_id.eq.${senderId},target_id.eq.${receiverId}),and(requester_id.eq.${receiverId},target_id.eq.${senderId})`)
          .eq('status', 'accepted')
          .maybeSingle();

        if (permErr || !permData) {
          logger.warn(`  - Love Permission status: Not accepted (Missing or revoked). Cancelling.`);
          await supabase
            .from('scheduled_voice_messages')
            .update({ status: 'cancelled', updated_at: nowIso })
            .eq('id', msg.id);
          logger.info(`  - Status transition: sent -> cancelled`);
          continue;
        }

        logger.info(`  - Love Permission status: accepted`);

        // 3. Fetch sender details (name, avatar)
        let senderName = 'User';
        let senderAvatar = '';
        const { data: senderUser } = await supabase
          .from('users')
          .select('full_name, photo_url, email')
          .eq('firebase_uid', senderId)
          .maybeSingle();

        if (senderUser) {
          senderName = senderUser.full_name || senderUser.email || 'User';
          senderAvatar = senderUser.photo_url || '';
        }

        // 4. Dispatch FCM
        let messageId;
        try {
          messageId = await sendLoveAutoVoiceNotification(
            senderId,
            senderName,
            senderAvatar,
            receiverId,
            msg.id,
            msg.audio_path || msg.audio_url,
            msg.scheduled_at,
            msg.timezone,
            msg.duration_seconds
          );
          logger.info(`  - FCM result: Success (Message ID: ${messageId})`);
        } catch (fcmErr) {
          throw fcmErr;
        }

        // 5. Success log (already updated to 'sent' during lock)
        await supabase
          .from('scheduled_voice_delivery_logs')
          .insert({
            schedule_id: msg.id,
            fcm_message_id: messageId,
            status: 'success',
            error: null,
            timestamp: nowIso
          });

        logger.info(`  - Delivery result: Successfully dispatched scheduled voice message ${msg.id} to receiver ${receiverId}`);

      } catch (itemErr) {
        logger.error(`  - Any error: Failed to dispatch scheduled voice message ${msg.id}: ${itemErr.message}`);

        const retryCount = (msg.retry_count || 0) + 1;
        const maxRetries = 3;
        const newStatus = retryCount >= maxRetries ? 'failed' : 'pending';

        await supabase
          .from('scheduled_voice_messages')
          .update({
            status: newStatus,
            retry_count: retryCount,
            updated_at: nowIso
          })
          .eq('id', msg.id);

        logger.info(`  - Status transition: sent -> ${newStatus} (Retry: ${retryCount}/${maxRetries})`);

        await supabase
          .from('scheduled_voice_delivery_logs')
          .insert({
            schedule_id: msg.id,
            fcm_message_id: null,
            status: 'failed',
            error: itemErr.message,
            timestamp: nowIso
          });
      }
    }
  } catch (err) {
    logger.error(`Error in processPendingScheduledVoices: ${err.message}`);
  }
}

module.exports = {
  initScheduler
};
