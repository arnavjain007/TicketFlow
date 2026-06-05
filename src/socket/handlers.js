/**
 * Socket.IO event handlers.
 *
 * Manages real-time WebSocket connections: user message handling,
 * active-ticket back-and-forth flow, local intent pre-classification,
 * escalation gating, and room management.
 */

const messageModel = require('../models/message');
const conversationModel = require('../models/conversation');
const ticketModel = require('../models/ticket');
const { classifyLocalIntent, isEscalationRequest } = require('../services/intent');
const { classifyTicketIntent, generateClarificationResponse } = require('../services/llm');
const { checkEscalationGate } = require('../services/escalation');
const { updateChatSummary } = require('../services/summary');
const n8nService = require('../services/n8n');
const teamsService = require('../services/teams');
const { getChatSummary } = require('../services/summary');
const { emitLocalResponse } = require('./helpers');

// Track active users
let activeUsers = 0;

/**
 * Get the current active user count.
 */
function getActiveUsers() {
  return activeUsers;
}

/**
 * Register all Socket.IO event handlers.
 *
 * @param {import('socket.io').Server} io
 */
function registerHandlers(io) {
  io.on('connection', (socket) => {
    activeUsers++;
    io.emit('activeUsers', activeUsers);

    // ── Send message ─────────────────────────────────────────────────────
    socket.on('sendMessage', async (data) => {
      try {
        const messageData = {
          type: 'message',
          sender: data.sender || 'Anonymous',
          conversationId: data.conversationId || data.sender || socket.id,
          timestamp: new Date().toISOString(),
          text: data.text || '',
          file_url: data.file_url || null,
          file_type: data.file_type || null,
          file_name: data.file_name || null,
          messageId: messageModel.generateMessageId(),
        };

        messageModel.pushMessage(messageData);
        messageModel.pushConversationMessage(messageData.conversationId, {
          role: 'user',
          message_text: messageData.text,
          user_message: messageData.text,
          user_query: messageData.text,
          file_url: messageData.file_url,
          file_type: messageData.file_type,
          file_name: messageData.file_name,
          messageId: messageData.messageId,
          created_at: messageData.timestamp,
        });

        const existingConvo = conversationModel.findConversation(messageData.conversationId);
        if (existingConvo) {
          conversationModel.updateConversation(messageData.conversationId, {
            preview: messageData.text || messageData.file_name || 'Attachment',
          });
        }

        io.to(messageData.conversationId).emit('newMessage', messageData);

        // ── Active ticket back-and-forth flow ──
        const activeTicket = ticketModel.findActiveTicketForConversation(messageData.conversationId);
        if (activeTicket && messageData.text) {
          await handleActiveTicketMessage(io, socket, messageData, activeTicket);
          return;
        }

        // ── Local pre-classifier ──
        if (messageData.text && !messageData.file_url) {
          if (isEscalationRequest(messageData.text)) {
            const gate = checkEscalationGate(messageData.conversationId);
            if (gate.gated) {
              emitLocalResponse(io, messageData, gate.response, 'escalation_gate', messageData.conversationId);
              return;
            }
          }

          const localIntent = classifyLocalIntent(messageData.text);
          if (localIntent.matched) {
            emitLocalResponse(io, messageData, localIntent.response, localIntent.category, messageData.conversationId);
            return;
          }
        }

        // No local match — forward to n8n and deliver synchronous response
        const n8nResponse = await n8nService.sendToN8n(messageData);
        if (n8nResponse) {
          const responseText = n8nResponse.response || n8nResponse.message || n8nResponse.text || '';
          if (responseText) {
            const category = n8nResponse.category || n8nResponse.intent || 'support_chat';
            emitLocalResponse(io, messageData, responseText, category, messageData.conversationId);
          }
        }
      } catch (error) {
        console.error('❌ Error sending message:', error.message);
        socket.emit('error', { message: 'Failed to send message' });
      }
    });

    // ── Room management ──────────────────────────────────────────────────
    socket.on('joinConversation', (conversationId) => {
      if (!conversationId) return;
      socket.join(conversationId);
    });

    socket.on('switchConversation', ({ oldConversationId, newConversationId }) => {
      if (oldConversationId) socket.leave(oldConversationId);
      if (newConversationId) socket.join(newConversationId);
    });

    socket.on('typing', (data) => {
      socket.broadcast.emit('userTyping', {
        sender: data.sender,
        isTyping: data.isTyping,
      });
    });

    socket.on('disconnect', () => {
      activeUsers--;
      io.emit('activeUsers', activeUsers);
    });
  });
}

// ── Active ticket message handler ────────────────────────────────────────────

/**
 * Handle a user message when there's an active (non-resolved) ticket.
 * Manages the stateful back-and-forth: resolution confirmation,
 * follow-up details, casual ack, clarification, status inquiry, etc.
 */
async function handleActiveTicketMessage(io, socket, messageData, activeTicket) {
  console.log(`🔄 Active ticket detected: ${activeTicket.id} (status: ${activeTicket.status})`);
  updateChatSummary(messageData.conversationId, { user_message: messageData.text });

  const convId = messageData.conversationId;

  // ── STATE: awaiting_resolution_confirmation ──
  if (activeTicket.status === 'awaiting_resolution_confirmation') {
    const resolutionIntent = await classifyTicketIntent(messageData.text, 'resolution_check');
    console.log(`🔍 Resolution intent for "${messageData.text}": ${resolutionIntent}`);

    if (resolutionIntent === 'positive') {
      ticketModel.closeTicket(activeTicket.id);
      emitTicketResponse(io, messageData, convId, activeTicket.id,
        "Glad I could help! Your ticket has been resolved. Feel free to reach out if you need anything else.",
        'ticket_resolved');
      return;
    }

    if (resolutionIntent === 'negative') {
      activeTicket.status = 'awaiting_followup_details';
      activeTicket.updated_at = new Date().toISOString();
      ticketModel.saveTicketToDb(activeTicket);
      emitTicketResponse(io, messageData, convId, activeTicket.id,
        "Could you please describe what's still not working or what issue you're facing? This will help the support team assist you better.",
        'followup_details_request');
      return;
    }

    // Substantive or other — forward to Teams
    ticketModel.saveFollowupTicket(activeTicket, messageData.text, convId);
    activeTicket.status = 'awaiting_agent_reply';
    ticketModel.saveTicketToDb(activeTicket);
    const chatSummary = getChatSummary(convId);
    await teamsService.sendFollowupNotification(activeTicket, messageData, chatSummary);
    emitTicketResponse(io, messageData, convId, activeTicket.id,
      "I've shared your follow-up with the support team. They'll get back to you shortly.",
      'followup_support');
    return;
  }

  // ── STATE: awaiting_followup_details ──
  if (activeTicket.status === 'awaiting_followup_details') {
    const detailIntent = await classifyTicketIntent(messageData.text, 'followup_details');

    if (detailIntent === 'negative') {
      const noDetailMessage = '(User indicated issue is not resolved but did not provide details)';
      ticketModel.saveFollowupTicket(activeTicket, noDetailMessage, convId);
      activeTicket.status = 'awaiting_agent_reply';
      ticketModel.saveTicketToDb(activeTicket);
      const chatSummary = getChatSummary(convId);
      await teamsService.sendFollowupNotification(activeTicket, messageData, chatSummary);
      emitTicketResponse(io, messageData, convId, activeTicket.id,
        "No problem — I've let the support team know that the issue isn't resolved yet. They'll reach out to you for more details shortly.",
        'followup_support');
      return;
    }

    // User provided details
    ticketModel.saveFollowupTicket(activeTicket, messageData.text, convId);
    activeTicket.status = 'awaiting_agent_reply';
    ticketModel.saveTicketToDb(activeTicket);
    const chatSummary = getChatSummary(convId);
    await teamsService.sendFollowupNotification(activeTicket, messageData, chatSummary);
    emitTicketResponse(io, messageData, convId, activeTicket.id,
      "Thanks for the details. I've shared your follow-up with the support team. They'll get back to you shortly.",
      'followup_support');
    return;
  }

  // ── STATE: awaiting_user_reply (agent responded, user sends first message after) ──
  if (activeTicket.status === 'awaiting_user_reply') {
    activeTicket.status = 'awaiting_resolution_confirmation';
    activeTicket.updated_at = new Date().toISOString();
    ticketModel.saveTicketToDb(activeTicket);
    emitTicketResponse(io, messageData, convId, activeTicket.id,
      "Did the support team's response resolve your issue? Reply 'yes' if resolved, or describe what's still wrong and I'll follow up for you.",
      'resolution_check');
    return;
  }

  // ── STATE: awaiting_agent_reply or other active states ──

  // Status inquiry (fast-path regex)
  const normalizedWait = messageData.text.trim().toLowerCase();
  if (/\b(ticket|issue|status|update|progress|eta|when|how\s*long|any\s*(update|news|response|reply)|where\s*(is|are)|what('?s|\s+is)\s*(the|my)?\s*(status|update|progress|ticket))\b/i.test(normalizedWait) &&
      !/\b(new|different|another|also|additionally|separate)\b/i.test(normalizedWait) &&
      !/\b(wdym|what\s*(do|did|does)\s*(you|u|that|it)\s*mean|mean\s*by)\b/i.test(normalizedWait) &&
      !/\b(you|u)\s*(said|wrote|told|mentioned|typed|definitely|literally|just\s*said)\b/i.test(normalizedWait)) {
    const ticketAge = Math.round((Date.now() - new Date(activeTicket.created_at).getTime()) / 60000);
    let statusText;
    if (ticketAge < 5) {
      statusText = `Your ticket (${activeTicket.id}) was just created a few minutes ago. The support team has been notified and will respond shortly. Hang tight!`;
    } else if (ticketAge < 60) {
      statusText = `Your ticket (${activeTicket.id}) is currently with the support team — it's been about ${ticketAge} minutes since it was created. They're working on it and I'll notify you as soon as there's a response.`;
    } else {
      const hours = Math.round(ticketAge / 60);
      statusText = `Your ticket (${activeTicket.id}) has been open for about ${hours} hour${hours > 1 ? 's' : ''}. The support team is still working on it. I'll let you know the moment they respond.`;
    }
    emitTicketResponse(io, messageData, convId, activeTicket.id, statusText, 'status_inquiry');
    return;
  }

  // Local pre-classifier (greetings, off-topic, etc.) — with ticket reminder
  const localIntent = classifyLocalIntent(messageData.text);
  if (localIntent.matched) {
    const ticketReminder = ` Meanwhile, your support ticket (${activeTicket.id}) is still being handled — I'll notify you as soon as the team responds.`;
    emitLocalResponse(io, messageData, localIntent.response + ticketReminder, localIntent.category, convId);
    return;
  }

  // LLM-based classification for ambiguous messages
  const waitingIntent = await classifyTicketIntent(messageData.text, 'waiting_for_agent');
  console.log(`🔍 Waiting intent for "${messageData.text}": ${waitingIntent}`);

  if (waitingIntent === 'casual_ack') {
    emitTicketResponse(io, messageData, convId, activeTicket.id,
      "No worries! The support team is working on it. I'll let you know as soon as they respond.",
      'casual_ack');
    return;
  }

  if (waitingIntent === 'clarification') {
    const recentMsgs = messageModel.getConversationMessages(convId).slice(-8);
    const clarificationText = await generateClarificationResponse(convId, messageData.text, activeTicket, recentMsgs);
    emitTicketResponse(io, messageData, convId, activeTicket.id, clarificationText, 'clarification');
    return;
  }

  if (waitingIntent === 'off_topic' || waitingIntent === 'status_inquiry') {
    let responseText;
    if (waitingIntent === 'status_inquiry') {
      const ticketAge = Math.round((Date.now() - new Date(activeTicket.created_at).getTime()) / 60000);
      responseText = ticketAge < 60
        ? `Your ticket (${activeTicket.id}) is with the support team — about ${ticketAge} minute${ticketAge !== 1 ? 's' : ''} in. I'll let you know as soon as they respond.`
        : `Your ticket (${activeTicket.id}) has been open for about ${Math.round(ticketAge / 60)} hour${Math.round(ticketAge / 60) > 1 ? 's' : ''}. The team is still working on it — I'll update you when they reply.`;
    } else {
      responseText = `I appreciate the chat! 😊 Your support ticket (${activeTicket.id}) is still being handled — I'll let you know as soon as the team responds.`;
    }
    emitTicketResponse(io, messageData, convId, activeTicket.id, responseText, waitingIntent);
    return;
  }

  // Substantive follow-up — forward to Teams
  ticketModel.saveFollowupTicket(activeTicket, messageData.text, convId);
  emitTicketResponse(io, messageData, convId, activeTicket.id,
    "Your follow-up has been shared with the support team. They'll get back to you shortly.",
    'followup_support');
}

// ── Shared helper: emit a ticket-related response ────────────────────────────

/**
 * Emit a response message tied to a specific ticket.
 * Stores in memory, emits to socket room, and persists to DB.
 */
function emitTicketResponse(io, messageData, conversationId, ticketId, text, category) {
  const responseMessage = {
    type: 'response',
    sender: 'AI Assistant',
    timestamp: new Date().toISOString(),
    text,
    messageId: messageModel.generateMessageId('resp'),
    originalMessageId: messageData.messageId,
    category,
    conversationId,
    ticket_id: ticketId,
  };

  messageModel.pushMessage(responseMessage);
  messageModel.pushConversationMessage(conversationId, {
    role: 'assistant',
    message_text: text,
    assistant_message: text,
    matched_issue: category,
    ticket_id: ticketId,
    messageId: responseMessage.messageId,
    created_at: responseMessage.timestamp,
  });

  updateChatSummary(conversationId, {
    assistant_message: text,
    matched_issue: category,
    ticket_id: ticketId,
  });
  conversationModel.updateConversation(conversationId, { preview: text });
  if (io) io.to(conversationId).emit('responseMessage', responseMessage);

  messageModel.saveChatMessageToDb({
    conversationId,
    messageId: responseMessage.messageId,
    role: 'assistant',
    messageText: text,
    matchedIssue: category,
    ticketId,
    createdAt: responseMessage.timestamp,
  });
}

module.exports = {
  registerHandlers,
  getActiveUsers,
};
