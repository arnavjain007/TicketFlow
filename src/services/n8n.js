/**
 * n8n integration service.
 *
 * Handles sending user messages to the n8n webhook for AI processing.
 * n8n receives the message along with chat summary context and returns
 * the AI-generated response.
 */

const axios = require('axios');
const config = require('../config');
const { getChatSummary, updateChatSummary } = require('./summary');

// Track n8n connection status
let n8nConnected = false;
const messageQueue = [];

/**
 * Send a message payload to the n8n webhook.
 *
 * @param {object} messageData - The user message object
 * @returns {Promise<object|null>} n8n response data or null on failure
 */
async function sendToN8n(messageData) {
  try {
    const convId = messageData.conversationId || messageData.sender || 'Guest';

    // Update summary with current user message before sending
    if (messageData.text) {
      updateChatSummary(convId, { user_message: messageData.text });
    }

    const summaryData = getChatSummary(convId);

    const payload = {
      sender: messageData.sender,
      conversationId: convId,
      text: messageData.text,
      file_url: messageData.file_url,
      file_type: messageData.file_type,
      file_name: messageData.file_name,
      timestamp: messageData.timestamp,
      messageId: messageData.messageId,
      hasFile: !!messageData.file_url,
      chat_summary: summaryData.summary || '',
    };

    const response = await axios.post(config.n8n.webhookUrl, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: config.n8n.timeout,
    });

    n8nConnected = true;
    return response.data;
  } catch (error) {
    console.error('❌ Error sending to n8n:', error.response?.data || error.message);
    n8nConnected = false;
    return null;
  }
}

/**
 * Initialize n8n connection and flush queued messages.
 */
async function initializeConnection() {
  try {
    n8nConnected = true;
    while (messageQueue.length > 0) {
      const msg = messageQueue.shift();
      await sendToN8n(msg);
    }
  } catch (error) {
    console.error('❌ Failed to initialize n8n connection:', error.message);
    n8nConnected = false;
    setTimeout(initializeConnection, 5000);
  }
}

/**
 * Check current n8n connection status.
 */
function getStatus() {
  return {
    connected: n8nConnected,
    webhookUrl: config.n8n.webhookUrl,
    queuedMessages: messageQueue.length,
  };
}

/**
 * Force reconnect to n8n.
 */
async function reconnect() {
  n8nConnected = false;
  await initializeConnection();
  return { connected: n8nConnected };
}

module.exports = {
  sendToN8n,
  initializeConnection,
  getStatus,
  reconnect,
};
