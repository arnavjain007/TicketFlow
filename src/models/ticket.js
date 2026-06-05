/**
 * Ticket data model.
 *
 * CRUD operations for support tickets, escalation logic, and
 * follow-up management. Tickets live in-memory for fast access
 * and are persisted to MySQL for durability.
 */

const { pool, toMySQLDatetime } = require('../config/database');

// ── In-memory store ──────────────────────────────────────────────────────────
// ticketId -> ticket object
const ticketsStore = {};

// ── DB persistence ───────────────────────────────────────────────────────────

/**
 * Upsert a ticket row in MySQL.
 */
async function saveTicketToDb(ticket) {
  try {
    await pool.execute(
      `INSERT INTO tickets
        (id, title, description, chat_summary, priority, status, assigned_to,
         assigned_to_name, category, conversation_id, escalation_level,
         escalated_at, resolved_at, last_response_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
          title = VALUES(title),
          description = VALUES(description),
          chat_summary = VALUES(chat_summary),
          priority = VALUES(priority),
          status = VALUES(status),
          assigned_to = VALUES(assigned_to),
          assigned_to_name = VALUES(assigned_to_name),
          category = VALUES(category),
          escalation_level = VALUES(escalation_level),
          escalated_at = VALUES(escalated_at),
          resolved_at = VALUES(resolved_at),
          last_response_at = VALUES(last_response_at),
          updated_at = VALUES(updated_at)`,
      [
        ticket.id,
        ticket.title || null,
        ticket.description || null,
        ticket.chat_summary || null,
        ticket.priority || 'Medium',
        ticket.status || 'open',
        ticket.assigned_to || null,
        ticket.assigned_to_name || null,
        ticket.category || null,
        ticket.conversationId || null,
        ticket.escalation_level || 0,
        toMySQLDatetime(ticket.escalated_at),
        toMySQLDatetime(ticket.resolved_at),
        toMySQLDatetime(ticket.last_response_at),
        toMySQLDatetime(ticket.created_at || new Date().toISOString()),
        toMySQLDatetime(ticket.updated_at || new Date().toISOString()),
      ],
    );
  } catch (err) {
    console.error('❌ MySQL saveTicket error:', err.message);
  }
}

/**
 * Load all tickets from MySQL (for startup restore).
 */
async function loadTicketsFromDb() {
  try {
    const [rows] = await pool.execute('SELECT * FROM tickets ORDER BY created_at DESC');
    return rows;
  } catch (err) {
    console.error('❌ MySQL loadTickets error:', err.message);
    return [];
  }
}

// ── In-memory CRUD ───────────────────────────────────────────────────────────

/**
 * Create a new ticket and persist it.
 * @param {object} data - Ticket fields
 * @returns {object} The created ticket
 */
function createTicket(data) {
  const now = new Date().toISOString();
  const ticket = {
    id: `ticket_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
    title: data.title || data.ticket_title || null,
    description: data.description || data.ticket_description || null,
    chat_summary: data.chat_summary || '',
    priority: data.priority || 'Medium',
    status: data.status || 'open',
    assigned_to: data.assigned_to || 'support_team',
    assigned_to_name: data.assigned_to_name || null,
    created_at: now,
    updated_at: now,
    last_response_at: null,
    escalated_at: null,
    escalation_level: 0,
    category: data.category || null,
    conversationId: data.conversationId || null,
  };
  ticketsStore[ticket.id] = ticket;
  saveTicketToDb(ticket);
  return ticket;
}

/**
 * Find a ticket by ID.
 */
function getTicket(ticketId) {
  return ticketsStore[ticketId] || null;
}

/**
 * Get all tickets.
 */
function getAllTickets() {
  return Object.values(ticketsStore);
}

/**
 * Delete a ticket by ID (in-memory + DB).
 */
async function deleteTicket(ticketId) {
  delete ticketsStore[ticketId];
  try {
    await pool.query('DELETE FROM tickets WHERE id = ?', [ticketId]);
  } catch (err) {
    console.error('⚠️ Could not delete ticket from MySQL:', err.message);
  }
}

/**
 * Delete all tickets (in-memory + DB).
 */
async function deleteAllTickets() {
  const count = Object.keys(ticketsStore).length;
  for (const id of Object.keys(ticketsStore)) delete ticketsStore[id];
  try {
    await pool.query('DELETE FROM tickets');
  } catch (err) {
    console.error('⚠️ Could not clear tickets from MySQL:', err.message);
  }
  return count;
}

/**
 * Update specific fields on a ticket.
 */
function updateTicket(ticketId, updates) {
  const ticket = ticketsStore[ticketId];
  if (!ticket) return null;
  Object.assign(ticket, updates, { updated_at: new Date().toISOString() });
  saveTicketToDb(ticket);
  return ticket;
}

/**
 * Close (resolve) a ticket.
 * @returns {boolean} true if closed, false if not found
 */
function closeTicket(ticketId) {
  const ticket = ticketsStore[ticketId];
  if (!ticket) return false;
  ticket.status = 'resolved';
  ticket.resolved_at = new Date().toISOString();
  ticket.updated_at = new Date().toISOString();
  console.log(`🔒 Ticket closed: ${ticketId}`);
  saveTicketToDb(ticket);
  return true;
}

/**
 * Find the most recent non-resolved ticket for a conversation.
 */
function findTicketByConversation(conversationId) {
  if (!conversationId) return null;
  const tickets = Object.values(ticketsStore)
    .filter(t => t.conversationId === conversationId && t.status !== 'resolved')
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return tickets.length > 0 ? tickets[0] : null;
}

/**
 * Find any active (non-resolved, non-closed) ticket for a conversation.
 */
function findActiveTicketForConversation(conversationId) {
  if (!conversationId) return null;
  const tickets = Object.values(ticketsStore)
    .filter(t =>
      t.conversationId === conversationId &&
      t.status !== 'resolved' &&
      t.status !== 'closed',
    )
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return tickets.length > 0 ? tickets[0] : null;
}

/**
 * Mark a ticket as awaiting user reply (agent has responded).
 */
function markTicketAwaitingUserReply(conversationId, ticketId) {
  let ticket = ticketId ? ticketsStore[ticketId] : null;
  if (!ticket) ticket = findTicketByConversation(conversationId);
  if (!ticket) return null;
  ticket.status = 'awaiting_user_reply';
  ticket.last_response_at = new Date().toISOString();
  ticket.updated_at = new Date().toISOString();
  console.log(`⏳ Ticket ${ticket.id} marked as awaiting_user_reply`);
  saveTicketToDb(ticket);
  return ticket.id;
}

/**
 * Apply one level of escalation to a ticket (dev → manager → senior_manager).
 * Max 3 levels.
 */
function applyEscalation(ticket, escalatedAt = null) {
  if (!ticket || ticket.status === 'resolved') return ticket;
  const currentLevel = ticket.escalation_level || 0;
  if (currentLevel >= 3) return ticket;

  const nextLevel = currentLevel + 1;
  ticket.escalation_level = nextLevel;
  ticket.status = 'escalated';
  ticket.escalated_at = escalatedAt || new Date().toISOString();
  ticket.updated_at = new Date().toISOString();

  const assignmentMap = {
    1: { assigned_to: 'dev', assigned_to_name: 'Developer' },
    2: { assigned_to: 'manager', assigned_to_name: 'Manager' },
    3: { assigned_to: 'senior_manager', assigned_to_name: 'Senior Manager' },
  };
  Object.assign(ticket, assignmentMap[nextLevel]);

  saveTicketToDb(ticket);
  return ticket;
}

/**
 * Save follow-up data onto an existing ticket.
 */
function saveFollowupTicket(ticket, latestUserMessage, conversationId) {
  if (!ticket) return;

  const oldDescription = ticket.description || '';
  const newDescription = [
    oldDescription ? `Previous Ticket Description: ${oldDescription}` : '',
    latestUserMessage ? `Latest User Follow-Up: ${latestUserMessage}` : '',
  ].filter(Boolean).join('\n\n');

  ticket.previous_ticket_description = oldDescription;
  ticket.latest_user_message = latestUserMessage || '';
  ticket.description = newDescription;
  ticket.category = 'followup_support';
  ticket.conversationId = conversationId || ticket.conversationId || null;

  // Reopen if previously resolved
  if (ticket.status === 'resolved') {
    console.log(`🔓 Reopening resolved ticket ${ticket.id} for follow-up`);
    ticket.resolved_at = null;
  }

  if (ticket.status !== 'escalated') {
    ticket.status = 'existing_ticket_followup';
  }

  ticket.updated_at = new Date().toISOString();
  ticket.last_response_at = new Date().toISOString();

  if (!ticket.followups) ticket.followups = [];
  ticket.followups.push({ message: latestUserMessage || '', created_at: new Date().toISOString() });
  if (ticket.followups.length > 20) ticket.followups = ticket.followups.slice(-20);

  saveTicketToDb(ticket);
  console.log(`📋 Follow-up ticket saved: ${ticket.id} (status: ${ticket.status})`);
}

/**
 * Close the ticket for a conversation (tries explicit ID first, then lookup).
 * @returns {string|null} The closed ticket ID or null
 */
function closeTicketForConversation(conversationId, ticketId) {
  if (ticketId && closeTicket(ticketId)) return ticketId;
  const ticket = findTicketByConversation(conversationId);
  if (ticket) {
    closeTicket(ticket.id);
    return ticket.id;
  }
  return null;
}

/**
 * Restore tickets from DB rows into the in-memory store.
 */
function restoreTickets(rows) {
  for (const row of rows) {
    ticketsStore[row.id] = {
      id: row.id,
      title: row.title,
      description: row.description,
      chat_summary: row.chat_summary,
      priority: row.priority,
      status: row.status,
      assigned_to: row.assigned_to,
      assigned_to_name: row.assigned_to_name,
      category: row.category,
      conversationId: row.conversation_id,
      escalation_level: row.escalation_level,
      escalated_at: row.escalated_at ? new Date(row.escalated_at).toISOString() : null,
      resolved_at: row.resolved_at ? new Date(row.resolved_at).toISOString() : null,
      last_response_at: row.last_response_at ? new Date(row.last_response_at).toISOString() : null,
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
    };
  }
  console.log(`📦 Restored ${rows.length} tickets from MySQL`);
}

module.exports = {
  ticketsStore,
  // CRUD
  createTicket,
  getTicket,
  getAllTickets,
  deleteTicket,
  deleteAllTickets,
  updateTicket,
  closeTicket,
  // Query
  findTicketByConversation,
  findActiveTicketForConversation,
  // State transitions
  markTicketAwaitingUserReply,
  applyEscalation,
  saveFollowupTicket,
  closeTicketForConversation,
  // Persistence
  saveTicketToDb,
  loadTicketsFromDb,
  restoreTickets,
};
