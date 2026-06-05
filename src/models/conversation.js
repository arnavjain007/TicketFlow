/**
 * Conversation data model.
 *
 * Manages in-memory conversation store with CRUD operations.
 * Each user has a list of conversations; each conversation has metadata
 * (title, preview, timestamps) and a separate message store.
 */q

// ── In-memory stores ─────────────────────────────────────────────────────────
// userId -> [ { conversation_id, user_id, title, last_message_preview, created_at, updated_at } ]
const conversationsStore = {};

/**
 * Create a new conversation for a user.
 * @param {string} userId
 * @param {string} [title]
 * @param {string} [preview]
 * @returns {object} The created conversation object
 */
function createConversation(userId, title = '', preview = '') {
  const conversationId = `conv_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  const now = new Date().toISOString();

  if (!conversationsStore[userId]) conversationsStore[userId] = [];

  const chatNumber = conversationsStore[userId].length + 1;

  const convo = {
    conversation_id: conversationId,
    user_id: userId,
    title: title && title.trim() ? title : `New Chat ${chatNumber}`,
    last_message_preview: preview,
    created_at: now,
    updated_at: now,
  };

  conversationsStore[userId].unshift(convo);
  return convo;
}

/**
 * Update an existing conversation's title and/or preview.
 * @param {string} conversationId
 * @param {{ title?: string, preview?: string }} updates
 * @returns {object|null} Updated conversation or null if not found
 */
function updateConversation(conversationId, { title, preview }) {
  for (const userId in conversationsStore) {
    const convo = conversationsStore[userId].find(c => c.conversation_id === conversationId);
    if (convo) {
      if (title) convo.title = title;
      if (preview) convo.last_message_preview = preview;
      convo.updated_at = new Date().toISOString();
      return convo;
    }
  }
  return null;
}

/**
 * Find a conversation by its ID across all users.
 * @param {string} conversationId
 * @returns {object|null}
 */
function findConversation(conversationId) {
  for (const userId in conversationsStore) {
    const convo = conversationsStore[userId].find(c => c.conversation_id === conversationId);
    if (convo) return convo;
  }
  return null;
}

/**
 * Get all conversations for a user.
 * @param {string} userId
 * @returns {object[]}
 */
function getConversationsByUser(userId) {
  return conversationsStore[userId] || [];
}

/**
 * Generate a short conversation title from user text.
 * @param {string} [text]
 * @returns {string}
 */
function generateConversationTitle(text = '') {
  const cleaned = String(text || '').trim().replace(/\s+/g, ' ');
  if (!cleaned) return 'New Chat';
  const words = cleaned.split(' ').slice(0, 6).join(' ');
  return words.length > 40 ? words.slice(0, 40) : words;
}

/**
 * Return aggregate stats for health check.
 */
function getStats() {
  return {
    totalConversationOwners: Object.keys(conversationsStore).length,
    totalConversations: Object.values(conversationsStore).reduce((acc, arr) => acc + arr.length, 0),
  };
}

module.exports = {
  conversationsStore,
  createConversation,
  updateConversation,
  findConversation,
  getConversationsByUser,
  generateConversationTitle,
  getStats,
};
