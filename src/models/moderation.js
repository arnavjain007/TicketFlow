/**
 * Moderation data model.
 *
 * In-memory queue of moderation items (pending, approved, rejected)
 * with MySQL persistence. The moderation *logic* (script check, LLM)
 * lives in services/moderation.js — this module is pure data access.
 */

const { pool, toMySQLDatetime } = require('../config/database');

// ── In-memory store ──────────────────────────────────────────────────────────
// moderationId -> moderation item
const moderationQueue = {};

// Deduplication map for Teams replies (key -> timestamp)
const processedTeamsReplies = new Map();

// ── DB persistence ───────────────────────────────────────────────────────────

/**
 * Upsert a moderation_log row in MySQL.
 */
async function saveModerationItemToDb(item) {
  try {
    const mod = item.moderation || {};
    await pool.execute(
      `INSERT INTO moderation_log
        (id, conversation_id, sender, text, original_text, teams_message_id,
         reply_to_message_id, category, ticket_id, original_message_id,
         message_id, status, moderation_method, moderation_issues,
         moderation_reason, refined_text, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
          status = VALUES(status),
          text = VALUES(text),
          moderation_method = VALUES(moderation_method),
          moderation_issues = VALUES(moderation_issues),
          moderation_reason = VALUES(moderation_reason),
          refined_text = VALUES(refined_text),
          resolved_at = IF(VALUES(status) != 'pending', NOW(), resolved_at)`,
      [
        item.id,
        item.conversationId || null,
        item.sender || null,
        item.text || null,
        item.originalText || item.text || null,
        item.teamsMessageId || null,
        item.replyToMessageId || null,
        item.category || null,
        item.ticket_id || null,
        item.originalMessageId || null,
        item.messageId || null,
        item.status || 'pending',
        mod.method || null,
        mod.scriptIssues || mod.issues ? JSON.stringify(mod.scriptIssues || mod.issues) : null,
        mod.llmReason || null,
        mod.refinedText || null,
        toMySQLDatetime(item.timestamp || new Date().toISOString()),
      ],
    );
  } catch (err) {
    console.error('❌ MySQL saveModerationItem error:', err.message);
  }
}

/**
 * Update moderation status in MySQL.
 */
async function updateModerationStatusInDb(id, status) {
  try {
    await pool.execute(
      'UPDATE moderation_log SET status = ?, resolved_at = NOW() WHERE id = ?',
      [status, id],
    );
  } catch (err) {
    console.error('❌ MySQL updateModerationStatus error:', err.message);
  }
}

/**
 * Load recent moderation items from MySQL (for startup restore).
 */
async function loadModerationItemsFromDb() {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM moderation_log ORDER BY created_at DESC LIMIT 500',
    );
    return rows;
  } catch (err) {
    console.error('❌ MySQL loadModerationItems error:', err.message);
    return [];
  }
}

// ── In-memory operations ─────────────────────────────────────────────────────

function addModerationItem(item) {
  moderationQueue[item.id] = item;
}

function getModerationItem(id) {
  return moderationQueue[id] || null;
}

function getPendingItems() {
  return Object.values(moderationQueue)
    .filter(item => item.status === 'pending')
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

function getAllItems() {
  return Object.values(moderationQueue)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

/**
 * Check if a Teams reply has already been processed (deduplication).
 */
function isDuplicateReply(dedupeKey) {
  return processedTeamsReplies.has(dedupeKey);
}

/**
 * Mark a Teams reply key as processed.
 * Auto-expires after 10 minutes.
 */
function markReplyProcessed(dedupeKey) {
  processedTeamsReplies.set(dedupeKey, Date.now());
  setTimeout(() => processedTeamsReplies.delete(dedupeKey), 10 * 60 * 1000);
}

/**
 * Clean resolved/rejected items older than 24 hours.
 */
function cleanOldItems() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let cleaned = 0;
  for (const id of Object.keys(moderationQueue)) {
    const item = moderationQueue[id];
    if (item.status !== 'pending' && new Date(item.timestamp).getTime() < cutoff) {
      delete moderationQueue[id];
      cleaned++;
    }
  }
  if (cleaned > 0) console.log(`🧹 Cleaned ${cleaned} old moderation items`);
}

/**
 * Restore moderation items from DB rows into the in-memory queue.
 */
function restoreModerationItems(rows) {
  for (const row of rows) {
    moderationQueue[row.id] = {
      id: row.id,
      conversationId: row.conversation_id,
      sender: row.sender,
      text: row.text,
      originalText: row.original_text,
      teamsMessageId: row.teams_message_id,
      replyToMessageId: row.reply_to_message_id,
      category: row.category,
      ticket_id: row.ticket_id,
      originalMessageId: row.original_message_id,
      messageId: row.message_id,
      timestamp: new Date(row.created_at).toISOString(),
      status: row.status,
      moderation: {
        method: row.moderation_method,
        scriptIssues: (() => {
          try { return row.moderation_issues ? JSON.parse(row.moderation_issues) : []; }
          catch { return [row.moderation_issues]; }
        })(),
        llmReason: row.moderation_reason,
        refinedText: row.refined_text,
        originalText: row.original_text,
      },
    };
  }
  console.log(`📦 Restored ${rows.length} moderation items from MySQL`);
}

module.exports = {
  moderationQueue,
  processedTeamsReplies,
  // CRUD
  addModerationItem,
  getModerationItem,
  getPendingItems,
  getAllItems,
  // Dedup
  isDuplicateReply,
  markReplyProcessed,
  // Maintenance
  cleanOldItems,
  // Persistence
  saveModerationItemToDb,
  updateModerationStatusInDb,
  loadModerationItemsFromDb,
  restoreModerationItems,
};
