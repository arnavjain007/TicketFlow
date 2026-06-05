/**
 * Microsoft Teams integration service.
 *
 * Handles sending notifications to Teams via Power Automate webhooks:
 * - Follow-up notifications when users reply on open tickets
 * - Escalation notifications when tickets are auto-escalated
 * - Thread mapping for correlating Teams replies back to conversations
 */

const axios = require('axios');
const config = require('../config');

// ── Teams thread mapping ─────────────────────────────────────────────────────
// teamsMessageId -> { teamsMessageId, conversationId, ticket_id }
const teamsThreadMap = {};

/**
 * Register a mapping between a Teams message and a chat conversation.
 */
function registerThread(teamsMessageId, conversationId, ticketId = null) {
  teamsThreadMap[String(teamsMessageId)] = {
    teamsMessageId: String(teamsMessageId),
    conversationId,
    ticket_id: ticketId,
  };
  console.log('✅ Registered Teams thread mapping:', { teamsMessageId, conversationId, ticketId });
}

/**
 * Resolve a conversation from a Teams reply-to message ID.
 * @returns {{ conversationId, ticket_id, teamsMessageId } | null}
 */
function resolveConversation(replyToMessageId) {
  const key = String(replyToMessageId || '');
  return teamsThreadMap[key] || null;
}

/**
 * Get the full thread map (for debugging).
 */
function getThreadMap() {
  return teamsThreadMap;
}

// ── Teams notifications ──────────────────────────────────────────────────────

/**
 * Send a follow-up notification to Teams for an active ticket.
 *
 * @param {object} ticket
 * @param {object} messageData - The user's follow-up message
 * @param {{ summary: string }} chatSummary
 */
async function sendFollowupNotification(ticket, messageData, chatSummary) {
  if (!config.teams.webhookUrl) {
    console.warn('⚠️ TEAMS_WEBHOOK_URL not configured, skipping notification');
    return;
  }

  try {
    const teamsPayload = {
      '@type': 'MessageCard',
      '@context': 'http://schema.org/extensions',
      summary: `Follow-up on ticket: ${ticket.id}`,
      themeColor: '0078D7',
      title: '💬 User Follow-Up Reply',
      text: `CHAT_CONVERSATION_ID: ${messageData.conversationId || 'N/A'}`,
      sections: [{
        facts: [
          { name: 'Ticket ID', value: ticket.id || '' },
          { name: 'User Message', value: messageData.text || '' },
          { name: 'Previous Description', value: ticket.description || 'N/A' },
          { name: 'Assigned To', value: ticket.assigned_to_name || ticket.assigned_to || 'Support Team' },
          { name: 'Status', value: 'User Follow-Up' },
          { name: 'Chat Summary', value: chatSummary.summary || 'No summary available' },
        ],
      }],
    };

    await axios.post(config.teams.webhookUrl, teamsPayload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: config.teams.timeout,
    });
    console.log(`📤 Follow-up Teams notification sent for ticket ${ticket.id}`);
  } catch (err) {
    console.error(`❌ Failed to send follow-up Teams notification for ticket ${ticket.id}:`, err.message);
  }
}

/**
 * Send an escalation notification to Teams when a ticket is auto-escalated.
 *
 * @param {object} ticket
 * @param {number} prevLevel - Previous escalation level
 * @param {number} now - Current timestamp (ms)
 * @param {{ summary: string }} chatSummary
 */
async function sendEscalationNotification(ticket, prevLevel, now, chatSummary) {
  if (!config.teams.webhookUrl) return;

  try {
    const assignedLabel = ticket.assigned_to_name || ticket.assigned_to || 'Unknown';
    const teamsPayload = {
      '@type': 'MessageCard',
      '@context': 'http://schema.org/extensions',
      summary: `Ticket escalated: ${ticket.id}`,
      themeColor: ticket.escalation_level >= 3 ? 'FF0000' : ticket.escalation_level >= 2 ? 'E81123' : 'FFA500',
      title: `⚠️ Ticket Escalation — Level ${ticket.escalation_level}`,
      text: `CHAT_CONVERSATION_ID: ${ticket.conversationId || 'N/A'}`,
      sections: [{
        facts: [
          { name: 'Ticket ID', value: ticket.id || '' },
          { name: 'Title', value: ticket.title || 'Support Ticket' },
          { name: 'Description', value: ticket.description || ticket.ticket_description || 'No description' },
          { name: 'Priority', value: ticket.priority || 'Medium' },
          { name: 'Category', value: ticket.category || 'manual_ticket' },
          { name: 'Assigned To', value: assignedLabel },
          { name: 'Status', value: ticket.status || 'escalated' },
          { name: 'Escalation Level', value: `${prevLevel} → ${ticket.escalation_level}` },
          { name: 'Escalation Path', value: 'Developer → Manager → Senior Manager' },
          { name: 'Time Without Response', value: `${Math.round((now - new Date(ticket.created_at).getTime()) / 60000)} minutes` },
          { name: 'Created At', value: ticket.created_at || '' },
          { name: 'Chat Summary', value: chatSummary.summary || 'No summary available' },
        ],
      }],
    };

    await axios.post(config.teams.webhookUrl, teamsPayload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: config.teams.timeout,
    });
    console.log(`📤 Teams escalation notification sent for ticket ${ticket.id} (level ${ticket.escalation_level})`);
  } catch (err) {
    console.error(`❌ Failed to send Teams escalation for ticket ${ticket.id}:`, err.message);
  }
}

module.exports = {
  teamsThreadMap,
  registerThread,
  resolveConversation,
  getThreadMap,
  sendFollowupNotification,
  sendEscalationNotification,
};
