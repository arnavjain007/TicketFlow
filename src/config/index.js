/**
 * Central configuration module.
 *
 * Reads environment variables once and exports typed, validated config
 * objects for every other module. No module should read process.env directly
 * — always import from here so config changes are centralized.
 */

require('dotenv').config();

const path = require('path');

// ── Server ───────────────────────────────────────────────────────────────────
const server = {
  port: parseInt(process.env.PORT || '8000', 10),
  host: process.env.HOST || '0.0.0.0',
  uploadsDir: path.resolve(process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', 'uploads')),
};

// ── Database (MySQL) ─────────────────────────────────────────────────────────
const database = {
  host: process.env.MYSQL_HOST || 'localhost',
  port: parseInt(process.env.MYSQL_PORT || '3306', 10),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'chatsupport',
  connectionLimit: parseInt(process.env.MYSQL_POOL_SIZE || '10', 10),
  charset: 'utf8mb4',
};

// ── n8n Integration ──────────────────────────────────────────────────────────
const n8n = {
  webhookUrl: process.env.N8N_WEBHOOK_URL || '',
  timeout: parseInt(process.env.N8N_TIMEOUT || '30000', 10),
};

// ── Teams Integration ────────────────────────────────────────────────────────
const teams = {
  webhookUrl: process.env.TEAMS_WEBHOOK_URL || '',
  timeout: parseInt(process.env.TEAMS_TIMEOUT || '10000', 10),
};

// ── LLM / Gemini ─────────────────────────────────────────────────────────────
const llm = {
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
};

// ── Branding / System Identity ───────────────────────────────────────────────
// Change these when deploying for a different product (not just Jarvis/StrideOne).
const branding = {
  platformName: process.env.PLATFORM_NAME || 'StrideOne',
  assistantName: process.env.ASSISTANT_NAME || 'AI Assistant',
  botCapabilityMessage: process.env.BOT_CAPABILITY_MESSAGE || null, // null = use default
};

// ── Limits / Tunables ────────────────────────────────────────────────────────
const limits = {
  maxMessages: parseInt(process.env.MAX_MESSAGES || '2000', 10),
  maxConversationMessages: parseInt(process.env.MAX_CONVERSATION_MESSAGES || '300', 10),
  maxMemoryTurns: parseInt(process.env.MAX_MEMORY_TURNS || '50', 10),
  maxUploadSizeMb: parseInt(process.env.MAX_UPLOAD_SIZE_MB || '50', 10),
  escalationCheckIntervalMs: parseInt(process.env.ESCALATION_CHECK_INTERVAL_MS || String(5 * 60 * 1000), 10),
  escalationThresholdMinutes: parseInt(process.env.ESCALATION_THRESHOLD_MINUTES || '5', 10),
  minBotAttemptsBeforeEscalation: parseInt(process.env.MIN_BOT_ATTEMPTS_BEFORE_ESCALATION || '2', 10),
};

module.exports = {
  server,
  database,
  n8n,
  teams,
  llm,
  branding,
  limits,
};
