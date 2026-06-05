/**
 * Escalation service.
 *
 * Handles the "escalation gate" (force N bot attempts before allowing
 * ticket creation) and the periodic auto-escalation of stale tickets
 * through the dev → manager → senior_manager pipeline.
 */

const config = require('../config');
const ticketModel = require('../models/ticket');
const { getConversationMessages } = require('../models/message');
const { getChatSummary } = require('./summary');
const teamsService = require('./teams');

// Categories that don't count as real bot resolution attempts
const NON_RESOLUTION_CATEGORIES = new Set([
  'greeting', 'greeting_or_ack', 'thanks', 'goodbye', 'acknowledgment',
  'introduction', 'bot_capability', 'no_issue', 'off_topic', 'gibberish',
  'unclear', 'support_request_pending_details', 'escalation_gate',
  'followup_support', 'casual_ack', 'resolution_check',
  'followup_details_request', 'ticket_resolved', 'clarification',
  'status_inquiry',
]);

/**
 * Count how many substantive bot resolution attempts have been made
 * in a conversation (assistant messages that are actual issue resolutions).
 *
 * @param {string} conversationId
 * @returns {number}
 */
function countBotAttempts(conversationId) {
  const msgs = getConversationMessages(conversationId);
  let count = 0;
  for (const msg of msgs) {
    if (msg.role === 'assistant' && msg.message_text) {
      const cat = (msg.matched_issue || msg.category || '').toLowerCase();
      if (!NON_RESOLUTION_CATEGORIES.has(cat) && msg.message_text.length > 30) {
        count++;
      }
    }
  }
  return count;
}

/**
 * Check if an escalation request should be gated.
 *
 * @param {string} conversationId
 * @returns {{ gated: boolean, response?: string, botAttempts?: number, attemptsNeeded?: number }}
 */
function checkEscalationGate(conversationId) {
  if (!conversationId) return { gated: false };

  const botAttempts = countBotAttempts(conversationId);
  const remaining = config.limits.minBotAttemptsBeforeEscalation - botAttempts;

  if (remaining <= 0) return { gated: false };

  let response;
  if (botAttempts === 0) {
    response = "I'd like to try helping you first before creating a support ticket. Could you please describe the issue you're facing? I might be able to resolve it right away.";
  } else {
    response = "I understand you'd like to reach support, but let me try one more thing first. Could you describe what's still not working? If I'm unable to help, I'll connect you with the support team right away.";
  }

  return { gated: true, response, botAttempts, attemptsNeeded: remaining };
}

/**
 * Run the periodic escalation check — escalate tickets that have
 * been unresolved for longer than the threshold.
 *
 * @param {number} [minutes] - Override threshold in minutes
 */
async function escalateOldTickets(minutes) {
  const threshold = minutes ?? config.limits.escalationThresholdMinutes;
  const now = Date.now();

  console.log('Running escalation check...');

  for (const ticket of ticketModel.getAllTickets()) {
    // Skip tickets that shouldn't be escalated
    if (['resolved', 'closed', 'awaiting_user_reply', 'awaiting_resolution_confirmation'].includes(ticket.status)) continue;
    if ((ticket.escalation_level || 0) >= 3) continue;

    const lastTime = new Date(ticket.escalated_at || ticket.created_at).getTime();

    if (now - lastTime >= threshold * 60 * 1000) {
      const prevLevel = ticket.escalation_level || 0;
      ticketModel.applyEscalation(ticket);
      console.log(`🚨 Escalated: ${ticket.id}, level: ${prevLevel} → ${ticket.escalation_level}, assigned_to: ${ticket.assigned_to}`);

      // Send escalation notification to Teams
      const chatSummary = getChatSummary(ticket.conversationId);
      await teamsService.sendEscalationNotification(ticket, prevLevel, now, chatSummary);
    }
  }
}

/**
 * Start the periodic escalation timer.
 * @returns {NodeJS.Timeout} The interval ID (for cleanup)
 */
function startEscalationTimer() {
  return setInterval(() => {
    escalateOldTickets();
  }, config.limits.escalationCheckIntervalMs);
}

module.exports = {
  countBotAttempts,
  checkEscalationGate,
  escalateOldTickets,
  startEscalationTimer,
};
