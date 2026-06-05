/**
 * Chat Summary service.
 *
 * Builds and maintains a running text summary for each conversation,
 * tracking user/assistant turns, issues raised, tickets created, and
 * attachment summaries. Used to give n8n and the support team full context.
 */

// conversationId -> { turns, pendingUser, issuesRaised, ticketIds, attachmentSummaries, summary }
const chatSummaryStore = {};

/**
 * Update the running chat summary for a conversation.
 *
 * Call this after every user or assistant message. Pairs user messages
 * with assistant responses into "turns" and rebuilds the summary text.
 *
 * @param {string} conversationId
 * @param {object} data
 * @param {string} [data.user_message]
 * @param {string} [data.assistant_message]
 * @param {string} [data.intent]
 * @param {string} [data.matched_issue]
 * @param {string} [data.issue_summary]
 * @param {string} [data.attachment_summary]
 * @param {string} [data.ticket_id]
 */
function updateChatSummary(conversationId, {
  user_message, assistant_message, intent, matched_issue,
  issue_summary, attachment_summary, ticket_id,
}) {
  if (!conversationId) return;

  if (!chatSummaryStore[conversationId]) {
    chatSummaryStore[conversationId] = {
      turns: [],
      pendingUser: null,
      issuesRaised: [],
      ticketIds: [],
      attachmentSummaries: [],
      summary: '',
    };
  }

  const store = chatSummaryStore[conversationId];
  const timestamp = new Date().toISOString();

  // Track unique issues
  if (matched_issue && !['no_match', 'greeting_or_ack', 'gibberish'].includes(matched_issue)) {
    if (!store.issuesRaised.includes(matched_issue)) store.issuesRaised.push(matched_issue);
  }

  if (attachment_summary && !store.attachmentSummaries.includes(attachment_summary)) {
    store.attachmentSummaries.push(attachment_summary);
  }

  if (ticket_id && !store.ticketIds.includes(ticket_id)) {
    store.ticketIds.push(ticket_id);
  }

  // Buffer user message until assistant responds (to pair as one turn)
  if (user_message) {
    if (!store.pendingUser || store.pendingUser.text !== user_message) {
      store.pendingUser = { text: user_message, timestamp };
    }
  }

  // Pair with pending user message when assistant responds
  if (assistant_message) {
    const userText = store.pendingUser ? store.pendingUser.text : null;
    const userTs = store.pendingUser ? store.pendingUser.timestamp : timestamp;

    // Dedup: skip if last turn has the exact same user + assistant text
    const lastTurn = store.turns.length > 0 ? store.turns[store.turns.length - 1] : null;
    const isDup = lastTurn && lastTurn.user === userText && lastTurn.assistant === assistant_message;

    if (!isDup) {
      store.turns.push({
        user: userText,
        assistant: assistant_message,
        category: matched_issue || null,
        ticket_id: ticket_id || null,
        timestamp: userTs,
      });
    }

    store.pendingUser = null;
  }

  // Rebuild the summary text
  const parts = [];
  const turnCount = store.turns.length + (store.pendingUser ? 1 : 0);
  parts.push(`=== Chat Summary (${turnCount} turns) ===`);

  if (store.issuesRaised.length > 0) parts.push(`Issues: ${store.issuesRaised.join(', ')}`);
  if (store.ticketIds.length > 0) parts.push(`Tickets: ${store.ticketIds.join(', ')}`);
  if (store.attachmentSummaries.length > 0) parts.push(`Attachments: ${store.attachmentSummaries.join(' | ')}`);
  parts.push('');

  for (let i = 0; i < store.turns.length; i++) {
    const t = store.turns[i];
    if (t.user) parts.push(`User: ${t.user}`);
    parts.push(`Support: ${t.assistant}`);
    if (t.ticket_id) parts.push(`  [Ticket created: ${t.ticket_id}]`);
    if (i < store.turns.length - 1) parts.push('');
  }

  // Include unanswered user message
  if (store.pendingUser) {
    if (store.turns.length > 0) parts.push('');
    parts.push(`User: ${store.pendingUser.text}`);
    parts.push('Support: (awaiting response)');
  }

  store.summary = parts.join('\n');
}

/**
 * Get the current summary object for a conversation.
 * @param {string} conversationId
 * @returns {{ summary: string, turns: object[], issuesRaised: string[], ticketIds: string[], attachmentSummaries: string[] }}
 */
function getChatSummary(conversationId) {
  if (!conversationId || !chatSummaryStore[conversationId]) {
    return { summary: '', turns: [], issuesRaised: [], ticketIds: [], attachmentSummaries: [] };
  }
  return chatSummaryStore[conversationId];
}

module.exports = {
  updateChatSummary,
  getChatSummary,
};
