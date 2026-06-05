/**
 * Moderation REST routes.
 *
 * Admin endpoints for managing the moderation queue:
 * listing pending items, approving, and rejecting.
 */

const express = require('express');
const moderationModel = require('../models/moderation');
const { deliverModerationItem } = require('../socket/helpers');

const router = express.Router();

// ── List pending moderation items ────────────────────────────────────────────
router.get('/api/moderation/queue', (req, res) => {
  res.json(moderationModel.getPendingItems());
});

// ── List all moderation items (history) ──────────────────────────────────────
router.get('/api/moderation/all', (req, res) => {
  res.json(moderationModel.getAllItems());
});

// ── Approve a moderation item ────────────────────────────────────────────────
router.post('/api/moderation/approve/:id', (req, res) => {
  const item = moderationModel.getModerationItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'Moderation item not found' });
  if (item.status !== 'pending') return res.status(400).json({ error: `Item already ${item.status}` });

  item.status = 'approved';
  console.log('✅ MODERATION: Approved ->', item.id);
  moderationModel.updateModerationStatusInDb(item.id, 'approved');

  const io = req.app.get('io');
  const delivered = deliverModerationItem(io, item);
  if (io) io.emit('moderation:resolved', { id: item.id, status: 'approved' });

  res.json({ success: true, status: 'approved', delivered });
});

// ── Reject a moderation item ─────────────────────────────────────────────────
router.post('/api/moderation/reject/:id', (req, res) => {
  const item = moderationModel.getModerationItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'Moderation item not found' });
  if (item.status !== 'pending') return res.status(400).json({ error: `Item already ${item.status}` });

  item.status = 'rejected';
  console.log('❌ MODERATION: Rejected ->', item.id);
  moderationModel.updateModerationStatusInDb(item.id, 'rejected');

  const io = req.app.get('io');
  if (io) io.emit('moderation:resolved', { id: item.id, status: 'rejected' });

  res.json({ success: true, status: 'rejected' });
});

module.exports = router;
