/**
 * File upload route.
 *
 * Handles multipart file uploads via multer (images + PDFs only).
 * Files are stored in the uploads directory and a URL is returned.
 */

const express = require('express');
const multer = require('multer');
const config = require('../config');
const { buildLocalFileUrl } = require('../services/attachment');

const router = express.Router();

// ── Multer configuration ─────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.server.uploadsDir),
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}_${Math.random().toString(36).slice(2, 11)}_${file.originalname}`;
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: config.limits.maxUploadSizeMb * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedMimes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];
    if (allowedMimes.includes(file.mimetype)) return cb(null, true);
    cb(new Error('Only images and PDFs are allowed'));
  },
});

// ── Upload endpoint ──────────────────────────────────────────────────────────
router.post('/api/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const fileUrl = buildLocalFileUrl(req.file.filename);

    res.json({
      success: true,
      file_url: fileUrl,
      file_name: req.file.originalname,
      file_type: req.file.mimetype,
      file_size: req.file.size,
    });
  } catch (error) {
    console.error('❌ File upload error:', error.message);
    res.status(500).json({ error: 'File upload failed' });
  }
});

module.exports = router;
