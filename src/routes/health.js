/**
 * Health & debug routes.
 *
 * Provides a health check endpoint and debug utilities
 * for monitoring the microservice's runtime state.
 */

const express = require('express');
const messageModel = require('../models/message');
const conversationModel = require('../models/conversation');
const ticketModel = require('../models/ticket');
const teamsService = require('../services/teams');
const n8nService = require('../services/n8n');

const router = express.Router();

// ── Health check ─────────────────────────────────────────────────────────────
router.get('/health', (req, res) => {
  const n8nStatus = n8nService.getStatus();
  const convStats = conversationModel.getStats();
  const memStats = messageModel.getMemoryStats();

  res.json({
    status: 'ok',
    messageCount: messageModel.getMessages().length,
    ...n8nStatus,
    ...memStats,
    ...convStats,
    totalTickets: ticketModel.getAllTickets().length,
    totalTeamsThreadMappings: Object.keys(teamsService.getThreadMap()).length,
  });
});

// ── Debug: Teams thread map ──────────────────────────────────────────────────
router.get('/api/debug/teams-thread-map', (req, res) => {
  res.json({ success: true, teamsThreadMap: teamsService.getThreadMap() });
});

module.exports = router;
