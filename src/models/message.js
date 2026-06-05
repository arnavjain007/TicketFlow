/**
 * Message data model.
 *
 * Manages the global message list, per-conversation message store,
 * and the chat-memory store used by n8n for context retrieval.
 * Also handles DB persistence of individual chat messages.
 */

const { pool, toMySQLDatetime } = require('../config/database');
const config = require('../config');

// ── In-memory stores ─────────────────────────────────────────────────────────

// Global ordered message list (capped by limits.maxMessages)
let messages = [];

// conversationId -> [ { role, message_text, ... } ]
const conversationMessagesStore = {};

// conversationId -> [ { role, message_text, ... } ]  (used by /api/chat-memory)
const chatMemoryStore = {};

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Cap an array to `max` items, removing oldest entries.
 */
function capArray(arr, max) {
  if (arr.length > max) arr.splice(0, arr.length - max);
}

/**
 * Generate a unique message ID.
 * @param {string} [prefix='msg']
 * @returns {string}
 */
function generateMessageId(prefix = 'msg') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

// ── Global message list ──────────────────────────────────────────────────────

function pushMessage(msg) {
  messages.push(msg);
}

function getMessages() {
  return messages;
}

function clearMessages() {
  messages = [];
}

// ── Conversation messages ────────────────────────────────────────────────────

/**
 * Append a message to a conversation's message list.
 */
function pushConversationMessage(conversationId, msg) {
  if (!conversationMessagesStore[conversationId]) {
    conversationMessagesStore[conversationId] = [];
  }
  conversationMessagesStore[conversationId].push(msg);
}

function getConversationMessages(conversationId) {
  return conversationMessagesStore[conversationId] || [];
}

function ensureConversationStore(conversationId) {
  if (!conversationMessagesStore[conversationId]) {
    conversationMessagesStore[conversationId] = [];
  }
}

// ── Chat memory (n8n context) ────────────────────────────────────────────────

function pushMemoryEntry(conversationId, entry) {
  if (!chatMemoryStore[conversationId]) {
    chatMemoryStore[conversationId] = [];
  }
  chatMemoryStore[conversationId].push(entry);
  // Cap memory size
  if (chatMemoryStore[conversationId].length > config.limits.maxMemoryTurns) {
    chatMemoryStore[conversationId] = chatMemoryStore[conversationId].slice(-config.limits.maxMemoryTurns);
  }
}

function getMemory(conversationId, limit = 20) {
  const entries = chatMemoryStore[conversationId] || [];
  return entries.slice(-Number(limit));
}

function getMemoryStats() {
  return { memoryConversations: Object.keys(chatMemoryStore).length };
}

// ── Periodic cap enforcement ─────────────────────────────────────────────────

function enforceMemoryCaps() {
  capArray(messages, config.limits.maxMessages);
  for (const convId of Object.keys(conversationMessagesStore)) {
    capArray(conversationMessagesStore[convId], config.limits.maxConversationMessages);
  }
}

// ── Database persistence ─────────────────────────────────────────────────────

/**
 * Persist a single chat message row to MySQL.
 */
async function saveChatMessageToDb({
  conversationId, messageId, role, messageText, intent, matchedIssue,
  issueSummary, attachmentSummary, ticketId, fileUrl, fileType, fileName, createdAt,
}) {
  try {
    await pool.execute(
      `INSERT INTO chat_messages
        (conversation_id, message_id, role, message_text, intent, matched_issue,
         issue_summary, attachment_summary, ticket_id, file_url, file_type,
         file_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        conversationId || null,
        messageId || null,
        role,
        messageText || null,
        intent || null,
        matchedIssue || null,
        issueSummary || null,
        attachmentSummary || null,
        ticketId || null,
        fileUrl || null,
        fileType || null,
        fileName || null,
        toMySQLDatetime(createdAt || new Date().toISOString()),
      ],
    );
  } catch (err) {
    console.error('❌ MySQL saveChatMessage error:', err.message);
  }
}

module.exports = {
  // Global messages
  pushMessage,
  getMessages,
  clearMessages,
  generateMessageId,
  // Conversation messages
  pushConversationMessage,
  getConversationMessages,
  ensureConversationStore,
  conversationMessagesStore,
  // Chat memory
  pushMemoryEntry,
  getMemory,
  getMemoryStats,
  chatMemoryStore,
  // Maintenance
  enforceMemoryCaps,
  // DB
  saveChatMessageToDb,
};
