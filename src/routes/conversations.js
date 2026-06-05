/**
 * Conversation REST routes.
 *
 * CRUD for conversations: create, list by user, get messages,
 * add messages, rename conversations.
 */

const express = require('express');
const conversationModel = require('../models/conversation');
const messageModel = require('../models/message');

const router = express.Router();

// ── Create conversation ──────────────────────────────────────────────────────
router.post('/api/conversations', (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ error: 'userId required' });
    }
    const convo = conversationModel.createConversation(userId);
    res.json(convo);
  } catch (error) {
    console.error('❌ Failed to create conversation:', error.message);
    res.status(500).json({ error: 'Failed to create conversation' });
  }
});

// ── List conversations for a user ────────────────────────────────────────────
router.get('/api/conversations/:userId', (req, res) => {
  try {
    res.json(conversationModel.getConversationsByUser(req.params.userId));
  } catch (error) {
    console.error('❌ Failed to fetch conversations:', error.message);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

// ── Get messages for a conversation ──────────────────────────────────────────
router.get('/api/conversations/:conversationId/messages', (req, res) => {
  try {
    res.json(messageModel.getConversationMessages(req.params.conversationId));
  } catch (error) {
    console.error('❌ Failed to fetch messages:', error.message);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// ── Add a message to a conversation ──────────────────────────────────────────
router.post('/api/conversations/:conversationId/messages', (req, res) => {
  try {
    const { conversationId } = req.params;
    const {
      role, message_text, file_url = null, file_type = null, file_name = null,
      intent = null, matched_issue = null, ticket_id = null, messageId = null,
    } = req.body;

    if (!conversationId) {
      return res.status(400).json({ error: 'conversationId required' });
    }

    messageModel.ensureConversationStore(conversationId);

    const msg = {
      role,
      message_text,
      file_url, file_type, file_name,
      intent, matched_issue, ticket_id,
      messageId: messageId || messageModel.generateMessageId(),
      created_at: new Date().toISOString(),
    };

    messageModel.pushConversationMessage(conversationId, msg);

    const existingConvo = conversationModel.findConversation(conversationId);
    if (existingConvo) {
      conversationModel.updateConversation(conversationId, {
        title: existingConvo.title === 'New Chat' && role === 'user'
          ? conversationModel.generateConversationTitle(message_text)
          : undefined,
        preview: message_text || file_name || 'Attachment',
      });
    }

    res.json({
      success: true,
      conversationId,
      totalMessages: messageModel.getConversationMessages(conversationId).length,
    });
  } catch (error) {
    console.error('❌ Failed to save message:', error.message);
    res.status(500).json({ error: 'Failed to save message' });
  }
});

// ── Rename a conversation ────────────────────────────────────────────────────
router.patch('/api/conversations/:conversationId', (req, res) => {
  try {
    const { title } = req.body;
    const convo = conversationModel.updateConversation(req.params.conversationId, { title });
    if (!convo) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    res.json(convo);
  } catch (error) {
    console.error('❌ Failed to update conversation:', error.message);
    res.status(500).json({ error: 'Failed to update conversation' });
  }
});

module.exports = router;
