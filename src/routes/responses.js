/**
 * Response routes — handles n8n / Teams agent responses.
 *
 * POST /api/send-response: receives AI or agent responses (from n8n
 * or Power Automate) and delivers them to the correct chat conversation.
 * Includes moderation pipeline for human agent messages and deduplication
 * for Teams replies.
 */

const express = require('express');
const config = require('../config');
const messageModel = require('../models/message');
const conversationModel = require('../models/conversation');
const ticketModel = require('../models/ticket');
const moderationModel = require('../models/moderation');
const { scriptModerate } = require('../services/moderation');
const { moderateWithLLM } = require('../services/llm');
const { updateChatSummary } = require('../services/summary');
const { deliverModerationItem } = require('../socket/helpers');

const router = express.Router();

// Track hit count for debugging
let sendResponseHitCount = 0;

// ── GET /api/send-response ───────────────────────────────────────────────────
router.get('/api/send-response', (req, res) => {
  try {
    const responseData = req.query;
    const messageText = responseData.response || responseData.message;

    if (!messageText) {
      return res.status(400).json({ error: 'Missing response or message query param' });
    }

    const responseMessage = {
      type: 'response',
      sender: responseData.sender || responseData.source || config.branding.assistantName,
      timestamp: new Date().toISOString(),
      text: messageText,
      messageId: responseData.messageId || messageModel.generateMessageId('resp'),
      originalMessageId: responseData.originalMessageId || null,
      category: responseData.category || null,
      conversationId: responseData.conversationId || null,
      ticket_id: responseData.ticket_id || null,
    };

    messageModel.pushMessage(responseMessage);

    const io = req.app.get('io');
    if (responseMessage.conversationId && io) {
      io.to(responseMessage.conversationId).emit('responseMessage', responseMessage);
    }

    res.json({ success: true, messageId: responseMessage.messageId, data: responseMessage });
  } catch (error) {
    console.error('❌ Error processing GET response:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/send-response ──────────────────────────────────────────────────
router.post('/api/send-response', async (req, res) => {
  try {
    sendResponseHitCount++;
    const io = req.app.get('io');
    const responseData = req.body || {};

    // Accept multiple possible field names
    let messageText = responseData.replyText || responseData.response || responseData.message || null;

    // Strip &nbsp; injected by Teams / Power Automate
    if (messageText) {
      messageText = messageText
        .replace(/&nbsp;/gi, ' ')
        .replace(/\u00A0/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
    }

    const teamsMessageId = responseData.teamsMessageId || null;
    const replyToMessageId = responseData.replyToMessageId || null;
    const conversationId = responseData.conversationId || null;
    const originalMessageId = responseData.originalMessageId || null;
    const sender = responseData.sender || responseData.source || 'Support Agent';

    // Build deduplication key
    const dedupeKey = teamsMessageId
      ? `${conversationId || 'no-conv'}::${teamsMessageId}`
      : originalMessageId
        ? `${conversationId || 'no-conv'}::${originalMessageId}`
        : `${conversationId || 'no-conv'}::${messageText || 'no-message'}::${Date.now()}`;

    console.log('\n================ POST /api/send-response HIT ================');
    console.log('Hit #:', sendResponseHitCount);
    console.log('Sender:', sender);
    console.log('Conversation ID:', conversationId);
    console.log('Message Text:', messageText);

    if (!messageText) {
      return res.status(400).json({
        success: false,
        error: 'Missing replyText, response, or message field',
      });
    }

    // Filter out Teams attachment XML / card noise
    const cleanedText = String(messageText).trim();
    const isAttachmentNoise = /^(<attachment[^>]*>\s*<\/attachment>\s*)+$/i.test(cleanedText);
    const isCardJson = /^\s*\{.*"@type"\s*:\s*"MessageCard"/i.test(cleanedText);
    const isEmptyAfterStrip = cleanedText.replace(/<attachment[^>]*>\s*<\/attachment>/gi, '').trim().length === 0;

    if (isAttachmentNoise || isCardJson || isEmptyAfterStrip) {
      console.log('⚠️ TEAMS CARD/ATTACHMENT NOISE -> ignoring');
      return res.json({ success: true, ignored: true, reason: 'attachment/card noise filtered' });
    }

    // Deduplication
    if (moderationModel.isDuplicateReply(dedupeKey)) {
      console.log('⚠️ DUPLICATE DETECTED -> ignoring');
      return res.json({ success: true, ignored: true, reason: 'duplicate reply ignored' });
    }
    moderationModel.markReplyProcessed(dedupeKey);

    // Stale thread filter — ignore replies on resolved/old tickets
    if (conversationId && replyToMessageId) {
      const { resolveConversation } = require('../services/teams');
      const threadMapping = resolveConversation(replyToMessageId);
      if (threadMapping && threadMapping.ticket_id) {
        const threadTicket = ticketModel.getTicket(threadMapping.ticket_id);
        if (threadTicket && threadTicket.status === 'resolved') {
          console.log(`⚠️ STALE THREAD: Reply on resolved ticket ${threadMapping.ticket_id} — ignoring`);
          return res.json({ success: true, ignored: true, reason: 'reply on resolved/stale ticket thread' });
        }
        const latestTicket = ticketModel.findActiveTicketForConversation(conversationId);
        if (latestTicket && latestTicket.id !== threadMapping.ticket_id) {
          console.log(`⚠️ STALE THREAD: Reply on old ticket ${threadMapping.ticket_id}, latest is ${latestTicket.id} — ignoring`);
          return res.json({ success: true, ignored: true, reason: `reply on old ticket thread (latest: ${latestTicket.id})` });
        }
      }
    }

    // ── MODERATION PIPELINE for human agent replies ──
    const isTeamsHumanReply = sender !== config.branding.assistantName;

    if (isTeamsHumanReply) {
      const modId = messageModel.generateMessageId('mod');

      // Step 1: Script-based check
      const scriptResult = scriptModerate(messageText);
      console.log('🛡️ MODERATION script check:', { passed: scriptResult.passed, issues: scriptResult.issues });

      if (scriptResult.passed) {
        // Auto-approve — deliver to chat
        const modItem = {
          id: modId, conversationId, sender, text: messageText, originalText: messageText,
          teamsMessageId, replyToMessageId,
          category: responseData.category || null,
          ticket_id: responseData.ticket_id || null,
          originalMessageId: responseData.originalMessageId || replyToMessageId || null,
          messageId: responseData.messageId || messageModel.generateMessageId('resp'),
          timestamp: new Date().toISOString(),
          status: 'approved',
          moderation: { method: 'script', passed: true, issues: [] },
        };

        moderationModel.addModerationItem(modItem);
        deliverModerationItem(io, modItem);
        moderationModel.saveModerationItemToDb(modItem);

        const awaitingTicketId = ticketModel.markTicketAwaitingUserReply(conversationId, responseData.ticket_id);
        if (io) io.emit('moderation:new', modItem);

        console.log('✅ MODERATION: Script passed — auto-approved');
        return res.json({ success: true, auto_approved: true, moderationId: modId, ticket_awaiting_reply: !!awaitingTicketId });
      }

      // Step 2: LLM fallback
      console.log('⚠️ MODERATION: Script failed, calling LLM fallback...');
      const llmResult = await moderateWithLLM(messageText, scriptResult.issues);
      console.log('🤖 MODERATION LLM result:', llmResult);

      if (llmResult.appropriate && llmResult.refinedText) {
        // LLM refined — hold for manual review
        const modItem = {
          id: modId, conversationId, sender,
          text: llmResult.refinedText, originalText: messageText,
          teamsMessageId, replyToMessageId,
          category: responseData.category || null,
          ticket_id: responseData.ticket_id || null,
          originalMessageId: responseData.originalMessageId || replyToMessageId || null,
          messageId: responseData.messageId || messageModel.generateMessageId('resp'),
          timestamp: new Date().toISOString(),
          status: 'pending',
          moderation: {
            method: 'llm_refined',
            scriptIssues: scriptResult.issues,
            llmReason: llmResult.reason,
            originalText: messageText,
            refinedText: llmResult.refinedText,
          },
        };

        moderationModel.addModerationItem(modItem);
        if (io) io.emit('moderation:new', modItem);
        moderationModel.saveModerationItemToDb(modItem);

        console.log('🛡️ MODERATION: LLM refined — held for manual approval');
        return res.json({ success: true, held_for_moderation: true, moderationId: modId, llm_refined: true });
      } else {
        // LLM rejected — auto-reject
        const modItem = {
          id: modId, conversationId, sender,
          text: messageText, originalText: messageText,
          teamsMessageId, replyToMessageId,
          category: responseData.category || null,
          ticket_id: responseData.ticket_id || null,
          originalMessageId: responseData.originalMessageId || replyToMessageId || null,
          messageId: responseData.messageId || messageModel.generateMessageId('resp'),
          timestamp: new Date().toISOString(),
          status: 'rejected',
          moderation: {
            method: 'llm_rejected',
            scriptIssues: scriptResult.issues,
            llmReason: llmResult.reason,
          },
        };

        moderationModel.addModerationItem(modItem);
        if (io) io.emit('moderation:new', modItem);
        moderationModel.saveModerationItemToDb(modItem);

        console.log('❌ MODERATION: LLM rejected');
        return res.json({ success: true, auto_rejected: true, moderationId: modId, reason: llmResult.reason });
      }
    }

    // ── Non-moderated response (from AI Assistant / n8n) ──
    const responseMessage = {
      type: 'response',
      sender,
      timestamp: new Date().toISOString(),
      text: messageText,
      messageId: responseData.messageId || messageModel.generateMessageId('resp'),
      originalMessageId: responseData.originalMessageId || replyToMessageId || null,
      category: responseData.category || null,
      conversationId,
      ticket_id: responseData.ticket_id || null,
      teamsMessageId,
      replyToMessageId,
    };

    messageModel.pushMessage(responseMessage);

    if (responseMessage.conversationId) {
      messageModel.pushConversationMessage(responseMessage.conversationId, {
        role: 'assistant',
        message_text: messageText,
        assistant_message: messageText,
        matched_issue: responseData.category || null,
        ticket_id: responseData.ticket_id || null,
        teamsMessageId, replyToMessageId,
        messageId: responseMessage.messageId,
        created_at: responseMessage.timestamp,
      });

      updateChatSummary(responseMessage.conversationId, {
        assistant_message: messageText,
        matched_issue: responseData.category || null,
        ticket_id: responseData.ticket_id || null,
      });

      // Update last_response_at on open ticket
      const openTicket = ticketModel.findTicketByConversation(responseMessage.conversationId);
      if (openTicket) {
        openTicket.last_response_at = new Date().toISOString();
        openTicket.updated_at = new Date().toISOString();
      }

      conversationModel.updateConversation(responseMessage.conversationId, { preview: messageText });
      if (io) io.to(responseMessage.conversationId).emit('responseMessage', responseMessage);
    }

    console.log('=============================================================\n');
    return res.json({ success: true, ignored: false, messageId: responseMessage.messageId, data: responseMessage });
  } catch (error) {
    console.error('❌ Error processing POST response:', error.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Debug stats ──────────────────────────────────────────────────────────────
router.get('/api/debug/send-response-stats', (req, res) => {
  res.json({
    sendResponseHitCount,
    processedTeamsRepliesSize: moderationModel.processedTeamsReplies.size,
    processedTeamsRepliesKeys: [...moderationModel.processedTeamsReplies.keys()],
  });
});

// ── n8n status & reconnect ───────────────────────────────────────────────────
const n8nService = require('../services/n8n');

router.get('/api/n8n-status', (req, res) => {
  const status = n8nService.getStatus();
  res.json({ ...status, totalMessages: messageModel.getMessages().length });
});

router.post('/api/reconnect-n8n', async (req, res) => {
  const result = await n8nService.reconnect();
  res.json({ message: 'Reconnection initiated', ...result });
});

module.exports = router;
