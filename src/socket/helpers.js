/**
 * Socket.IO helper functions.
 *
 * Shared utilities used by both the socket handlers and REST routes
 * to emit local responses, deliver moderation items, etc.
 */

const messageModel = require('../models/message');
const conversationModel = require('../models/conversation');
const ticketModel = require('../models/ticket');
const { updateChatSummary } = require('../services/summary');

/**
 * Emit a locally-generated response to a chat conversation.
 *
 * Used for responses that bypass n8n (greetings, acknowledgments,
 * escalation gates, etc.). Stores in memory, emits via socket, persists to DB.
 *
 * @param {import('socket.io').Server} io - Socket.IO server instance
 * @param {object} messageData - The original user message
 * @param {string} responseText - Bot response text
 * @param {string} category - Intent category (e.g. 'greeting', 'escalation_gate')
 * @param {string} conversationId
 * @returns {object} The emitted response message
 */
function emitLocalResponse(io, messageData, responseText, category, conversationId) {
  const responseMessage = {
    type: 'response',
    sender: 'AI Assistant',
    timestamp: new Date().toISOString(),
    text: responseText,
    messageId: messageModel.generateMessageId('resp'),
    originalMessageId: messageData.messageId,
    category,
    conversationId,
  };

  messageModel.pushMessage(responseMessage);
  messageModel.pushConversationMessage(conversationId, {
    role: 'assistant',
    message_text: responseText,
    assistant_message: responseText,
    matched_issue: category,
    messageId: responseMessage.messageId,
    created_at: responseMessage.timestamp,
  });

  updateChatSummary(conversationId, {
    user_message: messageData.text,
    assistant_message: responseText,
    matched_issue: category,
  });
  conversationModel.updateConversation(conversationId, { preview: responseText });

  if (io) io.to(conversationId).emit('responseMessage', responseMessage);

  // Persist to DB
  messageModel.saveChatMessageToDb({
    conversationId,
    messageId: responseMessage.messageId,
    role: 'assistant',
    messageText: responseText,
    intent: category,
    matchedIssue: category,
    createdAt: responseMessage.timestamp,
  });

  // Also save user turn to chat memory
  messageModel.pushMemoryEntry(conversationId, {
    role: 'user',
    message_text: messageData.text,
    user_message: messageData.text,
    user_query: messageData.text,
    intent: category,
    matched_issue: category,
    created_at: messageData.timestamp,
  });
  messageModel.pushMemoryEntry(conversationId, {
    role: 'assistant',
    message_text: responseText,
    assistant_message: responseText,
    intent: category,
    matched_issue: category,
    created_at: responseMessage.timestamp,
  });

  console.log(`🏠 Local response [${category}]: "${messageData.text}" → "${responseText.substring(0, 60)}..."`);
  return responseMessage;
}

/**
 * Deliver an approved moderation item to the chat.
 *
 * Stores the message, emits it to the conversation room,
 * and marks the ticket as awaiting user reply.
 *
 * @param {import('socket.io').Server} io
 * @param {object} item - The moderation item to deliver
 * @returns {object} The delivered response message
 */
function deliverModerationItem(io, item) {
  const responseMessage = {
    type: 'response',
    sender: item.sender,
    timestamp: item.timestamp,
    text: item.text,
    messageId: item.messageId,
    originalMessageId: item.originalMessageId,
    category: item.category,
    conversationId: item.conversationId,
    ticket_id: item.ticket_id,
    teamsMessageId: item.teamsMessageId,
    replyToMessageId: item.replyToMessageId,
  };

  messageModel.pushMessage(responseMessage);

  if (responseMessage.conversationId) {
    messageModel.pushConversationMessage(responseMessage.conversationId, {
      role: 'assistant',
      message_text: item.text,
      assistant_message: item.text,
      matched_issue: item.category || null,
      ticket_id: item.ticket_id || null,
      teamsMessageId: item.teamsMessageId,
      replyToMessageId: item.replyToMessageId,
      messageId: item.messageId,
      created_at: item.timestamp,
    });

    updateChatSummary(responseMessage.conversationId, {
      assistant_message: item.text,
      matched_issue: item.category || null,
      ticket_id: item.ticket_id || null,
    });

    conversationModel.updateConversation(responseMessage.conversationId, { preview: item.text });

    // Mark ticket as awaiting user reply (back-and-forth flow)
    const awaitingId = ticketModel.markTicketAwaitingUserReply(item.conversationId, item.ticket_id);
    if (awaitingId) {
      console.log(`⏳ Ticket ${awaitingId} marked awaiting_user_reply via deliverModerationItem`);
    }

    if (io) io.to(responseMessage.conversationId).emit('responseMessage', responseMessage);
  }

  return responseMessage;
}

module.exports = {
  emitLocalResponse,
  deliverModerationItem,
};
