/**
 * Chat Support System — Microservice Entry Point
 *
 * This file bootstraps the Express + Socket.IO server and wires together
 * all modular components. The actual logic lives in src/:
 *
 *   src/config/       - Environment config, database pool
 *   src/models/       - Data access (conversation, message, ticket, moderation)
 *   src/services/     - Business logic (intent, LLM, moderation, escalation, n8n, Teams)
 *   src/routes/       - REST API endpoints
 *   src/socket/       - WebSocket event handlers
 *   src/middleware/    - Express middleware
 *
 * To adapt this microservice for a different product:
 *   1. Set PLATFORM_NAME / ASSISTANT_NAME / BOT_CAPABILITY_MESSAGE in .env
 *   2. Replace kb_issues.js with your product's knowledge base
 *   3. Point N8N_WEBHOOK_URL / TEAMS_WEBHOOK_URL to your integrations
 */

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');

// ── Config ───────────────────────────────────────────────────────────────────
const config = require('./src/config');
const db = require('./src/config/database');

// ── Models ───────────────────────────────────────────────────────────────────
const messageModel = require('./src/models/message');
const ticketModel = require('./src/models/ticket');
const moderationModel = require('./src/models/moderation');

// ── Services ─────────────────────────────────────────────────────────────────
const n8nService = require('./src/services/n8n');
const { startEscalationTimer } = require('./src/services/escalation');

// ── Routes ───────────────────────────────────────────────────────────────────
const healthRoutes = require('./src/routes/health');
const conversationRoutes = require('./src/routes/conversations');
const messageRoutes = require('./src/routes/messages');
const ticketRoutes = require('./src/routes/tickets');
const moderationRoutes = require('./src/routes/moderation');
const teamsRoutes = require('./src/routes/teams');
const responseRoutes = require('./src/routes/responses');
const uploadRoutes = require('./src/routes/upload');

// ── Socket handlers ──────────────────────────────────────────────────────────
const socketHandlers = require('./src/socket/handlers');

// ── Middleware ────────────────────────────────────────────────────────────────
const requestLogger = require('./src/middleware/logger');

// ── Ensure uploads directory exists ──────────────────────────────────────────
if (!fs.existsSync(config.server.uploadsDir)) {
  fs.mkdirSync(config.server.uploadsDir, { recursive: true });
}

// ── Create Express app & HTTP server ─────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: '*', methods: ['GET', 'POST', 'PATCH', 'DELETE'] },
});

// Make io accessible to route handlers via req.app.get('io')
app.set('io', io);

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.static('public'));
app.use(express.static('uploads'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(requestLogger);

// ── Serve frontend ───────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Mount all route modules ──────────────────────────────────────────────────
app.use(healthRoutes);
app.use(conversationRoutes);
app.use(messageRoutes);
app.use(ticketRoutes);
app.use(moderationRoutes);
app.use(teamsRoutes);
app.use(responseRoutes);
app.use(uploadRoutes);

// ── Register Socket.IO handlers ──────────────────────────────────────────────
socketHandlers.registerHandlers(io);

// ── Periodic maintenance timers ──────────────────────────────────────────────

// Memory cap enforcement (every minute)
setInterval(() => messageModel.enforceMemoryCaps(), 60 * 1000);

// Old moderation item cleanup (every 30 minutes)
setInterval(() => moderationModel.cleanOldItems(), 30 * 60 * 1000);

// Ticket escalation timer
startEscalationTimer();

// ── Graceful shutdown ────────────────────────────────────────────────────────
function gracefulShutdown(signal) {
  console.log(`\n${signal} received. Shutting down gracefully...`);
  server.close(async () => {
    console.log('HTTP server closed');
    await db.closePool();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ── Start server ─────────────────────────────────────────────────────────────
server.listen(config.server.port, config.server.host, async () => {
  console.log(`🚀 Chat Support System running on http://localhost:${config.server.port}`);
  console.log(`📡 n8n webhook: ${config.n8n.webhookUrl || '(not configured)'}`);

  // Initialize n8n connection
  n8nService.initializeConnection();

  // Run DB migrations and restore state
  const dbOk = await db.testConnection();
  if (dbOk) {
    await db.runMigrations();

    // Restore tickets from MySQL
    const ticketRows = await ticketModel.loadTicketsFromDb();
    ticketModel.restoreTickets(ticketRows);

    // Restore moderation queue from MySQL
    const modRows = await moderationModel.loadModerationItemsFromDb();
    moderationModel.restoreModerationItems(modRows);
  }

  console.log('✅ Chat Support microservice ready');
});
