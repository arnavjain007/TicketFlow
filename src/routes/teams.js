/**
 * Teams integration REST routes.
 *
 * Thread mapping and conversation resolution for Microsoft Teams
 * / Power Automate integration.
 */

const express = require('express');
const teamsService = require('../services/teams');
const ticketModel = require('../models/ticket');

const router = express.Router();

// ── Register a Teams thread mapping ──────────────────────────────────────────
router.post('/api/teams/register-thread', (req, res) => {
  try {
    const { teamsMessageId, conversationId, ticket_id = null } = req.body || {};

    if (!teamsMessageId || !conversationId) {
      return res.status(400).json({
        success: false,
        error: 'teamsMessageId and conversationId are required',
      });
    }

    teamsService.registerThread(teamsMessageId, conversationId, ticket_id);

    return res.json({
      success: true,
      data: teamsService.resolveConversation(teamsMessageId),
    });
  } catch (error) {
    console.error('❌ Error registering thread:', error.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Resolve a conversation from a Teams reply ────────────────────────────────
router.post('/api/teams/resolve-conversation', (req, res) => {
  try {
    const { replyToMessageId, teamsMessageId } = req.body || {};
    const key = String(replyToMessageId || teamsMessageId || '');

    console.log('\n===== /api/teams/resolve-conversation HIT =====');
    console.log('Body:', JSON.stringify(req.body, null, 2));
    console.log('Lookup key:', key);

    if (!key) {
      return res.status(400).json({
        success: false,
        error: 'replyToMessageId or teamsMessageId required',
      });
    }

    const mapping = teamsService.resolveConversation(key);

    if (!mapping) {
      console.log('❌ Mapping not found for key:', key);
      return res.status(404).json({
        success: false,
        error: 'Mapping not found',
        lookupKey: key,
      });
    }

    console.log('✅ Mapping found:', mapping);

    return res.json({
      success: true,
      conversationId: mapping.conversationId,
      ticket_id: mapping.ticket_id || null,
      teamsMessageId: mapping.teamsMessageId || key,
    });
  } catch (error) {
    console.error('❌ Error resolving conversation:', error.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
