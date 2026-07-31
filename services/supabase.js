const { createClient } = require('@supabase/supabase-js');
const logger = require('../utils/logger');

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ffc3hwkm53tc4xgczvre.supabase.co';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZmYzNod2ttNTN0YzR4Z2N6dnJlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MjA0MTYyMDQsImV4cCI6MjAzNTk5MjIwNH0.4v_9829424_EXAMPLE_FALLBACK';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  logger.warn('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not explicitly set in process.env, using default configured client.');
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function saveMessage(msg) {
  try {
    const now = new Date().toISOString();
    const payload = {
      id: msg.id,
      sender_id: msg.senderId || msg.sender_id,
      receiver_id: msg.receiverId || msg.receiver_id || msg.targetUserId || msg.target_user_id,
      content: msg.content || msg.messageText || msg.message || '',
      type: msg.type || msg.messageType || 'text',
      media_url: msg.mediaUrl || msg.media_url || null,
      file_name: msg.fileName || msg.file_name || null,
      file_size: msg.fileSize || msg.file_size || null,
      mime_type: msg.mimeType || msg.mime_type || null,
      duration: msg.duration || null,
      reply_to_message_id: msg.replyToMessageId || msg.reply_to_message_id || null,
      timestamp: msg.timestamp || msg.createdAt || msg.created_at || now
    };

    if (msg.seenAt || msg.seen_at) {
      payload.seen_at = msg.seenAt || msg.seen_at;
    }

    const { data, error } = await supabase.from('messages').upsert(payload, { onConflict: 'id' }).select();
    if (error) {
      logger.error(`Error saving message to Supabase: ${error.message}`);
      return null;
    }
    return data?.[0] || payload;
  } catch (err) {
    logger.error(`Exception saving message to Supabase: ${err.message}`);
    return null;
  }
}

async function markMessagesSeen(readerId, senderId) {
  try {
    const now = new Date().toISOString();
    const { error } = await supabase
      .from('messages')
      .update({ seen_at: now })
      .eq('sender_id', senderId)
      .eq('receiver_id', readerId)
      .is('seen_at', null);

    if (error) {
      logger.error(`Error marking messages seen in Supabase: ${error.message}`);
    }
  } catch (err) {
    logger.error(`Exception marking messages seen in Supabase: ${err.message}`);
  }
}

supabase.saveMessage = saveMessage;
supabase.markMessagesSeen = markMessagesSeen;

module.exports = supabase;
