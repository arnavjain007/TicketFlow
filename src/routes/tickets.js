/**
 * Ticket REST routes.
 *
 * Full CRUD + escalation management + follow-up handling for support tickets.
 */

const express = require('express');
const ticketModel = require('../models/ticket');
const { getChatSummary } = require('../services/summary');
const { escalateOldTickets } = require('../services/escalation');

const router = express.Router();

// ── Create ticket ────────────────────────────────────────────────────────────
router.post('/api/tickets', (req, res) => {
  try {
    const data = req.body;
    if (!data.ticket_title || !data.ticket_description) {
      return res.status(400).json({ error: 'Missing ticket_title or ticket_description' });
    }

    const convId = data.conversationId || data.created_from_conversation || null;
    const summaryData = getChatSummary(convId);

    const ticket = ticketModel.createTicket({
      title: data.ticket_title,
      description: data.ticket_description,
      chat_summary: data.chat_summary || summaryData.summary || '',
      priority: data.priority,
      status: data.status,
      assigned_to: data.assigned_to,
      assigned_to_name: data.assigned_to_name,
      category: data.category,
      conversationId: convId,
    });

    res.json({ success: true, ticket_id: ticket.id, message: 'Ticket created successfully', data: ticket });
  } catch (error) {
    console.error('❌ Error creating ticket:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── List all tickets ─────────────────────────────────────────────────────────
router.get('/api/tickets', (req, res) => {
  res.json(ticketModel.getAllTickets());
});

// ── Delete all tickets ───────────────────────────────────────────────────────
router.delete('/api/tickets', async (req, res) => {
  const count = await ticketModel.deleteAllTickets();
  res.json({ success: true, deleted: count });
});

// ── Delete single ticket ─────────────────────────────────────────────────────
router.delete('/api/tickets/:ticketId', async (req, res) => {
  const ticket = ticketModel.getTicket(req.params.ticketId);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  await ticketModel.deleteTicket(req.params.ticketId);
  res.json({ success: true, deleted_ticket: req.params.ticketId });
});

// ── Get ticket status ────────────────────────────────────────────────────────
router.get('/api/tickets/:ticketId/status', (req, res) => {
  const ticket = ticketModel.getTicket(req.params.ticketId);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  res.json({
    ticket_id: ticket.id,
    status: ticket.status,
    escalation_level: ticket.escalation_level,
    created_at: ticket.created_at,
    updated_at: ticket.updated_at,
    last_response_at: ticket.last_response_at,
    escalated_at: ticket.escalated_at,
    assigned_to: ticket.assigned_to,
  });
});

// ── Update ticket fields ─────────────────────────────────────────────────────
router.patch('/api/tickets/:ticketId', (req, res) => {
  const ticket = ticketModel.getTicket(req.params.ticketId);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  const { status, assigned_to, priority } = req.body || {};
  const updates = {};
  if (status) updates.status = status;
  if (assigned_to) updates.assigned_to = assigned_to;
  if (priority) updates.priority = priority;
  updates.last_response_at = new Date().toISOString();

  ticketModel.updateTicket(req.params.ticketId, updates);
  res.json({ success: true, data: ticketModel.getTicket(req.params.ticketId) });
});

// ── Escalate ticket ──────────────────────────────────────────────────────────
router.patch('/api/tickets/:ticketId/escalate', (req, res) => {
  const ticket = ticketModel.getTicket(req.params.ticketId);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  ticketModel.applyEscalation(ticket);
  res.json({ success: true, message: 'Ticket escalated successfully', data: ticket });
});

// ── Mark ticket as escalated ─────────────────────────────────────────────────
router.post('/api/tickets/mark-escalated', (req, res) => {
  try {
    const { ticket_id, escalated = true, escalated_at = null } = req.body || {};
    if (!ticket_id) return res.status(400).json({ error: 'ticket_id is required' });

    const ticket = ticketModel.getTicket(ticket_id);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    if (escalated) ticketModel.applyEscalation(ticket, escalated_at);

    res.json({ success: true, message: 'Ticket marked as escalated', data: ticket });
  } catch (error) {
    console.error('❌ Error marking ticket escalated:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Escalation-due tickets ───────────────────────────────────────────────────
router.post('/api/tickets/escalation-due', (req, res) => {
  try {
    const { days_without_response = 0 } = req.body || {};
    const now = Date.now();

    const dueTickets = ticketModel.getAllTickets().filter(ticket => {
      if (ticket.status === 'resolved') return false;
      const lastTime = ticket.last_response_at
        ? new Date(ticket.last_response_at).getTime()
        : new Date(ticket.created_at).getTime();
      return (now - lastTime) >= days_without_response * 24 * 60 * 60 * 1000;
    });

    res.json({ success: true, count: dueTickets.length, tickets: dueTickets });
  } catch (error) {
    console.error('❌ Error fetching escalation tickets:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Ticket follow-up ─────────────────────────────────────────────────────────
router.post('/api/tickets/followup', (req, res) => {
  try {
    const {
      ticket_id, conversationId = null, latest_user_message = '',
      previous_ticket_description = '', merged_description = '',
      assigned_to = null, assigned_to_name = null, category = 'followup_support',
    } = req.body || {};

    if (!ticket_id) return res.status(400).json({ success: false, error: 'ticket_id is required' });

    const ticket = ticketModel.getTicket(ticket_id);
    if (!ticket) return res.status(404).json({ success: false, error: 'Ticket not found' });

    // Build merged description
    const oldDescription = previous_ticket_description || ticket.description || '';
    const newDescription = merged_description || [
      oldDescription ? `Previous Ticket Description: ${oldDescription}` : '',
      latest_user_message ? `Latest User Follow-Up: ${latest_user_message}` : '',
    ].filter(Boolean).join('\n\n');

    ticket.previous_ticket_description = oldDescription;
    ticket.latest_user_message = latest_user_message || '';
    ticket.description = newDescription;
    ticket.category = category || ticket.category || 'followup_support';
    ticket.conversationId = conversationId || ticket.conversationId || null;

    if (ticket.status === 'resolved') {
      console.log(`🔓 Reopening resolved ticket ${ticket_id} for follow-up`);
      ticket.resolved_at = null;
    }

    if (ticket.status !== 'escalated') ticket.status = 'existing_ticket_followup';

    ticket.updated_at = new Date().toISOString();
    ticket.last_response_at = new Date().toISOString();

    if (assigned_to) ticket.assigned_to = assigned_to;
    if (assigned_to_name) ticket.assigned_to_name = assigned_to_name;

    if (!ticket.followups) ticket.followups = [];
    ticket.followups.push({ message: latest_user_message || '', created_at: new Date().toISOString() });
    if (ticket.followups.length > 20) ticket.followups = ticket.followups.slice(-20);

    ticketModel.saveTicketToDb(ticket);

    return res.json({ success: true, message: 'Follow-up saved successfully', ticket_id: ticket.id, data: ticket });
  } catch (error) {
    console.error('❌ Error saving follow-up ticket:', error.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── Find ticket by conversation ──────────────────────────────────────────────
router.get('/api/tickets/by-conversation/:conversationId', (req, res) => {
  try {
    const { conversationId } = req.params;
    if (!conversationId) return res.status(400).json({ success: false, error: 'conversationId is required' });

    const matchingTickets = ticketModel.getAllTickets()
      .filter(t => t.conversationId === conversationId)
      .sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));

    if (matchingTickets.length === 0) {
      return res.status(404).json({ success: false, error: 'No tickets found for this conversation', conversationId });
    }

    const latest = matchingTickets[0];
    return res.json({ success: true, ticket_id: latest.id, ticket: latest, total_tickets: matchingTickets.length });
  } catch (error) {
    console.error('❌ Error looking up ticket by conversation:', error.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── Force recheck escalation ─────────────────────────────────────────────────
router.post('/api/tickets/recheck', (req, res) => {
  escalateOldTickets(0);
  res.json({ success: true });
});

module.exports = router;
