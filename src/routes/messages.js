/**
 * Message & chat-memory REST routes.
 *
 * Handles direct message sending (POST /api/messages), chat memory
 * retrieval/storage, and attachment text extraction.
 */

const express = require('express');
const messageModel = require('../models/message');
const conversationModel = require('../models/conversation');
const { updateChatSummary, getChatSummary } = require('../services/summary');
const { classifyLocalIntent, isEscalationRequest } = require('../services/intent');
const { checkEscalationGate } = require('../services/escalation');
const n8nService = require('../services/n8n');
const { extractAttachmentContent } = require('../services/attachment');
const { emitLocalResponse } = require('../socket/helpers');

const router = express.Router();

// ── Get all messages ─────────────────────────────────────────────────────────
router.get('/api/messages', (req, res) => {
  res.json(messageModel.getMessages());
});

// ── Clear all messages ───────────────────────────────────────────────────────
router.delete('/api/messages', (req, res) => {
  messageModel.clearMessages();
  const io = req.app.get('io');
  if (io) io.emit('messagesCleared');
  res.json({ message: 'Messages cleared' });
});

// ── Send a message (REST API equivalent of socket sendMessage) ───────────────
router.post('/api/messages', async (req, res) => {
  try {
    const { sender, text, file_url, file_type, file_name, conversationId, userId } = req.body;
    const io = req.app.get('io');

    let finalConversationId = conversationId;
    let conversation = finalConversationId ? conversationModel.findConversation(finalConversationId) : null;

    if (!conversation) {
      const safeUserId = userId || sender || 'guest_user';
      conversation = conversationModel.createConversation(safeUserId, conversationModel.generateConversationTitle(text), text || file_name || '');
      finalConversationId = conversation.conversation_id;
    }

    const messageData = {
      type: 'message',
      sender: sender || 'Anonymous',
      conversationId: finalConversationId,
      timestamp: new Date().toISOString(),
      text: text || '',
      file_url: file_url || null,
      file_type: file_type || null,
      file_name: file_name || null,
      messageId: messageModel.generateMessageId(),
    };

    messageModel.pushMessage(messageData);
    messageModel.pushConversationMessage(finalConversationId, {
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

    conversationModel.updateConversation(finalConversationId, {
      title: conversation.title === 'New Chat' ? conversationModel.generateConversationTitle(text) : undefined,
      preview: text || file_name || 'Attachment',
    });

    if (io) io.emit('newMessage', messageData);

    // Local pre-classifier
    let locallyHandled = false;
    if (messageData.text && !messageData.file_url) {
      if (isEscalationRequest(messageData.text)) {
        const gate = checkEscalationGate(finalConversationId);
        if (gate.gated) {
          emitLocalResponse(io, messageData, gate.response, 'escalation_gate', finalConversationId);
          locallyHandled = true;
        }
      }

      if (!locallyHandled) {
        const localIntent = classifyLocalIntent(messageData.text);
        if (localIntent.matched) {
          emitLocalResponse(io, messageData, localIntent.response, localIntent.category, finalConversationId);
          locallyHandled = true;
        }
      }
    }

    if (!locallyHandled) {
      await n8nService.sendToN8n(messageData);
    }

    res.json({ success: true, message: 'Message sent', data: messageData });
  } catch (error) {
    console.error('❌ Error in /api/messages:', error.message);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// ── Chat memory: get ─────────────────────────────────────────────────────────
router.post('/api/chat-memory/get', (req, res) => {
  try {
    const { conversationId, sessionId, limit = 20 } = req.body;
    const key = conversationId || sessionId;
    if (!key) {
      return res.status(400).json({ error: 'conversationId or sessionId is required' });
    }

    const recentMessages = messageModel.getMemory(key, limit);
    const summaryData = getChatSummary(key);

    res.json({
      success: true,
      conversationId: key,
      messages: recentMessages,
      chat_summary: summaryData.summary,
    });
  } catch (error) {
    console.error('❌ Error loading chat memory:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Chat memory: save turn ───────────────────────────────────────────────────
router.post('/api/chat-memory/save-turn', (req, res) => {
  try {
    const {
      conversationId, sessionId,
      user_message, assistant_message,
      user_query = null, intent = null, matched_issue = null,
      issue_summary = null, attachment_summary = null, ticket_id = null,
      messageId = null, file_url = null, file_type = null, file_name = null,
    } = req.body;

    const key = conversationId || sessionId;
    if (!key) {
      return res.status(400).json({ error: 'conversationId or sessionId is required' });
    }

    const now = new Date().toISOString();

    if (user_message) {
      messageModel.pushMemoryEntry(key, {
        role: 'user', message_text: user_message, user_message,
        user_query: user_query || user_message,
        intent, matched_issue, issue_summary, attachment_summary,
        ticket_id, messageId, file_url, file_type, file_name,
        created_at: now,
      });
      messageModel.saveChatMessageToDb({
        conversationId: key, messageId, role: 'user', messageText: user_message,
        intent, matchedIssue: matched_issue, issueSummary: issue_summary,
        attachmentSummary: attachment_summary, ticketId: ticket_id,
        fileUrl: file_url, fileType: file_type, fileName: file_name, createdAt: now,
      });
    }

    if (assistant_message) {
      messageModel.pushMemoryEntry(key, {
        role: 'assistant', message_text: assistant_message, assistant_message,
        intent, matched_issue, issue_summary, attachment_summary,
        ticket_id, messageId, file_url, file_type, file_name,
        created_at: now,
      });
      messageModel.saveChatMessageToDb({
        conversationId: key, messageId, role: 'assistant', messageText: assistant_message,
        intent, matchedIssue: matched_issue, issueSummary: issue_summary,
        attachmentSummary: attachment_summary, ticketId: ticket_id,
        fileUrl: file_url, fileType: file_type, fileName: file_name, createdAt: now,
      });
    }

    updateChatSummary(key, {
      user_message, assistant_message, intent,
      matched_issue, issue_summary, attachment_summary, ticket_id,
    });

    const summaryData = getChatSummary(key);

    res.json({
      success: true,
      conversationId: key,
      totalMessages: messageModel.getMemory(key).length,
      chat_summary: summaryData.summary,
    });
  } catch (error) {
    console.error('❌ Error saving chat memory:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Chat memory: get by conversationId ───────────────────────────────────────
router.get('/api/chat-memory/:conversationId', (req, res) => {
  try {
    const { conversationId } = req.params;
    const summaryData = getChatSummary(conversationId);
    res.json({
      success: true,
      conversationId,
      messages: messageModel.chatMemoryStore[conversationId] || [],
      chat_summary: summaryData.summary,
    });
  } catch (error) {
    console.error('❌ Error fetching chat memory:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Attachment text extraction ───────────────────────────────────────────────
router.post('/api/extract-attachment-text', async (req, res) => {
  try {
    const { file_url, file_type, file_name } = req.body || {};

    if (!file_url && !file_name) {
      return res.status(400).json({
        success: false,
        error: 'file_url or file_name is required',
        attachment_text: '',
        attachment_summary: '',
        extraction_method: 'none',
      });
    }

    const result = await extractAttachmentContent({ file_url, file_type, file_name });

    return res.json({
      success: result.success,
      file_url: file_url || null,
      file_type: file_type || null,
      file_name: file_name || null,
      attachment_text: result.attachment_text || '',
      attachment_summary: result.attachment_summary || '',
      extraction_method: result.extraction_method || 'none',
      error: result.error || null,
    });
  } catch (error) {
    console.error('❌ Error in /api/extract-attachment-text:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message,
      attachment_text: '',
      attachment_summary: '',
      extraction_method: 'error',
    });
  }
});

module.exports = router;
