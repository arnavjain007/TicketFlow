/**
 * Attachment extraction service.
 *
 * Extracts text content from uploaded files:
 * - PDF files → pdf-parse
 * - Images (PNG, JPG, etc.) → Tesseract OCR
 *
 * The extracted text is summarized and sent to n8n along with the
 * user message so the AI can reason about file contents.
 */

const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const Tesseract = require('tesseract.js');
const config = require('../config');

/**
 * Truncate text to a maximum length, appending "..." if truncated.
 * @param {string} text
 * @param {number} [maxLength=500]
 * @returns {string}
 */
function summarizeText(text = '', maxLength = 500) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length <= maxLength ? clean : `${clean.slice(0, maxLength)}...`;
}

/**
 * Extract the filename from a URL.
 */
function extractFilenameFromUrl(fileUrl = '') {
  try {
    const pathname = new URL(fileUrl).pathname;
    return decodeURIComponent(path.basename(pathname));
  } catch {
    return path.basename(fileUrl || '');
  }
}

/**
 * Resolve the local filesystem path for an uploaded file.
 * Checks both the URL-derived filename and the explicit file_name.
 *
 * @param {string} fileUrl
 * @param {string} fileName
 * @returns {string|null} Resolved path or null if not found
 */
function resolveLocalUploadPath(fileUrl = '', fileName = '') {
  const filenameFromUrl = extractFilenameFromUrl(fileUrl);
  const candidates = [filenameFromUrl, fileName].filter(Boolean);

  for (const candidate of candidates) {
    const filePath = path.join(config.server.uploadsDir, candidate);
    if (fs.existsSync(filePath)) return filePath;
  }

  return null;
}

/**
 * Extract text content from an attachment file.
 *
 * @param {{ file_url: string, file_type: string, file_name: string }} params
 * @returns {Promise<{ success: boolean, attachment_text: string, attachment_summary: string, extraction_method: string, error?: string }>}
 */
async function extractAttachmentContent({ file_url, file_type, file_name }) {
  const filePath = resolveLocalUploadPath(file_url, file_name);

  if (!filePath) {
    return {
      success: false,
      attachment_text: '',
      attachment_summary: '',
      extraction_method: 'not_found',
      error: 'Attachment file not found on server',
    };
  }

  const resolvedType = file_type || '';
  const lowerName = String(file_name || filePath).toLowerCase();

  try {
    // PDF extraction
    if (resolvedType === 'application/pdf' || lowerName.endsWith('.pdf')) {
      const buffer = fs.readFileSync(filePath);
      const parsed = await pdfParse(buffer);
      const attachmentText = (parsed.text || '').trim();

      return {
        success: true,
        attachment_text: attachmentText,
        attachment_summary: summarizeText(attachmentText, 1200),
        extraction_method: 'pdf-parse',
      };
    }

    // Image OCR extraction
    if (resolvedType.startsWith('image/') ||
        ['.png', '.jpg', '.jpeg', '.gif', '.webp'].some(ext => lowerName.endsWith(ext))) {
      const ocrResult = await Tesseract.recognize(filePath, 'eng');
      const attachmentText = (ocrResult?.data?.text || '').trim();

      return {
        success: true,
        attachment_text: attachmentText,
        attachment_summary: summarizeText(attachmentText, 1200),
        extraction_method: 'tesseract',
      };
    }

    return {
      success: false,
      attachment_text: '',
      attachment_summary: '',
      extraction_method: 'unsupported',
      error: 'Unsupported attachment type',
    };
  } catch (error) {
    return {
      success: false,
      attachment_text: '',
      attachment_summary: '',
      extraction_method: 'error',
      error: error.message,
    };
  }
}

/**
 * Build a local file URL from a filename.
 * @param {string} filename
 * @returns {string}
 */
function buildLocalFileUrl(filename) {
  return `http://localhost:${config.server.port}/${filename}`;
}

module.exports = {
  summarizeText,
  extractFilenameFromUrl,
  resolveLocalUploadPath,
  extractAttachmentContent,
  buildLocalFileUrl,
};
