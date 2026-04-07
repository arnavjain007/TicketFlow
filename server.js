const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const Tesseract = require('tesseract.js');
const mysql = require('mysql2/promise');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST', 'PATCH', 'DELETE']
    }
});

const PORT = process.env.PORT || 8000;
const N8N_WEBHOOK_URL =
    process.env.N8N_WEBHOOK_URL || 'https://cognately-overvigorous-clarinda.ngrok-free.dev/webhook/chat-support';

// -------------------- GLOBAL STORES --------------------

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

let messages = [];
let activeUsers = 0;
let n8nConnected = false;
let messageQueue = [];

const chatMemoryStore = {};
const chatSummaryStore = {};  // conversationId -> { lines: string[], summary: string }
const conversationsStore = {};
const conversationMessagesStore = {};
const ticketsStore = {};
const teamsThreadMap = {};

const processedTeamsReplies = new Map();
const moderationQueue = {};   // id -> { id, conversationId, sender, text, teamsMessageId, replyToMessageId, category, ticket_id, originalMessageId, messageId, timestamp, status:'pending' }
const escalationGateStore = {}; // conversationId -> { botAttempts: number, escalationAllowed: boolean }
let sendResponseHitCount = 0;

// -------------------- MEMORY CAPS --------------------
const MAX_MESSAGES = 2000;
const MAX_CONVERSATION_MESSAGES = 300;

function capArray(arr, max) {
    if (arr.length > max) arr.splice(0, arr.length - max);
}

// -------------------- MYSQL DATABASE --------------------

const dbPool = mysql.createPool({
    host: process.env.MYSQL_HOST || 'localhost',
    port: parseInt(process.env.MYSQL_PORT || '3306', 10),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'chatsupport',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: 'utf8mb4'
});

/** Convert any date value to MySQL DATETIME format (YYYY-MM-DD HH:MM:SS) */
function toMySQLDatetime(val) {
    if (!val) return null;
    const d = new Date(val);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 19).replace('T', ' ');
}

const db = {
    /** Insert or update a moderation_log row */
    async saveModerationItem(item) {
        try {
            const mod = item.moderation || {};
            await dbPool.execute(
                `INSERT INTO moderation_log
                    (id, conversation_id, sender, text, original_text, teams_message_id,
                     reply_to_message_id, category, ticket_id, original_message_id,
                     message_id, status, moderation_method, moderation_issues,
                     moderation_reason, refined_text, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    status = VALUES(status),
                    text = VALUES(text),
                    moderation_method = VALUES(moderation_method),
                    moderation_issues = VALUES(moderation_issues),
                    moderation_reason = VALUES(moderation_reason),
                    refined_text = VALUES(refined_text),
                    resolved_at = IF(VALUES(status) != 'pending', NOW(), resolved_at)`,
                [
                    item.id,
                    item.conversationId || null,
                    item.sender || null,
                    item.text || null,
                    item.originalText || item.text || null,
                    item.teamsMessageId || null,
                    item.replyToMessageId || null,
                    item.category || null,
                    item.ticket_id || null,
                    item.originalMessageId || null,
                    item.messageId || null,
                    item.status || 'pending',
                    mod.method || null,
                    mod.scriptIssues || mod.issues ? JSON.stringify(mod.scriptIssues || mod.issues) : null,
                    mod.llmReason || null,
                    mod.refinedText || null,
                    toMySQLDatetime(item.timestamp || new Date().toISOString())
                ]
            );
        } catch (err) {
            console.error('❌ MySQL saveModerationItem error:', err.message);
        }
    },

    /** Update moderation status (approve/reject) */
    async updateModerationStatus(id, status) {
        try {
            await dbPool.execute(
                `UPDATE moderation_log SET status = ?, resolved_at = NOW() WHERE id = ?`,
                [status, id]
            );
        } catch (err) {
            console.error('❌ MySQL updateModerationStatus error:', err.message);
        }
    },

    /** Insert or update a ticket */
    async saveTicket(ticket) {
        try {
            await dbPool.execute(
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
                    toMySQLDatetime(ticket.updated_at || new Date().toISOString())
                ]
            );
        } catch (err) {
            console.error('❌ MySQL saveTicket error:', err.message);
        }
    },

    /** Save a chat message */
    async saveChatMessage({ conversationId, messageId, role, messageText, intent, matchedIssue, issueSummary, attachmentSummary, ticketId, fileUrl, fileType, fileName, createdAt }) {
        try {
            await dbPool.execute(
                `INSERT INTO chat_messages
                    (conversation_id, message_id, role, message_text, intent, matched_issue,
                     issue_summary, attachment_summary, ticket_id, file_url, file_type,
                     file_name, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    conversationId || null,
                    messageId || null,
                    role,
                    messageText || null,
                    intent || null,
                    matchedIssue || null,
                    issueSummary || null,
                    attachmentSummary || null,
                    ticketId || null,
                    fileUrl || null,
                    fileType || null,
                    fileName || null,
                    toMySQLDatetime(createdAt || new Date().toISOString())
                ]
            );
        } catch (err) {
            console.error('❌ MySQL saveChatMessage error:', err.message);
        }
    },

    /** Load all moderation items (for restoring in-memory queue on restart) */
    async loadModerationItems() {
        try {
            const [rows] = await dbPool.execute(
                `SELECT * FROM moderation_log ORDER BY created_at DESC LIMIT 500`
            );
            return rows;
        } catch (err) {
            console.error('❌ MySQL loadModerationItems error:', err.message);
            return [];
        }
    },

    /** Load all non-resolved tickets (for restoring ticketsStore on restart) */
    async loadTickets() {
        try {
            const [rows] = await dbPool.execute(
                `SELECT * FROM tickets ORDER BY created_at DESC`
            );
            return rows;
        } catch (err) {
            console.error('❌ MySQL loadTickets error:', err.message);
            return [];
        }
    },

    /** Test connection */
    async testConnection() {
        try {
            await dbPool.execute('SELECT 1');
            console.log('✅ MySQL connected to', process.env.MYSQL_DATABASE || 'chatsupport');
            return true;
        } catch (err) {
            console.error('❌ MySQL connection failed:', err.message);
            return false;
        }
    }
};

// -------------------- CHAT SUMMARY ENGINE --------------------

/**
 * Build/update a running chat summary for a conversation.
 * Stores clean request/response pairs — no duplicate metadata.
 */
function updateChatSummary(conversationId, { user_message, assistant_message, intent, matched_issue, issue_summary, attachment_summary, ticket_id }) {
    if (!conversationId) return;

    if (!chatSummaryStore[conversationId]) {
        chatSummaryStore[conversationId] = {
            turns: [],          // { user, assistant, category, ticket_id, timestamp }
            pendingUser: null,   // holds user msg until assistant responds
            issuesRaised: [],
            ticketIds: [],
            attachmentSummaries: [],
            summary: ''
        };
    }

    const store = chatSummaryStore[conversationId];
    const timestamp = new Date().toISOString();

    // Track issues
    if (matched_issue && matched_issue !== 'no_match' && matched_issue !== 'greeting_or_ack' && matched_issue !== 'gibberish') {
        if (!store.issuesRaised.includes(matched_issue)) {
            store.issuesRaised.push(matched_issue);
        }
    }

    if (attachment_summary && !store.attachmentSummaries.includes(attachment_summary)) {
        store.attachmentSummaries.push(attachment_summary);
    }

    if (ticket_id && !store.ticketIds.includes(ticket_id)) {
        store.ticketIds.push(ticket_id);
    }

    // Store user message (wait for assistant response to pair them)
    if (user_message) {
        // Dedup: don't overwrite if the same message is already pending
        if (!store.pendingUser || store.pendingUser.text !== user_message) {
            store.pendingUser = { text: user_message, timestamp };
        }
    }

    // When assistant responds, pair with pending user message as one turn
    if (assistant_message) {
        const userText = store.pendingUser ? store.pendingUser.text : null;
        const userTs = store.pendingUser ? store.pendingUser.timestamp : timestamp;

        // Dedup: skip if last turn has the exact same user+assistant text
        const lastTurn = store.turns.length > 0 ? store.turns[store.turns.length - 1] : null;
        const isDup = lastTurn &&
            lastTurn.user === userText &&
            lastTurn.assistant === assistant_message;

        if (!isDup) {
            store.turns.push({
                user: userText,
                assistant: assistant_message,
                category: matched_issue || null,
                ticket_id: ticket_id || null,
                timestamp: userTs
            });
        }

        store.pendingUser = null; // consumed
    }

    // Rebuild the summary text
    const parts = [];
    const turnCount = store.turns.length + (store.pendingUser ? 1 : 0);
    parts.push(`=== Chat Summary (${turnCount} turns) ===`);

    if (store.issuesRaised.length > 0) {
        parts.push(`Issues: ${store.issuesRaised.join(', ')}`);
    }
    if (store.ticketIds.length > 0) {
        parts.push(`Tickets: ${store.ticketIds.join(', ')}`);
    }
    if (store.attachmentSummaries.length > 0) {
        parts.push(`Attachments: ${store.attachmentSummaries.join(' | ')}`);
    }

    parts.push('');

    for (let i = 0; i < store.turns.length; i++) {
        const t = store.turns[i];
        if (t.user) {
            parts.push(`User: ${t.user}`);
        }
        parts.push(`Support: ${t.assistant}`);
        if (t.ticket_id) {
            parts.push(`  [Ticket created: ${t.ticket_id}]`);
        }
        if (i < store.turns.length - 1) parts.push('');
    }

    // If there's an unanswered user message, include it
    if (store.pendingUser) {
        if (store.turns.length > 0) parts.push('');
        parts.push(`User: ${store.pendingUser.text}`);
        parts.push(`Support: (awaiting response)`);
    }

    store.summary = parts.join('\n');
}

/**
 * Get the current chat summary for a conversation.
 */
function getChatSummary(conversationId) {
    if (!conversationId || !chatSummaryStore[conversationId]) {
        return { summary: '', turns: [], issuesRaised: [], ticketIds: [], attachmentSummaries: [] };
    }
    return chatSummaryStore[conversationId];
}

// -------------------- MODERATION ENGINE --------------------

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = 'gemini-2.0-flash';

// Profanity / rudeness word list (lowercase)
const PROFANITY_LIST = [
    'fuck', 'shit', 'damn', 'ass', 'bitch', 'bastard', 'crap', 'dick',
    'piss', 'hell', 'idiot', 'stupid', 'moron', 'dumb', 'retard',
    'wtf', 'stfu', 'lmao', 'lmfao', 'af', 'bs',
    'shut up', 'screw you', 'go to hell', 'piss off', 'f off',
    'useless', 'incompetent', 'pathetic', 'worthless', 'trash',
    'suck', 'sucks', 'cunt', 'twat', 'wanker', 'douche'
];

// Rudeness patterns (regex)
const RUDENESS_PATTERNS = [
    /you('re| are)\s+(useless|stupid|dumb|incompetent|pathetic|worthless|an?\s+idiot)/i,
    /don'?t\s+waste\s+my\s+time/i,
    /i\s+don'?t\s+care\s+(about|what)/i,
    /figure\s+it\s+out\s+yourself/i,
    /not\s+my\s+(problem|job|concern)/i,
    /deal\s+with\s+it/i,
    /that'?s\s+your\s+(fault|problem)/i,
    /stop\s+(bothering|bugging|annoying)/i,
    /go\s+away/i,
    /leave\s+me\s+alone/i
];

// Common words set for gibberish detection (module-level, created once)
const COMMON_WORDS = new Set([
    // determiners / pronouns / auxiliaries
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
    'do', 'does', 'did', 'will', 'would', 'shall', 'should', 'may', 'might', 'can', 'could',
    'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
    'my', 'your', 'his', 'its', 'our', 'their', 'mine', 'yours', 'ours', 'theirs',
    'this', 'that', 'these', 'those', 'what', 'which', 'who', 'whom', 'whose',
    'and', 'but', 'or', 'nor', 'not', 'no', 'yes', 'so', 'if', 'then', 'than', 'as',
    'at', 'by', 'for', 'from', 'in', 'into', 'of', 'on', 'to', 'with', 'up', 'out',
    'about', 'after', 'before', 'between', 'through', 'during', 'above', 'below',
    'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such',
    'only', 'own', 'same', 'very', 'just', 'also', 'now', 'here', 'there', 'when',
    'where', 'how', 'why', 'too', 'again', 'once', 'please', 'try', 'go', 'get',
    // common verbs
    'make', 'take', 'come', 'see', 'know', 'think', 'look', 'want', 'give', 'use',
    'find', 'tell', 'ask', 'work', 'call', 'need', 'feel', 'become', 'leave', 'put',
    'mean', 'keep', 'let', 'begin', 'seem', 'help', 'show', 'hear', 'play', 'run',
    'move', 'like', 'live', 'believe', 'hold', 'bring', 'happen', 'write', 'provide',
    'sit', 'stand', 'lose', 'pay', 'meet', 'include', 'continue', 'set', 'learn',
    'change', 'lead', 'understand', 'watch', 'follow', 'stop', 'create', 'speak',
    'read', 'allow', 'add', 'spend', 'grow', 'open', 'walk', 'win', 'offer', 'remember',
    'love', 'consider', 'appear', 'buy', 'wait', 'serve', 'die', 'send', 'expect',
    'build', 'stay', 'fall', 'cut', 'reach', 'kill', 'remain', 'suggest', 'raise',
    'pass', 'sell', 'require', 'report', 'decide', 'pull', 'check', 'clear', 'cache',
    'close', 'closed', 'closing', 'assign', 'assigned', 'handle', 'handled',
    'forward', 'forwarded', 'forwarding', 'transfer', 'transferred',
    'respond', 'responded', 'responding', 'notify', 'notified',
    'confirm', 'confirmed', 'confirmation', 'acknowledge', 'acknowledged',
    'investigate', 'investigating', 'investigation', 'review', 'reviewed', 'reviewing',
    'process', 'processed', 'processing', 'complete', 'completed', 'completing',
    'approve', 'approved', 'reject', 'rejected', 'verify', 'verified', 'verifying',
    'submit', 'submitted', 'submitting', 'receive', 'received',
    // support / business domain
    'cookies', 'browser', 'refresh', 'update', 'updated', 'reset', 'error', 'issue', 'issues',
    'problem', 'problems', 'ticket', 'tickets', 'support', 'team', 'account', 'login',
    'password', 'page', 'system', 'server', 'status', 'loan', 'loans', 'payment', 'payments',
    'repayment', 'repayments', 'bank', 'amount', 'balance',
    'escalation', 'escalated', 'escalate', 'escalating',
    'resolution', 'resolve', 'resolved', 'resolving',
    'reply', 'replied', 'response', 'request', 'requested', 'requesting',
    'fix', 'fixed', 'fixing', 'working', 'still', 'already', 'pending', 'failed', 'done',
    'correct', 'incorrect', 'wrong', 'right', 'good', 'bad', 'new', 'old', 'newest', 'latest',
    'looking', 'checking', 'noted', 'please', 'kindly', 'regards',
    'soon', 'shortly', 'immediately', 'asap', 'urgent', 'priority',
    'customer', 'user', 'client', 'agent', 'admin', 'manager',
    'document', 'documents', 'file', 'files', 'upload', 'uploaded', 'download',
    'access', 'accessed', 'permission', 'permissions', 'role', 'roles',
    'company', 'facility', 'tranche', 'disbursement', 'kyc', 'ckyc', 'cibil',
    'pan', 'aadhaar', 'gstin', 'cin', 'otp', 'signatory',
    'application', 'applied', 'progress', 'step', 'steps', 'stage',
    'information', 'info', 'detail', 'details', 'data', 'record', 'records',
    'message', 'messages', 'notification', 'notifications',
    // greetings / closings / common phrases
    'ok', 'okay', 'sure', 'thanks', 'thank', 'sorry', 'hello', 'hi', 'hey',
    'glad', 'happy', 'great', 'fine', 'nice', 'welcome', 'apologies', 'apologize',
    'further', 'additional', 'another', 'anything', 'everything', 'something', 'nothing',
    'able', 'unable', 'available', 'unavailable', 'possible', 'impossible',
    'today', 'tomorrow', 'yesterday', 'morning', 'evening', 'afternoon',
    'time', 'date', 'day', 'week', 'month', 'hours', 'minutes',
    'back', 'next', 'last', 'first', 'second', 'third',
    'try', 'tried', 'trying', 'test', 'tested', 'testing',
    'log', 'logged', 'logs', 'screenshot', 'screenshots', 'image', 'images',
    'link', 'url', 'email', 'mail', 'phone', 'number', 'address',
    'share', 'shared', 'sharing', 'attach', 'attached', 'attachment',
    'concern', 'concerns', 'question', 'questions', 'query', 'queries'
]);

/**
 * Script-based moderation check (fast, no LLM).
 * Returns { passed: boolean, issues: string[], cleanedText: string }
 */
function scriptModerate(text) {
    const lower = text.toLowerCase();
    const issues = [];
    let cleanedText = text;

    // Check for profanity
    for (const word of PROFANITY_LIST) {
        const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
        if (regex.test(lower)) {
            issues.push(`profanity: "${word}"`);
            // Replace with asterisks but keep first and last char
            cleanedText = cleanedText.replace(regex, (match) => {
                if (match.length <= 2) return '*'.repeat(match.length);
                return match[0] + '*'.repeat(match.length - 2) + match[match.length - 1];
            });
        }
    }

    // Check for rude patterns
    for (const pattern of RUDENESS_PATTERNS) {
        if (pattern.test(text)) {
            issues.push(`rudeness pattern: ${pattern.source}`);
        }
    }

    // Check for ALL CAPS yelling (more than 60% caps in messages > 10 chars)
    if (text.length > 10) {
        const alphaChars = text.replace(/[^a-zA-Z]/g, '');
        const upperChars = alphaChars.replace(/[^A-Z]/g, '');
        if (alphaChars.length > 5 && upperChars.length / alphaChars.length > 0.6) {
            issues.push('excessive caps (yelling)');
        }
    }

    // Check for gibberish / nonsensical text
    // NOTE: use single-escaped \s so regex treats it as whitespace, NOT literal backslash+s
    const words = lower.replace(/[^a-z\s]/g, '').split(/\s+/).filter(w => w.length > 0);

    if (words.length > 0) {
        const recognizedCount = words.filter(w => COMMON_WORDS.has(w) || w.length <= 2).length;
        const recognizedRatio = recognizedCount / words.length;

        // Only flag as gibberish if very few words are recognized AND message is short
        if (recognizedRatio < 0.25 && words.length <= 10) {
            issues.push('gibberish or nonsensical text');
        }

        // Single long unrecognized "word" with no spaces — likely keyboard mash
        // But only if the entire message is one word (after cleaning)
        if (words.length === 1 && words[0].length > 8 && !COMMON_WORDS.has(words[0])) {
            issues.push('gibberish or nonsensical text');
        }
    }

    // Flag very short responses (< 3 chars) as likely unhelpful
    if (text.trim().length < 3) {
        issues.push('response too short');
    }

    return {
        passed: issues.length === 0,
        issues,
        cleanedText
    };
}

/**
 * LLM-based moderation fallback using Gemini.
 * Called when script check fails. Tries to refine the message.
 * Returns { appropriate: boolean, refinedText: string|null, reason: string }
 */
async function llmModerate(originalText, issues) {
    if (!GEMINI_API_KEY) {
        console.error('⚠️ GEMINI_API_KEY not set, skipping LLM moderation');
        return { appropriate: false, refinedText: null, reason: 'No API key configured' };
    }

    const prompt = `You are a customer support response moderator.

A support agent has written a response to a customer. The automated script flagged these issues:
${issues.join(', ')}

Original agent message:
"${originalText}"

Your tasks:
1. Determine if the core message contains useful information for the customer (e.g. a resolution, update, instruction, or helpful answer).
2. If useful: rewrite the message in THIRD PERSON from the perspective of relaying what the support agent said. The rewritten message should sound like the system is conveying the agent's response, NOT like the AI assistant is personally speaking.
   - GOOD examples: "The support team has confirmed that the issue has been resolved.", "The support agent has shared the following update: ...", "The team has noted your concern and is looking into it."
   - BAD examples: "I'm glad to hear the issue has been resolved.", "Great! I'm happy to help.", "I've confirmed that..." — do NOT use first person (I, I'm, I've, we).
   - Keep the useful content intact. Remove any rude, offensive, or unprofessional language.
3. If not useful (e.g. just insults, no actual info): mark as not appropriate.

Return ONLY valid JSON:
{
  "appropriate": true/false,
  "refined_text": "rewritten third-person relay message" or null if not appropriate,
  "reason": "brief explanation of decision"
}`;

    try {
        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
            {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: 0.2,
                    maxOutputTokens: 512
                }
            },
            { timeout: 15000 }
        );

        const raw = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();

        const result = JSON.parse(cleaned);
        return {
            appropriate: !!result.appropriate,
            refinedText: result.refined_text || null,
            reason: result.reason || ''
        };
    } catch (err) {
        console.error('❌ LLM moderation error:', err.message);
        return { appropriate: false, refinedText: null, reason: `LLM error: ${err.message}` };
    }
}

/**
 * LLM-based intent classifier for ticket follow-up messages.
 * Uses Gemini to classify user messages into intents when regex is uncertain.
 * Returns one of: 'positive', 'negative', 'casual_ack', 'substantive'
 *   - positive: user confirms issue is resolved (yes, yep, yers, yaa, etc.)
 *   - negative: user says no / not resolved, but gives NO details
 *   - casual_ack: just acknowledging (okay, okie, cool, alright, sure, etc.)
 *   - substantive: user provides actual follow-up details or a new issue description
 */
async function classifyTicketIntent(text, context = 'resolution_check') {
    const normalized = text.trim().toLowerCase();

    // ── Fast-path regex (covers clean/obvious cases) ──
    if (context === 'resolution_check') {
        if (/^(yes|yeah|yep|yup|ya|yaa+|resolved|done|fixed|it('?s)?\s*(working|fixed|resolved|good)|all\s*(good|set)|that\s*(works|worked|helped|fixed)|no\s*more\s*issues?|looks?\s*good)\s*[.!]*$/i.test(normalized)) return 'positive';
        if (/^(no+|nope|nah|na+h?|not?\s*really|negative|nuh[\s-]?uh)\s*[.!]*$/i.test(normalized)) return 'negative';
    }
    if (context === 'followup_details') {
        if (/^(no+|nope|nah|na+h?|not?\s*really|negative|nuh[\s-]?uh)\s*[.!]*$/i.test(normalized)) return 'negative';
    }
    if (context === 'waiting_for_agent') {
        const stripped = normalized.replace(/\b(baby|babe|babes|bby|bb|boo|dear|hun|honey|love|dude|bro|man|mate|fam|buddy|pal|thanks|thank\s*you|thankyou|thx|ty)\b/gi, '').trim();
        if (/^(ok(ay)?|okie+|okk+|k+|sure|alright|all\s*right|cool|got\s*it|noted|right|hmm+|oh+|ah+|i\s*see|understood|no\s*worries|no\s*problem|np|sounds?\s*good|fair\s*enough|great|fine|bet|aight|ight|roger|copy)\s*[.!,]*$/i.test(stripped)) return 'casual_ack';
        if (stripped.length === 0) return 'casual_ack'; // entire message was pet names / thanks

        // Clarification / bot-reference — user talking about what the bot said
        if (/\b(wdym|what\s*(do|did|does)\s*(you|u|that|it|this)\s*mean|what\s*(are|r)\s*(you|u)\s*(saying|talking)|what\s*does\s*that\s*mean|what\s*(is|does)\s*that\s*(supposed\s*to\s*)?mean|i\s*don'?t\s*(understand|get\s*it)|explain\s*(that|this|what)|clarify|huh\??|makes?\s*no\s*sense|doesn'?t\s*make\s*sense)\b/i.test(normalized) ||
            /^(what|huh|wdym)\s*\??$/i.test(normalized) ||
            /\b(you|u)\s*(said|wrote|told|mentioned|typed|stated|just\s*said|literally\s*(said|wrote))\b/i.test(normalized) ||
            /\b(you\s*)?definitely\s*(said|wrote|told|mentioned|typed)\b/i.test(normalized) ||
            /\b(no+\s*)?you\s*(did|didn'?t)\s*(not\s*)?(say|write|mention|tell)\b/i.test(normalized) ||
            /\b(but\s*)?you\s*(just|literally|clearly)\s*(said|wrote|told)\b/i.test(normalized) ||
            /\bwhat\s*(did\s*)?you\s*(just\s*)?(say|write|mean|tell)\b/i.test(normalized) ||
            /\bi\s*(can\s*)?read\s*(what\s*)?(you|it)\s*(said|wrote)\b/i.test(normalized)) {
            return 'clarification';
        }

        // Ticket status inquiries
        if (/\b(ticket|issue|status|update|progress|eta|when|how\s*long|any\s*(update|news|response|reply)|where\s*(is|are)|what('?s|\s+is)\s*(the|my)?\s*(status|update|progress|ticket))\b/i.test(normalized) &&
            !/\b(new|different|another|also|additionally|separate)\b/i.test(normalized)) {
            return 'status_inquiry';
        }

        // Off-topic / casual conversation (not about support issues)
        if (/^(how\s*(are|r)\s*(you|u|ya)|how('?re|\s*re)\s*(you|u|ya)|what('?re|\s*re)\s*(you|u|ya)\s*(doing|up\s*to)|what\s*(are|r)\s*(you|u|ya)\s*(doing|up\s*to)|what('?s|\s+is)\s*up|sup|wyd|hyd|how\s*do\s*you\s*do|what\s*do\s*you\s*do|who\s*(are|r)\s*(you|u)|tell\s*me\s*(about|a)\s*(yourself|joke|story)|how('?s|\s+is)\s*(it\s*going|life|your\s*day|everything)|good\s*(morning|afternoon|evening|night)|whats?\s*good)\s*[?!.]*$/i.test(normalized)) {
            return 'off_topic';
        }
    }

    // ── LLM fallback for ambiguous messages ──
    if (!GEMINI_API_KEY) {
        console.warn('⚠️ GEMINI_API_KEY not set — falling back to substantive for ambiguous message');
        return 'substantive';
    }

    const contextDescriptions = {
        resolution_check: 'The user was asked "Did the support team\'s response resolve your issue?" Classify their reply.',
        followup_details: 'The user said their issue wasn\'t resolved and was asked to describe what\'s still wrong. Classify their reply.',
        waiting_for_agent: 'The user has an open support ticket and the team is working on it. Classify whether this message is just a casual acknowledgment or an actual follow-up with details.'
    };

    const prompt = `You are a customer support chat intent classifier.

Context: ${contextDescriptions[context] || contextDescriptions.resolution_check}

User message: "${text}"

Classify this message into EXACTLY one of these intents:
- "positive": The user is confirming the issue is resolved, or expressing agreement that things are working. Includes typos of yes (e.g. "yers", "yess", "yeh", "ys"), or affirmative slang.
- "negative": The user is saying no / not resolved, but NOT providing any specific details about what's wrong. Just a bare refusal.
- "casual_ack": The user is just casually acknowledging (e.g. "okay", "okie", "cool", "alright", "sure", "kk", "bet"). They aren't reporting an issue or confirming resolution — just responding conversationally. Includes slang, pet names, elongated words like "okieeeee", "okkk", abbreviations like "bby", "bro".
- "status_inquiry": The user is asking about their ticket status, waiting time, progress, or any update on their existing ticket. Examples: "whats my ticket status", "any update", "how long will it take", "when will they reply", "is there any progress".
- "off_topic": The user is making casual conversation unrelated to their support issue — small talk, personal questions to the bot, jokes, etc. Examples: "howre you", "whatre you doing", "whats up", "tell me a joke", "who are you", "good morning".
- "clarification": The user is asking about, referring to, disagreeing with, or quoting something the bot previously said. They are talking TO the bot about the bot's own words — NOT reporting a support issue. Examples: "wdym by 2 minutes", "you said 30 minutes", "you definitely wrote that", "what did you mean", "no you told me X", "you literally just said", "i dont understand what you said", "explain that", "you wrote X".
- "substantive": The user is providing actual details about their issue, describing a NEW or DIFFERENT problem, asking a specific support-related question, or giving meaningful follow-up information that should be forwarded to the support team.

IMPORTANT:
- Only classify as "substantive" if the message contains actual issue details, a new problem description, or specific support-related information.
- If the user is talking about what the BOT said/wrote/mentioned, classify as "clarification" NOT "substantive".
- Do NOT classify casual conversation, greetings, status checks, clarification requests, or off-topic chat as substantive.

Return ONLY valid JSON: {"intent": "positive"|"negative"|"casual_ack"|"status_inquiry"|"off_topic"|"clarification"|"substantive"}`;

    try {
        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
            {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.0, maxOutputTokens: 64 }
            },
            { timeout: 8000 }
        );

        const raw = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
        const result = JSON.parse(cleaned);
        const intent = result.intent;
        console.log(`🤖 LLM intent classification: "${text}" → ${intent} (context: ${context})`);

        if (['positive', 'negative', 'casual_ack', 'status_inquiry', 'off_topic', 'clarification', 'substantive'].includes(intent)) return intent;
        return 'substantive'; // default fallback
    } catch (err) {
        console.error('❌ LLM intent classification error:', err.message);
        return 'substantive'; // safe default
    }
}

// -------------------- LOCAL INTENT PRE-CLASSIFIER (NO LLM) --------------------

/**
 * Regex-based pre-classifier for non-support messages.
 * Returns { matched: true, category, response } if intercepted, or { matched: false } to continue to n8n.
 */
function classifyLocalIntent(text) {
    if (!text || typeof text !== 'string') return { matched: false };

    const raw = text.toLowerCase().trim().replace(/[^a-z0-9\s']/g, '').replace(/\s+/g, ' ');
    // Collapse runs of 3+ identical chars → 2 (e.g. "hiiiii" → "hii")
    const msg = raw.replace(/(.)\1{2,}/g, '$1$1');

    // ── 1. GREETINGS ──
    const greetingPatterns = [
        /^h+e+l+o+$/, /^h+e+l+l+o+$/, /^h+i+$/, /^h+i+e*$/, /^h+e+y+$/,
        /^h+i+y+a*$/, /^y+o+$/, /^s+u+p+$/, /^h+o+w+d+y+$/,
        /^good\s*(morning|evening|afternoon|night|day)$/,
        /^(gm|gn|ge)$/, /^whats\s*up$/, /^wassup$/, /^wazzup$/,
        /^hola$/, /^greetings$/, /^namaste$/
    ];
    for (const p of greetingPatterns) {
        if (p.test(msg)) {
            return { matched: true, category: 'greeting', response: 'Hello! How can I help you today?' };
        }
    }

    // ── 2. THANKS ──
    if (/^(thanks|thankyou|thank\s*you|thx|ty|tysm|thanx|thank\s*u|thnx)\s*[.!]*$/.test(msg)) {
        return { matched: true, category: 'thanks', response: "You're welcome! Let me know if you need anything else." };
    }

    // ── 3. GOODBYE ──
    if (/^(bye|goodbye|good\s*bye|see\s*you|see\s*ya|later|cya|ttyl|take\s*care)\s*[.!]*$/.test(msg)) {
        return { matched: true, category: 'goodbye', response: 'Goodbye! Feel free to reach out anytime.' };
    }

    // ── 4. SIMPLE ACKNOWLEDGMENTS ──
    if (/^(ok|okay|okk+|k+|kk+|cool|nice|great|awesome|perfect|alright|aight|got\s*it|noted|sure|fine|np|no\s*problem|no\s*worries)\s*[.!]*$/.test(msg)) {
        return { matched: true, category: 'acknowledgment', response: 'Alright! Let me know if there is anything else I can help with.' };
    }

    // ── 5. PERSONAL INTRODUCTIONS ──
    if (/^(my\s*name\s*is|im|i\s*am|this\s*is)\s+[a-z]+$/.test(msg) ||
        /^(im|i\s*am)\s+from\s+[a-z]+$/.test(msg)) {
        return { matched: true, category: 'introduction', response: 'Nice to meet you! How can I help you today?' };
    }

    // ── 6. BOT CAPABILITY QUESTIONS ──
    const capabilityPatterns = [
        /^what\s*(all\s*)?(can|do) you do$/,
        /^what\s*are\s*your\s*(capabilities|features|functions|skills)$/,
        /^what\s*are\s*you(\s*capable\s*of)?$/,
        /^who\s*are\s*you$/,
        /^are\s*you\s*(a\s*)?(bot|ai|human|real|chatbot|robot)$/,
        /^what\s*is\s*(this|this\s*chat|this\s*bot)(\s*for)?$/,
        /^how\s*(can|do)\s*you\s*help(\s*me)?$/,
        /^what\s*(services?|features?|help|things?)\s*(do|can)\s*you\s*(offer|provide|give|do)$/,
        /^what\s*kind\s*of\s*(help|support|issues?|problems?)\s*(can|do)\s*you\s*(help|handle|solve|support|assist)(\s*with)?$/,
        /^how\s*does\s*this\s*(work|bot\s*work|chat\s*work)$/,
        /^what\s*do\s*you\s*support$/,
        /^tell\s*me\s*(about\s*)?(yourself|what\s*you\s*do|your\s*capabilities)$/
    ];
    for (const p of capabilityPatterns) {
        if (p.test(msg)) {
            return {
                matched: true,
                category: 'bot_capability',
                response: 'I am a support assistant for the StrideOne lending and loan management platform. I can help you with:\n\n• Loan queries and application status\n• Repayment issues and payment failures\n• Account access and login problems\n• KYC and verification issues\n• Facility and disbursement problems\n• Document upload assistance\n• Error code troubleshooting\n\nPlease describe the issue you\'re facing and I\'ll do my best to assist you!'
            };
        }
    }

    // ── 7. NO-ISSUE / JUST BROWSING / DISMISSAL ──
    const noIssuePatterns = [
        /^i\s*don'?t\s*have\s*(a\s*|any\s*)?(issue|problem|error|complaint|question)s?$/,
        /^(i\s*don'?t\s*need\s*(any\s*)?help|no\s*help\s*needed)$/,
        /^(nothing|nope|no)\s*(i\s*)?(just\s*)?(wanted\s*to\s*talk|browsing|looking\s*around|checking)$/,
        /^i'?m?\s*just\s*(browsing|looking|checking|exploring|testing)$/,
        /^(i\s*don'?t\s*want\s*to\s*raise\s*(a\s*)?ticket)$/,
        /^(no\s*issues?|no\s*problems?|everything\s*(is\s*)?(fine|good|ok|okay|working))$/,
        /^what\s*if\s*i\s*don'?t\s*(want|need)\s*(any\s*)?(service|help|support)$/,
        /^i\s*don'?t\s*(want|need)\s*(any\s*)?(service|help|support|assistance)$/,
        // Dismissals: "theres nothing you can help with", "you cant help me", etc.
        /^there('?s?|\s*is)\s*nothing\s*(you|u)\s*(can|could)\s*(help|do|assist)\s*(me\s*)?(with)?$/,
        /^(you|u)\s*(can'?t|cannot|couldn'?t|won'?t)\s*(help|assist|do\s*anything\s*for)\s*(me|us)?$/,
        /^nothing\s*(you|u)\s*(can|could)\s*(help|do|assist)\s*(me\s*)?(with)?$/,
        /^(you|u)\s*(are|r)\s*(no|not)\s*(help|useful|use)$/,
        /^(nah|no|nope)\s*(there'?s?\s*)?(nothing|nah)\s*(you|u)?\s*(can)?\s*(help|do)?\s*(with)?$/,
        /^(i'?m?\s*(good|fine|okay|ok)|no\s*thanks|no\s*thank\s*you|all\s*good)\s*[.!]*$/
    ];
    for (const p of noIssuePatterns) {
        if (p.test(msg)) {
            return {
                matched: true,
                category: 'no_issue',
                response: "No problem at all! If you ever run into any issues with the platform, feel free to come back and I'll be happy to help. Have a great day!"
            };
        }
    }

    // ── 8. OFF-TOPIC / CHITCHAT ──
    const offTopicPatterns = [
        /^(tell\s*me\s*a\s*joke|make\s*me\s*laugh)$/,
        /^what\s*is\s*the\s*meaning\s*of\s*life$/,
        /^(whats|what\s*is)\s*your\s*(name|age)$/,
        /^how\s*old\s*are\s*you$/,
        /^(can\s*we\s*be\s*friends|be\s*my\s*friend)$/,
        /^what\s*is\s*\d+\s*[\+\-\*\/x]\s*\d+$/,
        /^(do\s*you\s*have\s*feelings|are\s*you\s*alive|are\s*you\s*real)$/,
        /^(sing\s*(me\s*)?a\s*song|tell\s*me\s*a\s*story)$/,
        /^(who\s*made\s*you|who\s*created\s*you|who\s*built\s*you)$/,
        /^(whats\s*the\s*weather|hows\s*the\s*weather)$/,
        /^(i\s*love\s*you|do\s*you\s*love\s*me|i\s*like\s*you)$/,
        /^(lets\s*just\s*chat|lets\s*talk|can\s*you\s*chat)$/,
        /^(whos\s*the\s*president|what\s*year\s*is\s*it)$/,
        /^(play\s*a\s*game|lets\s*play)$/
    ];
    for (const p of offTopicPatterns) {
        if (p.test(msg)) {
            return {
                matched: true,
                category: 'off_topic',
                response: "That's a fun question, but I'm designed specifically to help with support issues on the StrideOne platform. If you have any technical issues, loan queries, or account problems, I'm here to help!"
            };
        }
    }

    // ── 9. GIBBERISH (random chars, keyboard mash) ──
    const stripped = msg.replace(/[^a-z0-9]/g, '');
    const words = msg.split(/\s+/).filter(Boolean);

    // All special chars / empty after stripping
    if (stripped.length === 0 && text.trim().length > 0) {
        return { matched: true, category: 'gibberish', response: "I couldn't understand that. Could you please rephrase your message? I'm here to help with any platform-related issues." };
    }
    // Keyboard mash (e.g. "asdfghjkl", "qwerty", repeated chars)
    if (stripped.length > 2 && /^([a-z])\1{2,}$|^[^aeiou]{5,}$|^(.{1,2})\2{2,}$/i.test(stripped)) {
        return { matched: true, category: 'gibberish', response: "I couldn't understand that. Could you please rephrase your message? I'm here to help with any platform-related issues." };
    }
    // Single unknown long word
    if (words.length === 1 && stripped.length > 6 && !COMMON_WORDS.has(stripped)) {
        return { matched: true, category: 'gibberish', response: "I couldn't understand that. Could you please rephrase your message? I'm here to help with any platform-related issues." };
    }

    // ── 10. UNCLEAR / VAGUE (very short fragments) ──
    const unclearExact = new Set([
        'help', 'issue', 'problem', 'check this', 'its not', 'i cant',
        'where is', 'what about', 'i need', 'how do i', 'is there',
        'my thing', 'the thing', 'i want to', 'please do'
    ]);
    if (unclearExact.has(msg)) {
        return {
            matched: true,
            category: 'unclear',
            response: "Could you please provide a bit more detail about what you need help with? For example, you can describe the error you're seeing, the page you're on, or the action you were trying to perform."
        };
    }

    // Not intercepted — let n8n handle
    return { matched: false };
}

// -------------------- ESCALATION GATE (min 2 bot attempts) --------------------

const MIN_BOT_ATTEMPTS_BEFORE_ESCALATION = 2;

/**
 * Check if the user message is a support/escalation request.
 */
function isEscalationRequest(text) {
    if (!text) return false;
    const msg = text.toLowerCase().trim().replace(/[^a-z0-9\s']/g, '').replace(/\s+/g, ' ');
    const patterns = [
        /\bcontact\s*support\b/,
        /\bconnect\s*(me\s*)?to\s*support\b/,
        /\bhuman\s*(support|agent)\b/,
        /\btalk\s*to\s*(support|agent|human|someone|a\s*person)\b/,
        /\brepresentative\b/,
        /\breal\s*person\b/,
        /\bcustomer\s*care\b/,
        /\bescalate\b/,
        /\braise\s*(a\s*)?ticket\b/,
        /\bcreate\s*(a\s*)?ticket\b/,
        /\bi\s*(want|need)\s*(a\s*)?ticket\b/,
        /\bfollow\s*up\s*(on\s*)?(my\s*)?(ticket|issue)\b/,
        /\braise\s*this\s*again\b/,
        /\bask\s*the\s*support\s*team\b/,
        /\bcheck\s*with\s*(the\s*)?support\b/,
        /\bi\s*(want|need)\s*to\s*contact\s*support\b/,
        /\bi\s*(want|need)\s*support\b/,
        /\bplease\s*(connect|contact|reach|escalate|follow)\b/
    ];
    return patterns.some(p => p.test(msg));
}

/**
 * Count how many substantive bot resolution attempts have been made for a conversation.
 * Counts assistant messages that are actual issue resolutions (not greetings, acks, escalation prompts, etc.)
 */
function countBotAttempts(conversationId) {
    const msgs = conversationMessagesStore[conversationId] || [];
    const nonResolutionCategories = new Set([
        'greeting', 'greeting_or_ack', 'thanks', 'goodbye', 'acknowledgment',
        'introduction', 'bot_capability', 'no_issue', 'off_topic', 'gibberish',
        'unclear', 'support_request_pending_details', 'escalation_gate',
        'followup_support', 'casual_ack', 'resolution_check',
        'followup_details_request', 'ticket_resolved', 'clarification',
        'status_inquiry'
    ]);
    let count = 0;
    for (const msg of msgs) {
        if (msg.role === 'assistant' && msg.message_text) {
            const cat = (msg.matched_issue || msg.category || '').toLowerCase();
            if (!nonResolutionCategories.has(cat) && msg.message_text.length > 30) {
                count++;
            }
        }
    }
    return count;
}

/**
 * Check if escalation should be gated. Returns:
 * - { gated: false } if user can escalate
 * - { gated: true, response: string, attemptsNeeded: number } if user should try bot first
 */
function checkEscalationGate(conversationId) {
    if (!conversationId) return { gated: false };

    const botAttempts = countBotAttempts(conversationId);
    const remaining = MIN_BOT_ATTEMPTS_BEFORE_ESCALATION - botAttempts;

    if (remaining <= 0) {
        return { gated: false };
    }

    // Craft response based on how many more attempts are needed
    let response;
    if (botAttempts === 0) {
        response = "I'd like to try helping you first before creating a support ticket. Could you please describe the issue you're facing? I might be able to resolve it right away.";
    } else {
        response = "I understand you'd like to reach support, but let me try one more thing first. Could you describe what's still not working? If I'm unable to help, I'll connect you with the support team right away.";
    }

    return {
        gated: true,
        response,
        botAttempts,
        attemptsNeeded: remaining
    };
}

/**
 * Generate a context-aware clarification response for the active ticket conversation.
 * Uses LLM with recent conversation history, with a regex-based fallback.
 */
async function generateClarificationResponse(conversationId, userText, activeTicket) {
    const recentMsgs = (conversationMessagesStore[conversationId] || []).slice(-8);
    const contextLines = recentMsgs.map(m =>
        `${m.role === 'user' ? 'User' : 'Bot'}: ${m.message_text}`
    ).join('\n');

    if (GEMINI_API_KEY) {
        try {
            const clarifyPrompt = `You are a helpful customer support chatbot. The user is responding to or asking about something you (the bot) previously said in the conversation. They may be asking for clarification, disagreeing with what you said, quoting you, or pointing out something you wrote.

Recent conversation:
${contextLines}

User's latest message: "${userText}"

The user has an open support ticket (${activeTicket.id}). They are waiting for the support team to respond.

Respond naturally and helpfully:
- Look at YOUR (the bot's) previous messages and figure out what the user is referring to.
- If the user says "you said X" or "you wrote X," acknowledge it and explain what you meant.
- If the user is confused about a time reference (like "X minutes in" or "X hours"), explain it refers to how long the ticket has been open.
- If the user is disagreeing or insisting you said something, review your actual messages and either confirm or correct yourself honestly.
- Keep it concise, friendly, and clear (1-2 sentences max).
- Do NOT ask the user to describe their issue again.
- Do NOT say "Your follow-up has been shared with support" — they are talking to YOU about YOUR words.
- Do NOT be defensive. Just clarify simply.`;

            const resp = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
                {
                    contents: [{ parts: [{ text: clarifyPrompt }] }],
                    generationConfig: { temperature: 0.3, maxOutputTokens: 150 }
                },
                { timeout: 8000 }
            );
            const text = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
            if (text) return text;
        } catch (err) {
            console.error('❌ Clarification LLM error:', err.message);
        }
    }

    // Fallback
    const lastBotMsg = recentMsgs.filter(m => m.role === 'assistant').pop();
    if (lastBotMsg && /\d+\s*(minute|hour|min)/i.test(lastBotMsg.message_text)) {
        return `When I mentioned the time, I was referring to how long your support ticket (${activeTicket.id}) has been open. The support team is still working on it — nothing to worry about!`;
    }
    return `I was providing an update on your support ticket (${activeTicket.id}). The support team is still working on your issue and I'll notify you as soon as they respond.`;
}

/**
 * Emit a locally-generated response to the chat (bypassing n8n).
 * Stores in memory, emits via socket, saves to DB.
 */
function emitLocalResponse({ io, messageData, responseText, category, conversationId }) {
    const responseMessage = {
        type: 'response',
        sender: 'AI Assistant',
        timestamp: new Date().toISOString(),
        text: responseText,
        messageId: `resp_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
        originalMessageId: messageData.messageId,
        category,
        conversationId
    };

    messages.push(responseMessage);

    if (!conversationMessagesStore[conversationId]) {
        conversationMessagesStore[conversationId] = [];
    }
    conversationMessagesStore[conversationId].push({
        role: 'assistant',
        message_text: responseText,
        assistant_message: responseText,
        matched_issue: category,
        messageId: responseMessage.messageId,
        created_at: responseMessage.timestamp
    });

    updateChatSummary(conversationId, {
        user_message: messageData.text,
        assistant_message: responseText,
        matched_issue: category
    });
    updateConversation(conversationId, { preview: responseText });

    io.to(conversationId).emit('responseMessage', responseMessage);

    // Persist to DB
    db.saveChatMessage({
        conversationId,
        messageId: responseMessage.messageId,
        role: 'assistant',
        messageText: responseText,
        intent: category,
        matchedIssue: category,
        issueSummary: null,
        attachmentSummary: null,
        ticketId: null,
        fileUrl: null,
        fileType: null,
        fileName: null,
        createdAt: responseMessage.timestamp
    });

    // Also save the user turn to chat-memory
    if (!chatMemoryStore[conversationId]) {
        chatMemoryStore[conversationId] = [];
    }
    chatMemoryStore[conversationId].push({
        role: 'user',
        message_text: messageData.text,
        user_message: messageData.text,
        user_query: messageData.text,
        intent: category,
        matched_issue: category,
        created_at: messageData.timestamp
    });
    chatMemoryStore[conversationId].push({
        role: 'assistant',
        message_text: responseText,
        assistant_message: responseText,
        intent: category,
        matched_issue: category,
        created_at: responseMessage.timestamp
    });

    console.log(`🏠 Local response [${category}]: "${messageData.text}" → "${responseText.substring(0, 60)}..."`);

    return responseMessage;
}

/**
 * Close a ticket by ID — marks status as 'resolved'.
 */
function closeTicket(ticketId) {
    if (!ticketId) return false;
    const ticket = ticketsStore[ticketId];
    if (!ticket) return false;
    ticket.status = 'resolved';
    ticket.resolved_at = new Date().toISOString();
    ticket.updated_at = new Date().toISOString();
    console.log(`🔒 Ticket closed: ${ticketId}`);
    db.saveTicket(ticket); // persist to MySQL
    return true;
}

/**
 * Find the most recent open/escalated ticket for a conversation.
 */
function findTicketByConversation(conversationId) {
    if (!conversationId) return null;
    const tickets = Object.values(ticketsStore)
        .filter(t => t.conversationId === conversationId && t.status !== 'resolved')
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return tickets.length > 0 ? tickets[0] : null;
}

/**
 * Find ANY active (non-resolved, non-closed) ticket for a conversation.
 * Used for back-and-forth detection.
 */
function findActiveTicketForConversation(conversationId) {
    if (!conversationId) return null;
    const tickets = Object.values(ticketsStore)
        .filter(t =>
            t.conversationId === conversationId &&
            t.status !== 'resolved' &&
            t.status !== 'closed'
        )
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return tickets.length > 0 ? tickets[0] : null;
}

/**
 * Check if user message is an acknowledgment/resolution confirmation.
 */
function isUserAcknowledgment(text) {
    if (!text) return false;
    const normalized = text.trim().toLowerCase();
    const ackPatterns = [
        /^(thanks|thank\s*you|thx|ty|great|ok(ay)?|cool|got\s*it|alright|sure|noted|perfect|resolved|done|working\s*now|fixed|all\s*good|all\s*set)\s*[.!]*$/i,
        /^(that\s*(works|worked|helped|fixed\s*it))[.!]*$/i,
        /^(issue\s*(is\s*)?resolved|problem\s*(is\s*)?fixed|it'?s?\s*working\s*now)[.!]*$/i,
        /^(no\s*(more\s*)?issues?|looks?\s*good|seems?\s*(fine|good|ok))[.!]*$/i
    ];
    return ackPatterns.some(p => p.test(normalized));
}

/**
 * Send a follow-up notification to Teams for an active ticket.
 */
async function sendFollowupToTeams(ticket, messageData) {
    try {
        const chatSummary = getChatSummary(messageData.conversationId);
        const teamsPayload = {
            "@type": "MessageCard",
            "@context": "http://schema.org/extensions",
            "summary": `Follow-up on ticket: ${ticket.id}`,
            "themeColor": "0078D7",
            "title": "💬 User Follow-Up Reply",
            "text": `CHAT_CONVERSATION_ID: ${messageData.conversationId || 'N/A'}`,
            "sections": [
                {
                    "facts": [
                        { "name": "Ticket ID", "value": ticket.id || '' },
                        { "name": "User Message", "value": messageData.text || '' },
                        { "name": "Previous Description", "value": ticket.description || 'N/A' },
                        { "name": "Assigned To", "value": ticket.assigned_to_name || ticket.assigned_to || 'Support Team' },
                        { "name": "Status", "value": 'User Follow-Up' },
                        { "name": "Chat Summary", "value": chatSummary.summary || 'No summary available' }
                    ]
                }
            ]
        };

        await axios.post(TEAMS_WEBHOOK_URL, teamsPayload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000
        });
        console.log(`📤 Follow-up Teams notification sent for ticket ${ticket.id}`);
    } catch (err) {
        console.error(`❌ Failed to send follow-up Teams notification for ticket ${ticket.id}:`, err.message);
    }
}

/**
 * Save follow-up ticket data — merges description, updates status, records follow-up history.
 * This mirrors the logic from the /api/tickets/followup endpoint.
 */
function saveFollowupTicket(ticket, latestUserMessage, conversationId) {
    if (!ticket) return;

    const oldDescription = ticket.description || '';
    const newDescription = [
        oldDescription ? `Previous Ticket Description: ${oldDescription}` : '',
        latestUserMessage ? `Latest User Follow-Up: ${latestUserMessage}` : ''
    ].filter(Boolean).join('\n\n');

    ticket.previous_ticket_description = oldDescription;
    ticket.latest_user_message = latestUserMessage || '';
    ticket.description = newDescription;
    ticket.category = 'followup_support';
    ticket.conversationId = conversationId || ticket.conversationId || null;

    // Reopen ticket if resolved
    if (ticket.status === 'resolved') {
        console.log(`🔓 Reopening resolved ticket ${ticket.id} for follow-up`);
        ticket.resolved_at = null;
    }

    // Set follow-up status (preserve escalated)
    if (ticket.status !== 'escalated') {
        ticket.status = 'existing_ticket_followup';
    }

    ticket.updated_at = new Date().toISOString();
    ticket.last_response_at = new Date().toISOString();

    if (!ticket.followups) ticket.followups = [];
    ticket.followups.push({
        message: latestUserMessage || '',
        created_at: new Date().toISOString()
    });
    if (ticket.followups.length > 20) {
        ticket.followups = ticket.followups.slice(-20);
    }

    db.saveTicket(ticket);
    console.log(`📋 Follow-up ticket saved: ${ticket.id} (status: ${ticket.status})`);
}

/**
 * Close the ticket for a conversation (finds it by conversationId if no ticketId given).
 */
function closeTicketForConversation(conversationId, ticketId) {
    // Try explicit ticket_id first
    if (ticketId && closeTicket(ticketId)) return ticketId;
    // Fallback: find by conversationId
    const ticket = findTicketByConversation(conversationId);
    if (ticket) {
        closeTicket(ticket.id);
        return ticket.id;
    }
    return null;
}

/**
 * Mark ticket as awaiting user reply (agent responded, waiting for user).
 */
function markTicketAwaitingUserReply(conversationId, ticketId) {
    let ticket = ticketId ? ticketsStore[ticketId] : null;
    if (!ticket) ticket = findTicketByConversation(conversationId);
    if (!ticket) return null;
    ticket.status = 'awaiting_user_reply';
    ticket.last_response_at = new Date().toISOString();
    ticket.updated_at = new Date().toISOString();
    console.log(`⏳ Ticket ${ticket.id} marked as awaiting_user_reply`);
    db.saveTicket(ticket);
    return ticket.id;
}

// -------------------- HELPERS --------------------

function createConversation(userId, title = '', preview = '') {
    const conversation_id = `conv_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    const now = new Date().toISOString();

    if (!conversationsStore[userId]) conversationsStore[userId] = [];

    const chatNumber = conversationsStore[userId].length + 1;

    const convo = {
        conversation_id,
        user_id: userId,
        title: title && title.trim() ? title : `New Chat ${chatNumber}`,
        last_message_preview: preview,
        created_at: now,
        updated_at: now
    };

    conversationsStore[userId].unshift(convo);
    conversationMessagesStore[conversation_id] = [];

    return convo;
}

function updateConversation(conversation_id, { title, preview }) {
    for (const userId in conversationsStore) {
        const convo = conversationsStore[userId].find(c => c.conversation_id === conversation_id);
        if (convo) {
            if (title) convo.title = title;
            if (preview) convo.last_message_preview = preview;
            convo.updated_at = new Date().toISOString();
            return convo;
        }
    }
    return null;
}

function findConversation(conversation_id) {
    for (const userId in conversationsStore) {
        const convo = conversationsStore[userId].find(c => c.conversation_id === conversation_id);
        if (convo) return convo;
    }
    return null;
}

function generateConversationTitle(text = '') {
    const cleaned = String(text || '').trim().replace(/\s+/g, ' ');
    if (!cleaned) return 'New Chat';
    const words = cleaned.split(' ').slice(0, 6).join(' ');
    return words.length > 40 ? words.slice(0, 40) : words;
}

function buildLocalFileUrl(filename) {
    return `http://localhost:${PORT}/${filename}`;
}

function extractFilenameFromUrl(fileUrl = '') {
    try {
        const pathname = new URL(fileUrl).pathname;
        return decodeURIComponent(path.basename(pathname));
    } catch {
        return path.basename(fileUrl || '');
    }
}

function resolveLocalUploadPath(fileUrl = '', fileName = '') {
    const filenameFromUrl = extractFilenameFromUrl(fileUrl);
    const candidates = [filenameFromUrl, fileName].filter(Boolean);

    for (const candidate of candidates) {
        const filePath = path.join(uploadsDir, candidate);
        if (fs.existsSync(filePath)) return filePath;
    }

    return null;
}

function summarizeText(text = '', maxLength = 500) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return '';
    return clean.length <= maxLength ? clean : `${clean.slice(0, maxLength)}...`;
}

async function extractAttachmentContent({ file_url, file_type, file_name }) {
    const filePath = resolveLocalUploadPath(file_url, file_name);

    if (!filePath) {
        return {
            success: false,
            attachment_text: '',
            attachment_summary: '',
            extraction_method: 'not_found',
            error: 'Attachment file not found on server'
        };
    }

    const resolvedType = file_type || '';
    const lowerName = String(file_name || filePath).toLowerCase();

    try {
        if (resolvedType === 'application/pdf' || lowerName.endsWith('.pdf')) {
            const buffer = fs.readFileSync(filePath);
            const parsed = await pdfParse(buffer);
            const attachmentText = (parsed.text || '').trim();

            return {
                success: true,
                attachment_text: attachmentText,
                attachment_summary: summarizeText(attachmentText, 1200),
                extraction_method: 'pdf-parse'
            };
        }

        if (
            resolvedType.startsWith('image/') ||
            ['.png', '.jpg', '.jpeg', '.gif', '.webp'].some(ext => lowerName.endsWith(ext))
        ) {
            const ocrResult = await Tesseract.recognize(filePath, 'eng');
            const attachmentText = (ocrResult?.data?.text || '').trim();

            return {
                success: true,
                attachment_text: attachmentText,
                attachment_summary: summarizeText(attachmentText, 1200),
                extraction_method: 'tesseract'
            };
        }

        return {
            success: false,
            attachment_text: '',
            attachment_summary: '',
            extraction_method: 'unsupported',
            error: 'Unsupported attachment type'
        };
    } catch (error) {
        return {
            success: false,
            attachment_text: '',
            attachment_summary: '',
            extraction_method: 'error',
            error: error.message
        };
    }
}

const TEAMS_WEBHOOK_URL = process.env.TEAMS_WEBHOOK_URL || 'https://defaulted1e38cdc228417082d81b69381f2c.0c.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/2550ce5f918e49fb9445d811f387ea9d/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=9q-QwqYZapL82iXTEjskwERNfpMuTH7PCzoSJVKe_Vo';

function applyEscalation(ticket, escalatedAt = null) {
    if (!ticket || ticket.status === 'resolved') return ticket;

    const currentLevel = ticket.escalation_level || 0;
    if (currentLevel >= 3) return ticket; // max: dev(1) → manager(2) → senior_manager(3)

    const nextLevel = currentLevel + 1;
    ticket.escalation_level = nextLevel;
    ticket.status = 'escalated';
    ticket.escalated_at = escalatedAt || new Date().toISOString();
    ticket.updated_at = new Date().toISOString();

    if (nextLevel === 1) {
        ticket.assigned_to = 'dev';
        ticket.assigned_to_name = 'Developer';
    } else if (nextLevel === 2) {
        ticket.assigned_to = 'manager';
        ticket.assigned_to_name = 'Manager';
    } else if (nextLevel === 3) {
        ticket.assigned_to = 'senior_manager';
        ticket.assigned_to_name = 'Senior Manager';
    }

    db.saveTicket(ticket); // persist to MySQL
    return ticket;
}

async function escalateOldTickets(minutes = 5) {
    const now = Date.now();

    console.log('Running escalation check...');

    for (const ticket of Object.values(ticketsStore)) {
        if (ticket.status === 'resolved' || ticket.status === 'closed' || ticket.status === 'awaiting_user_reply' || ticket.status === 'awaiting_resolution_confirmation') continue;
        if ((ticket.escalation_level || 0) >= 3) continue; // max 3 stages: dev → manager → senior_manager

        const lastTime = new Date(ticket.escalated_at || ticket.created_at).getTime();

        console.log('Checking ticket:', ticket.id, {
            status: ticket.status,
            escalation_level: ticket.escalation_level,
            assigned_to: ticket.assigned_to,
            escalated_at: ticket.escalated_at,
            updated_at: ticket.updated_at,
            created_at: ticket.created_at
        });

        if (now - lastTime >= minutes * 60 * 1000) {
            const prevLevel = ticket.escalation_level || 0;
            applyEscalation(ticket);
            console.log(
                `🚨 Escalated: ${ticket.id}, level: ${prevLevel} → ${ticket.escalation_level}, assigned_to: ${ticket.assigned_to}`
            );

            // Post escalation notification to Teams
            try {
                const assignedLabel = ticket.assigned_to_name || ticket.assigned_to || 'Unknown';
                const chatSummary = getChatSummary(ticket.conversationId);
                const teamsPayload = {
                    "@type": "MessageCard",
                    "@context": "http://schema.org/extensions",
                    "summary": `Ticket escalated: ${ticket.id}`,
                    "themeColor": ticket.escalation_level >= 3 ? "FF0000" : ticket.escalation_level >= 2 ? "E81123" : "FFA500",
                    "title": `⚠️ Ticket Escalation — Level ${ticket.escalation_level}`,
                    "text": `CHAT_CONVERSATION_ID: ${ticket.conversationId || 'N/A'}`,
                    "sections": [
                        {
                            "facts": [
                                { "name": "Ticket ID", "value": ticket.id || '' },
                                { "name": "Title", "value": ticket.title || 'Support Ticket' },
                                { "name": "Description", "value": ticket.description || ticket.ticket_description || 'No description' },
                                { "name": "Priority", "value": ticket.priority || 'Medium' },
                                { "name": "Category", "value": ticket.category || 'manual_ticket' },
                                { "name": "Assigned To", "value": assignedLabel },
                                { "name": "Status", "value": ticket.status || 'escalated' },
                                { "name": "Escalation Level", "value": `${prevLevel} → ${ticket.escalation_level}` },
                                { "name": "Escalation Path", "value": 'Developer → Manager → Senior Manager' },
                                { "name": "Time Without Response", "value": `${Math.round((now - new Date(ticket.created_at).getTime()) / 60000)} minutes` },
                                { "name": "Created At", "value": ticket.created_at || '' },
                                { "name": "Chat Summary", "value": chatSummary.summary || 'No summary available' }
                            ]
                        }
                    ]
                };

                await axios.post(TEAMS_WEBHOOK_URL, teamsPayload, {
                    headers: { 'Content-Type': 'application/json' },
                    timeout: 10000
                });
                console.log(`📤 Teams escalation notification sent for ticket ${ticket.id} (level ${ticket.escalation_level})`);
            } catch (err) {
                console.error(`❌ Failed to send Teams escalation for ticket ${ticket.id}:`, err.message);
            }
        }
    }
}

// -------------------- MULTER --------------------

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
        const uniqueName = `${Date.now()}_${Math.random().toString(36).slice(2, 11)}_${file.originalname}`;
        cb(null, uniqueName);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedMimes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];
        if (allowedMimes.includes(file.mimetype)) return cb(null, true);
        cb(new Error('Only images and PDFs are allowed'));
    }
});

// -------------------- MIDDLEWARE --------------------

app.use(express.static('public'));
app.use(express.static('uploads'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
    next();
});

// -------------------- BASIC ROUTES --------------------

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/messages', (req, res) => {
    res.json(messages);
});

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        activeUsers,
        messageCount: messages.length,
        n8nConnected,
        n8nWebhookUrl: N8N_WEBHOOK_URL,
        queuedMessages: messageQueue.length,
        memoryConversations: Object.keys(chatMemoryStore).length,
        totalConversationOwners: Object.keys(conversationsStore).length,
        totalConversations: Object.values(conversationsStore).reduce((acc, arr) => acc + arr.length, 0),
        totalTickets: Object.keys(ticketsStore).length,
        totalTeamsThreadMappings: Object.keys(teamsThreadMap).length
    });
});

// -------------------- FILE UPLOAD --------------------

app.post('/api/upload', upload.single('file'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const fileUrl = buildLocalFileUrl(req.file.filename);
        const fileType = req.file.mimetype;

        res.json({
            success: true,
            file_url: fileUrl,
            file_name: req.file.originalname,
            file_type: fileType,
            file_size: req.file.size
        });
    } catch (error) {
        console.error('❌ File upload error:', error.message);
        res.status(500).json({ error: 'File upload failed' });
    }
});

// -------------------- ATTACHMENT EXTRACTION ROUTE --------------------

app.post('/api/extract-attachment-text', async (req, res) => {
    try {
        const { file_url, file_type, file_name } = req.body || {};

        if (!file_url && !file_name) {
            return res.status(400).json({
                success: false,
                error: 'file_url or file_name is required',
                attachment_text: '',
                attachment_summary: '',
                extraction_method: 'none'
            });
        }

        const result = await extractAttachmentContent({ file_url, file_type, file_name });

        return res.json({
            success: result.success,
            file_url: file_url || null,
            file_type: file_type || null,
            file_name: file_name || null,
            attachment_text: result.attachment_text || '',
            attachment_summary: result.attachment_summary || '',
            extraction_method: result.extraction_method || 'none',
            error: result.error || null
        });
    } catch (error) {
        console.error('❌ Error in /api/extract-attachment-text:', error.message);
        return res.status(500).json({
            success: false,
            error: error.message,
            attachment_text: '',
            attachment_summary: '',
            extraction_method: 'error'
        });
    }
});

// -------------------- DIRECT MESSAGE API --------------------

app.post('/api/messages', async (req, res) => {
    try {
        const {
            sender,
            text,
            file_url,
            file_type,
            file_name,
            conversationId,
            userId
        } = req.body;

        let finalConversationId = conversationId;
        let conversation = finalConversationId ? findConversation(finalConversationId) : null;

        if (!conversation) {
            const safeUserId = userId || sender || 'guest_user';
            conversation = createConversation(safeUserId, generateConversationTitle(text), text || file_name || '');
            finalConversationId = conversation.conversation_id;
        }

        const messageData = {
            type: 'message',
            sender: sender || 'Anonymous',
            conversationId: finalConversationId,
            timestamp: new Date().toISOString(),
            text: text || '',
            file_url: file_url || null,
            file_type: file_type || null,
            file_name: file_name || null,
            messageId: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
        };

        messages.push(messageData);

        if (!conversationMessagesStore[finalConversationId]) {
            conversationMessagesStore[finalConversationId] = [];
        }

        conversationMessagesStore[finalConversationId].push({
            role: 'user',
            message_text: messageData.text,
            user_message: messageData.text,
            user_query: messageData.text,
            file_url: messageData.file_url,
            file_type: messageData.file_type,
            file_name: messageData.file_name,
            messageId: messageData.messageId,
            created_at: messageData.timestamp
        });

        updateConversation(finalConversationId, {
            title: conversation.title === 'New Chat' ? generateConversationTitle(text) : undefined,
            preview: text || file_name || 'Attachment'
        });

        io.emit('newMessage', messageData);

        // ========== LOCAL PRE-CLASSIFIER (no LLM) ==========
        let locallyHandled = false;
        if (messageData.text && !messageData.file_url) {
            // --- Escalation gate: intercept support requests before min attempts ---
            if (isEscalationRequest(messageData.text)) {
                const gate = checkEscalationGate(finalConversationId);
                if (gate.gated) {
                    emitLocalResponse({
                        io,
                        messageData,
                        responseText: gate.response,
                        category: 'escalation_gate',
                        conversationId: finalConversationId
                    });
                    locallyHandled = true;
                    console.log(`🚧 Escalation gated for ${finalConversationId}: ${gate.botAttempts}/${MIN_BOT_ATTEMPTS_BEFORE_ESCALATION} attempts`);
                }
            }

            if (!locallyHandled) {
                const localIntent = classifyLocalIntent(messageData.text);
                if (localIntent.matched) {
                    emitLocalResponse({
                        io,
                        messageData,
                        responseText: localIntent.response,
                        category: localIntent.category,
                        conversationId: finalConversationId
                    });
                    locallyHandled = true;
                }
            }
        }
        // ========== END LOCAL PRE-CLASSIFIER ==========

        if (!locallyHandled) {
            await sendToN8n(messageData);
        }

        res.json({
            success: true,
            message: 'Message sent',
            data: messageData
        });
    } catch (error) {
        console.error('❌ Error in /api/messages:', error.message);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

// -------------------- SOCKET.IO --------------------

io.on('connection', (socket) => {
    activeUsers++;
    io.emit('activeUsers', activeUsers);

    socket.on('sendMessage', async (data) => {
        try {
            const messageData = {
                type: 'message',
                sender: data.sender || 'Anonymous',
                conversationId: data.conversationId || data.sender || socket.id,
                timestamp: new Date().toISOString(),
                text: data.text || '',
                file_url: data.file_url || null,
                file_type: data.file_type || null,
                file_name: data.file_name || null,
                messageId: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
            };

            messages.push(messageData);

            if (!conversationMessagesStore[messageData.conversationId]) {
                conversationMessagesStore[messageData.conversationId] = [];
            }

            conversationMessagesStore[messageData.conversationId].push({
                role: 'user',
                message_text: messageData.text,
                user_message: messageData.text,
                user_query: messageData.text,
                file_url: messageData.file_url,
                file_type: messageData.file_type,
                file_name: messageData.file_name,
                messageId: messageData.messageId,
                created_at: messageData.timestamp
            });

            const existingConvo = findConversation(messageData.conversationId);
            if (existingConvo) {
                updateConversation(messageData.conversationId, {
                    preview: messageData.text || messageData.file_name || 'Attachment'
                });
            }

            io.to(messageData.conversationId).emit('newMessage', messageData);

            // ========== BACK-AND-FORTH: Check for active ticket ==========
            const activeTicket = findActiveTicketForConversation(messageData.conversationId);
            if (activeTicket && messageData.text) {
                console.log(`🔄 Active ticket detected: ${activeTicket.id} (status: ${activeTicket.status})`);

                // Update chat summary with user message
                updateChatSummary(messageData.conversationId, { user_message: messageData.text });

                // ---- STATE: awaiting_resolution_confirmation ----
                // The user was asked "Did this resolve your issue?" — check their answer
                if (activeTicket.status === 'awaiting_resolution_confirmation') {
                    const resolutionIntent = await classifyTicketIntent(messageData.text, 'resolution_check');
                    console.log(`🔍 Resolution intent for "${messageData.text}": ${resolutionIntent}`);

                    if (resolutionIntent === 'positive') {
                        closeTicket(activeTicket.id);

                        const ackText = "Glad I could help! Your ticket has been resolved. Feel free to reach out if you need anything else.";
                        const ackMessage = {
                            type: 'response',
                            sender: 'AI Assistant',
                            timestamp: new Date().toISOString(),
                            text: ackText,
                            messageId: `resp_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
                            originalMessageId: messageData.messageId,
                            category: 'ticket_resolved',
                            conversationId: messageData.conversationId,
                            ticket_id: activeTicket.id
                        };

                        messages.push(ackMessage);
                        conversationMessagesStore[messageData.conversationId].push({
                            role: 'assistant',
                            message_text: ackText,
                            assistant_message: ackText,
                            matched_issue: 'ticket_resolved',
                            ticket_id: activeTicket.id,
                            messageId: ackMessage.messageId,
                            created_at: ackMessage.timestamp
                        });

                        updateChatSummary(messageData.conversationId, { assistant_message: ackText, matched_issue: 'ticket_resolved', ticket_id: activeTicket.id });
                        updateConversation(messageData.conversationId, { preview: ackText });
                        io.to(messageData.conversationId).emit('responseMessage', ackMessage);
                        db.saveChatMessage({ conversationId: messageData.conversationId, messageId: ackMessage.messageId, role: 'assistant', messageText: ackText, intent: null, matchedIssue: 'ticket_resolved', issueSummary: null, attachmentSummary: null, ticketId: activeTicket.id, fileUrl: null, fileType: null, fileName: null, createdAt: ackMessage.timestamp });

                        console.log(`✅ Ticket ${activeTicket.id} confirmed resolved by user`);
                        return;
                    }

                    if (resolutionIntent === 'negative') {
                        // Ask user to elaborate before forwarding to support
                        activeTicket.status = 'awaiting_followup_details';
                        activeTicket.updated_at = new Date().toISOString();
                        db.saveTicket(activeTicket);

                        const detailsText = "Could you please describe what's still not working or what issue you're facing? This will help the support team assist you better.";
                        const detailsMsg = {
                            type: 'response',
                            sender: 'AI Assistant',
                            timestamp: new Date().toISOString(),
                            text: detailsText,
                            messageId: `resp_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
                            originalMessageId: messageData.messageId,
                            category: 'followup_details_request',
                            conversationId: messageData.conversationId,
                            ticket_id: activeTicket.id
                        };

                        messages.push(detailsMsg);
                        conversationMessagesStore[messageData.conversationId].push({ role: 'assistant', message_text: detailsText, assistant_message: detailsText, matched_issue: 'followup_details_request', ticket_id: activeTicket.id, messageId: detailsMsg.messageId, created_at: detailsMsg.timestamp });
                        updateChatSummary(messageData.conversationId, { assistant_message: detailsText, matched_issue: 'followup_details_request', ticket_id: activeTicket.id });
                        updateConversation(messageData.conversationId, { preview: detailsText });
                        io.to(messageData.conversationId).emit('responseMessage', detailsMsg);
                        db.saveChatMessage({ conversationId: messageData.conversationId, messageId: detailsMsg.messageId, role: 'assistant', messageText: detailsText, intent: null, matchedIssue: 'followup_details_request', issueSummary: null, attachmentSummary: null, ticketId: activeTicket.id, fileUrl: null, fileType: null, fileName: null, createdAt: detailsMsg.timestamp });

                        console.log(`❓ User said "${messageData.text}" without details — asking for elaboration on ticket ${activeTicket.id}`);
                        return;
                    }

                    // resolutionIntent === 'substantive' or 'casual_ack' with actual content → forward to Teams as follow-up
                    saveFollowupTicket(activeTicket, messageData.text, messageData.conversationId);
                    activeTicket.status = 'awaiting_agent_reply';
                    db.saveTicket(activeTicket);

                    await sendFollowupToTeams(activeTicket, messageData);
                    console.log(`📤 User not resolved — follow-up on ticket ${activeTicket.id} forwarded to Teams`);

                    const followUpText = "I've shared your follow-up with the support team. They'll get back to you shortly.";
                    const followUpMsg = {
                        type: 'response',
                        sender: 'AI Assistant',
                        timestamp: new Date().toISOString(),
                        text: followUpText,
                        messageId: `resp_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
                        originalMessageId: messageData.messageId,
                        category: 'followup_support',
                        conversationId: messageData.conversationId,
                        ticket_id: activeTicket.id
                    };

                    messages.push(followUpMsg);
                    conversationMessagesStore[messageData.conversationId].push({ role: 'assistant', message_text: followUpText, assistant_message: followUpText, matched_issue: 'followup_support', ticket_id: activeTicket.id, messageId: followUpMsg.messageId, created_at: followUpMsg.timestamp });
                    updateChatSummary(messageData.conversationId, { assistant_message: followUpText, matched_issue: 'followup_support', ticket_id: activeTicket.id });
                    updateConversation(messageData.conversationId, { preview: followUpText });
                    io.to(messageData.conversationId).emit('responseMessage', followUpMsg);
                    db.saveChatMessage({ conversationId: messageData.conversationId, messageId: followUpMsg.messageId, role: 'assistant', messageText: followUpText, intent: null, matchedIssue: 'followup_support', issueSummary: null, attachmentSummary: null, ticketId: activeTicket.id, fileUrl: null, fileType: null, fileName: null, createdAt: followUpMsg.timestamp });

                    return;
                }

                // ---- STATE: awaiting_followup_details ----
                // User said "no" without explanation; we asked them to elaborate.
                if (activeTicket.status === 'awaiting_followup_details') {
                    const detailIntent = await classifyTicketIntent(messageData.text, 'followup_details');
                    console.log(`🔍 Detail intent for "${messageData.text}": ${detailIntent}`);

                    if (detailIntent === 'negative') {
                        // User refuses to elaborate — escalate to Teams noting no details were given
                        const noDetailMessage = '(User indicated issue is not resolved but did not provide details)';
                        saveFollowupTicket(activeTicket, noDetailMessage, messageData.conversationId);
                        activeTicket.status = 'awaiting_agent_reply';
                        db.saveTicket(activeTicket);

                        await sendFollowupToTeams(activeTicket, messageData);
                        console.log(`📤 User declined to elaborate — escalated ticket ${activeTicket.id} to Teams with note`);

                        const noDetailText = "No problem — I've let the support team know that the issue isn't resolved yet. They'll reach out to you for more details shortly.";
                        const noDetailMsg = {
                            type: 'response',
                            sender: 'AI Assistant',
                            timestamp: new Date().toISOString(),
                            text: noDetailText,
                            messageId: `resp_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
                            originalMessageId: messageData.messageId,
                            category: 'followup_support',
                            conversationId: messageData.conversationId,
                            ticket_id: activeTicket.id
                        };

                        messages.push(noDetailMsg);
                        conversationMessagesStore[messageData.conversationId].push({ role: 'assistant', message_text: noDetailText, assistant_message: noDetailText, matched_issue: 'followup_support', ticket_id: activeTicket.id, messageId: noDetailMsg.messageId, created_at: noDetailMsg.timestamp });
                        updateChatSummary(messageData.conversationId, { assistant_message: noDetailText, matched_issue: 'followup_support', ticket_id: activeTicket.id });
                        updateConversation(messageData.conversationId, { preview: noDetailText });
                        io.to(messageData.conversationId).emit('responseMessage', noDetailMsg);
                        db.saveChatMessage({ conversationId: messageData.conversationId, messageId: noDetailMsg.messageId, role: 'assistant', messageText: noDetailText, intent: null, matchedIssue: 'followup_support', issueSummary: null, attachmentSummary: null, ticketId: activeTicket.id, fileUrl: null, fileType: null, fileName: null, createdAt: noDetailMsg.timestamp });

                        return;
                    }

                    // User actually provided details — forward to Teams
                    saveFollowupTicket(activeTicket, messageData.text, messageData.conversationId);
                    activeTicket.status = 'awaiting_agent_reply';
                    db.saveTicket(activeTicket);

                    await sendFollowupToTeams(activeTicket, messageData);
                    console.log(`📤 User provided details — follow-up on ticket ${activeTicket.id} forwarded to Teams`);

                    const detailFollowUpText = "Thanks for the details. I've shared your follow-up with the support team. They'll get back to you shortly.";
                    const detailFollowUpMsg = {
                        type: 'response',
                        sender: 'AI Assistant',
                        timestamp: new Date().toISOString(),
                        text: detailFollowUpText,
                        messageId: `resp_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
                        originalMessageId: messageData.messageId,
                        category: 'followup_support',
                        conversationId: messageData.conversationId,
                        ticket_id: activeTicket.id
                    };

                    messages.push(detailFollowUpMsg);
                    conversationMessagesStore[messageData.conversationId].push({ role: 'assistant', message_text: detailFollowUpText, assistant_message: detailFollowUpText, matched_issue: 'followup_support', ticket_id: activeTicket.id, messageId: detailFollowUpMsg.messageId, created_at: detailFollowUpMsg.timestamp });
                    updateChatSummary(messageData.conversationId, { assistant_message: detailFollowUpText, matched_issue: 'followup_support', ticket_id: activeTicket.id });
                    updateConversation(messageData.conversationId, { preview: detailFollowUpText });
                    io.to(messageData.conversationId).emit('responseMessage', detailFollowUpMsg);
                    db.saveChatMessage({ conversationId: messageData.conversationId, messageId: detailFollowUpMsg.messageId, role: 'assistant', messageText: detailFollowUpText, intent: null, matchedIssue: 'followup_support', issueSummary: null, attachmentSummary: null, ticketId: activeTicket.id, fileUrl: null, fileType: null, fileName: null, createdAt: detailFollowUpMsg.timestamp });

                    return;
                }

                // ---- STATE: awaiting_user_reply ----
                // Agent has responded. User sends their first message after that.
                // Ask once: "Did this resolve your issue?"
                if (activeTicket.status === 'awaiting_user_reply') {
                    activeTicket.status = 'awaiting_resolution_confirmation';
                    activeTicket.updated_at = new Date().toISOString();
                    db.saveTicket(activeTicket);

                    const askText = "Did the support team's response resolve your issue? Reply 'yes' if resolved, or describe what's still wrong and I'll follow up for you.";
                    const askMessage = {
                        type: 'response',
                        sender: 'AI Assistant',
                        timestamp: new Date().toISOString(),
                        text: askText,
                        messageId: `resp_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
                        originalMessageId: messageData.messageId,
                        category: 'resolution_check',
                        conversationId: messageData.conversationId,
                        ticket_id: activeTicket.id
                    };

                    messages.push(askMessage);
                    conversationMessagesStore[messageData.conversationId].push({ role: 'assistant', message_text: askText, assistant_message: askText, matched_issue: 'resolution_check', ticket_id: activeTicket.id, messageId: askMessage.messageId, created_at: askMessage.timestamp });
                    updateChatSummary(messageData.conversationId, { assistant_message: askText, matched_issue: 'resolution_check', ticket_id: activeTicket.id });
                    updateConversation(messageData.conversationId, { preview: askText });
                    io.to(messageData.conversationId).emit('responseMessage', askMessage);
                    db.saveChatMessage({ conversationId: messageData.conversationId, messageId: askMessage.messageId, role: 'assistant', messageText: askText, intent: null, matchedIssue: 'resolution_check', issueSummary: null, attachmentSummary: null, ticketId: activeTicket.id, fileUrl: null, fileType: null, fileName: null, createdAt: askMessage.timestamp });

                    console.log(`❓ Asked user for resolution confirmation on ticket ${activeTicket.id}`);
                    return;
                }

                // ---- STATE: awaiting_agent_reply or other active states ----
                // User already sent a follow-up and we're waiting for the agent.

                // --- STEP 0: Handled via classifyTicketIntent which now includes 'clarification' ---
                const normalizedWait = messageData.text.trim().toLowerCase();

                // --- STEP 1: Ticket status inquiry (fast-path) ---
                // Only match genuine status questions, NOT clarification requests
                if (/\b(ticket|issue|status|update|progress|eta|when|how\s*long|any\s*(update|news|response|reply)|where\s*(is|are)|what('?s|\s+is)\s*(the|my)?\s*(status|update|progress|ticket))\b/i.test(normalizedWait) &&
                    !/\b(new|different|another|also|additionally|separate)\b/i.test(normalizedWait) &&
                    !/\b(wdym|what\s*(do|did|does)\s*(you|u|that|it)\s*mean|mean\s*by)\b/i.test(normalizedWait) &&
                    !/\b(you|u)\s*(said|wrote|told|mentioned|typed|definitely|literally|just\s*said)\b/i.test(normalizedWait)) {
                    const ticketAge = Math.round((Date.now() - new Date(activeTicket.created_at).getTime()) / 60000);
                    let statusText;
                    if (ticketAge < 5) {
                        statusText = `Your ticket (${activeTicket.id}) was just created a few minutes ago. The support team has been notified and will respond shortly. Hang tight!`;
                    } else if (ticketAge < 60) {
                        statusText = `Your ticket (${activeTicket.id}) is currently with the support team — it's been about ${ticketAge} minutes since it was created. They're working on it and I'll notify you as soon as there's a response.`;
                    } else {
                        const hours = Math.round(ticketAge / 60);
                        statusText = `Your ticket (${activeTicket.id}) has been open for about ${hours} hour${hours > 1 ? 's' : ''}. The support team is still working on it. I'll let you know the moment they respond.`;
                    }

                    const statusMsg = {
                        type: 'response',
                        sender: 'AI Assistant',
                        timestamp: new Date().toISOString(),
                        text: statusText,
                        messageId: `resp_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
                        originalMessageId: messageData.messageId,
                        category: 'status_inquiry',
                        conversationId: messageData.conversationId,
                        ticket_id: activeTicket.id
                    };

                    messages.push(statusMsg);
                    conversationMessagesStore[messageData.conversationId].push({ role: 'assistant', message_text: statusText, assistant_message: statusText, matched_issue: 'status_inquiry', ticket_id: activeTicket.id, messageId: statusMsg.messageId, created_at: statusMsg.timestamp });
                    updateChatSummary(messageData.conversationId, { assistant_message: statusText, matched_issue: 'status_inquiry', ticket_id: activeTicket.id });
                    updateConversation(messageData.conversationId, { preview: statusText });
                    io.to(messageData.conversationId).emit('responseMessage', statusMsg);
                    db.saveChatMessage({ conversationId: messageData.conversationId, messageId: statusMsg.messageId, role: 'assistant', messageText: statusText, intent: null, matchedIssue: 'status_inquiry', issueSummary: null, attachmentSummary: null, ticketId: activeTicket.id, fileUrl: null, fileType: null, fileName: null, createdAt: statusMsg.timestamp });

                    console.log(`📊 Status inquiry from user on ticket ${activeTicket.id} — specific status sent`);
                    return;
                }

                // --- STEP 2: Local pre-classifier catches non-support messages ---
                // Greetings, off-topic, bot capability, goodbyes, etc. — respond with ticket-aware context
                const localIntent = classifyLocalIntent(messageData.text);
                if (localIntent.matched) {
                    // Append a ticket reminder to the local response
                    const ticketReminder = ` Meanwhile, your support ticket (${activeTicket.id}) is still being handled — I'll notify you as soon as the team responds.`;
                    const ticketAwareResponse = localIntent.response + ticketReminder;

                    emitLocalResponse({
                        io,
                        messageData,
                        responseText: ticketAwareResponse,
                        category: localIntent.category,
                        conversationId: messageData.conversationId
                    });
                    console.log(`🏠 Local response [${localIntent.category}] during active ticket ${activeTicket.id}: "${messageData.text}"`);
                    return;
                }

                // --- STEP 3: Casual ack detection (ok, sure, cool, etc.) ---
                const waitingIntent = await classifyTicketIntent(messageData.text, 'waiting_for_agent');
                console.log(`🔍 Waiting intent for "${messageData.text}": ${waitingIntent}`);

                if (waitingIntent === 'casual_ack') {
                    const ackWaitText = "No worries! The support team is working on it. I'll let you know as soon as they respond.";
                    const ackWaitMsg = {
                        type: 'response',
                        sender: 'AI Assistant',
                        timestamp: new Date().toISOString(),
                        text: ackWaitText,
                        messageId: `resp_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
                        originalMessageId: messageData.messageId,
                        category: 'casual_ack',
                        conversationId: messageData.conversationId,
                        ticket_id: activeTicket.id
                    };

                    messages.push(ackWaitMsg);
                    conversationMessagesStore[messageData.conversationId].push({ role: 'assistant', message_text: ackWaitText, assistant_message: ackWaitText, matched_issue: 'casual_ack', ticket_id: activeTicket.id, messageId: ackWaitMsg.messageId, created_at: ackWaitMsg.timestamp });
                    updateChatSummary(messageData.conversationId, { assistant_message: ackWaitText, matched_issue: 'casual_ack', ticket_id: activeTicket.id });
                    updateConversation(messageData.conversationId, { preview: ackWaitText });
                    io.to(messageData.conversationId).emit('responseMessage', ackWaitMsg);
                    db.saveChatMessage({ conversationId: messageData.conversationId, messageId: ackWaitMsg.messageId, role: 'assistant', messageText: ackWaitText, intent: null, matchedIssue: 'casual_ack', issueSummary: null, attachmentSummary: null, ticketId: activeTicket.id, fileUrl: null, fileType: null, fileName: null, createdAt: ackWaitMsg.timestamp });

                    console.log(`💬 Casual acknowledgment from user on ticket ${activeTicket.id} — friendly reply sent`);
                    return;
                }

                // LLM caught clarification, off_topic, or status_inquiry that regex missed
                if (waitingIntent === 'clarification') {
                    const clarificationText = await generateClarificationResponse(messageData.conversationId, messageData.text, activeTicket);
                    const clarifyMsg = {
                        type: 'response',
                        sender: 'AI Assistant',
                        timestamp: new Date().toISOString(),
                        text: clarificationText,
                        messageId: `resp_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
                        originalMessageId: messageData.messageId,
                        category: 'clarification',
                        conversationId: messageData.conversationId,
                        ticket_id: activeTicket.id
                    };

                    messages.push(clarifyMsg);
                    conversationMessagesStore[messageData.conversationId].push({ role: 'assistant', message_text: clarificationText, assistant_message: clarificationText, matched_issue: 'clarification', ticket_id: activeTicket.id, messageId: clarifyMsg.messageId, created_at: clarifyMsg.timestamp });
                    updateChatSummary(messageData.conversationId, { assistant_message: clarificationText, matched_issue: 'clarification', ticket_id: activeTicket.id });
                    updateConversation(messageData.conversationId, { preview: clarificationText });
                    io.to(messageData.conversationId).emit('responseMessage', clarifyMsg);
                    db.saveChatMessage({ conversationId: messageData.conversationId, messageId: clarifyMsg.messageId, role: 'assistant', messageText: clarificationText, intent: null, matchedIssue: 'clarification', issueSummary: null, attachmentSummary: null, ticketId: activeTicket.id, fileUrl: null, fileType: null, fileName: null, createdAt: clarifyMsg.timestamp });

                    console.log(`💡 Clarification (LLM-detected) on ticket ${activeTicket.id}: "${messageData.text}"`);
                    return;
                }

                if (waitingIntent === 'off_topic' || waitingIntent === 'status_inquiry') {
                    let responseText;
                    if (waitingIntent === 'status_inquiry') {
                        const ticketAge = Math.round((Date.now() - new Date(activeTicket.created_at).getTime()) / 60000);
                        responseText = ticketAge < 60
                            ? `Your ticket (${activeTicket.id}) is with the support team — about ${ticketAge} minute${ticketAge !== 1 ? 's' : ''} in. I'll let you know as soon as they respond.`
                            : `Your ticket (${activeTicket.id}) has been open for about ${Math.round(ticketAge / 60)} hour${Math.round(ticketAge / 60) > 1 ? 's' : ''}. The team is still working on it — I'll update you when they reply.`;
                    } else {
                        responseText = `I appreciate the chat! 😊 Your support ticket (${activeTicket.id}) is still being handled — I'll let you know as soon as the team responds.`;
                    }

                    const llmCatchMsg = {
                        type: 'response',
                        sender: 'AI Assistant',
                        timestamp: new Date().toISOString(),
                        text: responseText,
                        messageId: `resp_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
                        originalMessageId: messageData.messageId,
                        category: waitingIntent,
                        conversationId: messageData.conversationId,
                        ticket_id: activeTicket.id
                    };

                    messages.push(llmCatchMsg);
                    conversationMessagesStore[messageData.conversationId].push({ role: 'assistant', message_text: responseText, assistant_message: responseText, matched_issue: waitingIntent, ticket_id: activeTicket.id, messageId: llmCatchMsg.messageId, created_at: llmCatchMsg.timestamp });
                    updateChatSummary(messageData.conversationId, { assistant_message: responseText, matched_issue: waitingIntent, ticket_id: activeTicket.id });
                    updateConversation(messageData.conversationId, { preview: responseText });
                    io.to(messageData.conversationId).emit('responseMessage', llmCatchMsg);
                    db.saveChatMessage({ conversationId: messageData.conversationId, messageId: llmCatchMsg.messageId, role: 'assistant', messageText: responseText, intent: null, matchedIssue: waitingIntent, issueSummary: null, attachmentSummary: null, ticketId: activeTicket.id, fileUrl: null, fileType: null, fileName: null, createdAt: llmCatchMsg.timestamp });

                    console.log(`🔍 LLM caught ${waitingIntent} during active ticket ${activeTicket.id}`);
                    return;
                }

                // --- STEP 4: Only true substantive follow-ups get forwarded ---
                saveFollowupTicket(activeTicket, messageData.text, messageData.conversationId);

                const waitText = "Your follow-up has been shared with the support team. They'll get back to you shortly.";
                const waitMessage = {
                    type: 'response',
                    sender: 'AI Assistant',
                    timestamp: new Date().toISOString(),
                    text: waitText,
                    messageId: `resp_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
                    originalMessageId: messageData.messageId,
                    category: 'followup_support',
                    conversationId: messageData.conversationId,
                    ticket_id: activeTicket.id
                };

                messages.push(waitMessage);
                conversationMessagesStore[messageData.conversationId].push({ role: 'assistant', message_text: waitText, assistant_message: waitText, matched_issue: 'followup_support', ticket_id: activeTicket.id, messageId: waitMessage.messageId, created_at: waitMessage.timestamp });
                updateChatSummary(messageData.conversationId, { assistant_message: waitText, matched_issue: 'followup_support', ticket_id: activeTicket.id });
                updateConversation(messageData.conversationId, { preview: waitText });
                io.to(messageData.conversationId).emit('responseMessage', waitMessage);
                db.saveChatMessage({ conversationId: messageData.conversationId, messageId: waitMessage.messageId, role: 'assistant', messageText: waitText, intent: null, matchedIssue: 'followup_support', issueSummary: null, attachmentSummary: null, ticketId: activeTicket.id, fileUrl: null, fileType: null, fileName: null, createdAt: waitMessage.timestamp });

                return;
            }
            // ========== END BACK-AND-FORTH ==========

            // ========== LOCAL PRE-CLASSIFIER (no LLM) ==========
            if (messageData.text && !messageData.file_url) {
                // --- Escalation gate: intercept support requests before min attempts ---
                if (isEscalationRequest(messageData.text)) {
                    const gate = checkEscalationGate(messageData.conversationId);
                    if (gate.gated) {
                        emitLocalResponse({
                            io,
                            messageData,
                            responseText: gate.response,
                            category: 'escalation_gate',
                            conversationId: messageData.conversationId
                        });
                        console.log(`🚧 Escalation gated for ${messageData.conversationId}: ${gate.botAttempts}/${MIN_BOT_ATTEMPTS_BEFORE_ESCALATION} attempts`);
                        return;
                    }
                }

                const localIntent = classifyLocalIntent(messageData.text);
                if (localIntent.matched) {
                    emitLocalResponse({
                        io,
                        messageData,
                        responseText: localIntent.response,
                        category: localIntent.category,
                        conversationId: messageData.conversationId
                    });
                    return;
                }
            }
            // ========== END LOCAL PRE-CLASSIFIER ==========

            // No active ticket, no local match — proceed with normal n8n flow
            await sendToN8n(messageData);
        } catch (error) {
            console.error('❌ Error sending message:', error.message);
            socket.emit('error', { message: 'Failed to send message' });
        }
    });

    socket.on('joinConversation', (conversationId) => {
        if (!conversationId) return;
        socket.join(conversationId);
    });

    socket.on('switchConversation', ({ oldConversationId, newConversationId }) => {
        if (oldConversationId) socket.leave(oldConversationId);
        if (newConversationId) socket.join(newConversationId);
    });

    socket.on('typing', (data) => {
        socket.broadcast.emit('userTyping', {
            sender: data.sender,
            isTyping: data.isTyping
        });
    });

    socket.on('disconnect', () => {
        activeUsers--;
        io.emit('activeUsers', activeUsers);
    });
});

// -------------------- N8N CONNECTION --------------------

async function initializeN8nConnection() {
    try {
        n8nConnected = true;

        while (messageQueue.length > 0) {
            const msg = messageQueue.shift();
            await sendToN8n(msg);
        }
    } catch (error) {
        console.error('❌ Failed to initialize n8n connection:', error.message);
        n8nConnected = false;
        setTimeout(initializeN8nConnection, 5000);
    }
}

async function sendToN8n(messageData) {
    try {
        const convId = messageData.conversationId || messageData.sender || 'Guest';

        // Update summary with current user message BEFORE sending to n8n
        // so ticket creation gets the full picture
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
            chat_summary: summaryData.summary || ''
        };

        const response = await axios.post(N8N_WEBHOOK_URL, payload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 30000
        });

        n8nConnected = true;
        return response.data;
    } catch (error) {
        console.error('❌ Error sending to n8n:', error.response?.data || error.message);
        n8nConnected = false;
        return null;
    }
}

// -------------------- UTILITY ROUTES --------------------

app.delete('/api/messages', (req, res) => {
    messages = [];
    io.emit('messagesCleared');
    res.json({ message: 'Messages cleared' });
});

app.get('/api/n8n-status', (req, res) => {
    res.json({
        connected: n8nConnected,
        webhookUrl: N8N_WEBHOOK_URL,
        queuedMessages: messageQueue.length,
        totalMessages: messages.length
    });
});

app.post('/api/reconnect-n8n', async (req, res) => {
    n8nConnected = false;
    await initializeN8nConnection();

    res.json({
        message: 'Reconnection initiated',
        connected: n8nConnected
    });
});

// -------------------- MEMORY ROUTES --------------------

app.post('/api/chat-memory/get', (req, res) => {
    try {
        const { conversationId, sessionId, limit = 20 } = req.body;
        const key = conversationId || sessionId;

        if (!key) {
            return res.status(400).json({ error: 'conversationId or sessionId is required' });
        }

        const sessionMessages = chatMemoryStore[key] || [];
        const recentMessages = sessionMessages.slice(-Number(limit || 20));
        const summaryData = getChatSummary(key);

        res.json({
            success: true,
            conversationId: key,
            messages: recentMessages,
            chat_summary: summaryData.summary
        });
    } catch (error) {
        console.error('❌ Error loading chat memory:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/chat-memory/save-turn', (req, res) => {
    try {
        const {
            conversationId,
            sessionId,
            user_message,
            assistant_message,
            user_query = null,
            intent = null,
            matched_issue = null,
            issue_summary = null,
            attachment_summary = null,
            ticket_id = null,
            messageId = null,
            file_url = null,
            file_type = null,
            file_name = null
        } = req.body;

        const key = conversationId || sessionId;

        if (!key) {
            return res.status(400).json({ error: 'conversationId or sessionId is required' });
        }

        if (!chatMemoryStore[key]) {
            chatMemoryStore[key] = [];
        }

        const now = new Date().toISOString();

        if (user_message) {
            chatMemoryStore[key].push({
                role: 'user',
                message_text: user_message,
                user_message,
                user_query: user_query || user_message,
                intent,
                matched_issue,
                issue_summary,
                attachment_summary,
                ticket_id,
                messageId,
                file_url,
                file_type,
                file_name,
                created_at: now
            });
            db.saveChatMessage({ conversationId: key, messageId, role: 'user', messageText: user_message, intent, matchedIssue: matched_issue, issueSummary: issue_summary, attachmentSummary: attachment_summary, ticketId: ticket_id, fileUrl: file_url, fileType: file_type, fileName: file_name, createdAt: now });
        }

        if (assistant_message) {
            chatMemoryStore[key].push({
                role: 'assistant',
                message_text: assistant_message,
                assistant_message,
                intent,
                matched_issue,
                issue_summary,
                attachment_summary,
                ticket_id,
                messageId,
                file_url,
                file_type,
                file_name,
                created_at: now
            });
            db.saveChatMessage({ conversationId: key, messageId, role: 'assistant', messageText: assistant_message, intent, matchedIssue: matched_issue, issueSummary: issue_summary, attachmentSummary: attachment_summary, ticketId: ticket_id, fileUrl: file_url, fileType: file_type, fileName: file_name, createdAt: now });
        }

        if (chatMemoryStore[key].length > 50) {
            chatMemoryStore[key] = chatMemoryStore[key].slice(-50);
        }

        // Update running chat summary
        updateChatSummary(key, {
            user_message,
            assistant_message,
            intent,
            matched_issue,
            issue_summary,
            attachment_summary,
            ticket_id
        });

        const summaryData = getChatSummary(key);

        res.json({
            success: true,
            conversationId: key,
            totalMessages: chatMemoryStore[key].length,
            chat_summary: summaryData.summary
        });
    } catch (error) {
        console.error('❌ Error saving chat memory:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/chat-memory/:conversationId', (req, res) => {
    try {
        const { conversationId } = req.params;
        const summaryData = getChatSummary(conversationId);
        res.json({
            success: true,
            conversationId,
            messages: chatMemoryStore[conversationId] || [],
            chat_summary: summaryData.summary
        });
    } catch (error) {
        console.error('❌ Error fetching chat memory by conversationId:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// -------------------- TEAMS THREAD MAPPING ROUTES --------------------

app.post('/api/teams/register-thread', (req, res) => {
    try {
        const { teamsMessageId, conversationId, ticket_id = null } = req.body || {};

        if (!teamsMessageId || !conversationId) {
            return res.status(400).json({
                success: false,
                error: 'teamsMessageId and conversationId are required'
            });
        }

        teamsThreadMap[String(teamsMessageId)] = {
            teamsMessageId: String(teamsMessageId),
            conversationId,
            ticket_id
        };

        console.log('✅ Registered Teams thread mapping:', {
            teamsMessageId,
            conversationId,
            ticket_id
        });

        return res.json({
            success: true,
            data: teamsThreadMap[String(teamsMessageId)]
        });
    } catch (error) {
        console.error('❌ Error registering thread:', error.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/teams/resolve-conversation', (req, res) => {
    try {
        const { replyToMessageId, teamsMessageId } = req.body || {};
        const key = String(replyToMessageId || teamsMessageId || '');

        console.log('\n===== /api/teams/resolve-conversation HIT =====');
        console.log('Body:', JSON.stringify(req.body, null, 2));
        console.log('Lookup key:', key);
        console.log('Available teamsThreadMap keys:', Object.keys(teamsThreadMap));

        if (!key) {
            return res.status(400).json({
                success: false,
                error: 'replyToMessageId or teamsMessageId required'
            });
        }

        const mapping = teamsThreadMap[key];

        if (!mapping) {
            console.log('❌ Mapping not found for key:', key);
            return res.status(404).json({
                success: false,
                error: 'Mapping not found',
                lookupKey: key
            });
        }

        console.log('✅ Mapping found:', mapping);

        return res.json({
            success: true,
            conversationId: mapping.conversationId,
            ticket_id: mapping.ticket_id || null,
            teamsMessageId: mapping.teamsMessageId || key
        });
    } catch (error) {
        console.error('❌ Error resolving conversation:', error.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// -------------------- RESPONSE ROUTES --------------------

app.get('/api/send-response', (req, res) => {
    try {
        const responseData = req.query;
        const messageText = responseData.response || responseData.message;

        console.log('\n================ GET /api/send-response HIT ================');
        console.log('Time:', new Date().toISOString());
        console.log('Raw Query:', JSON.stringify(responseData, null, 2));

        if (!messageText) {
            console.log('❌ Missing response/message in query');
            console.log('============================================================\n');
            return res.status(400).json({ error: 'Missing response or message query param' });
        }

        const responseMessage = {
            type: 'response',
            sender: responseData.sender || responseData.source || 'AI Assistant',
            timestamp: new Date().toISOString(),
            text: messageText,
            messageId: responseData.messageId || `resp_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
            originalMessageId: responseData.originalMessageId || null,
            category: responseData.category || null,
            conversationId: responseData.conversationId || null,
            ticket_id: responseData.ticket_id || null
        };

        console.log('✅ GET responseMessage:', JSON.stringify(responseMessage, null, 2));

        messages.push(responseMessage);

        if (responseMessage.conversationId) {
            io.to(responseMessage.conversationId).emit('responseMessage', responseMessage);
            console.log('📡 Emitted GET responseMessage to room:', responseMessage.conversationId);
        }

        console.log('============================================================\n');

        res.json({
            success: true,
            messageId: responseMessage.messageId,
            data: responseMessage
        });
    } catch (error) {
        console.error('❌ Error processing GET response:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/send-response', async (req, res) => {
    try {
        sendResponseHitCount++;

        const responseData = req.body || {};

        // Accept multiple possible field names safely
        let messageText =
            responseData.replyText ||
            responseData.response ||
            responseData.message ||
            null;

        // Strip &nbsp; (literal string and HTML entity) that Teams / Power Automate injects
        if (messageText) {
            messageText = messageText
                .replace(/&nbsp;/gi, ' ')
                .replace(/\u00A0/g, ' ')
                .replace(/\s{2,}/g, ' ')
                .trim();
        }

        const teamsMessageId = responseData.teamsMessageId || null;
        const replyToMessageId = responseData.replyToMessageId || null;
        const conversationId = responseData.conversationId || null;
        const originalMessageId = responseData.originalMessageId || null;
        const sender = responseData.sender || responseData.source || 'Support Agent';

        // Use the actual reply message id for dedupe.
        // Do NOT use replyToMessageId as primary dedupe key because all replies in the same thread
        // can share the same parent id.
        // For AI Assistant responses, use originalMessageId (the user message being replied to)
        // so each user message gets exactly one response, even if the text is identical.
        const dedupeKey = teamsMessageId
            ? `${conversationId || 'no-conv'}::${teamsMessageId}`
            : originalMessageId
                ? `${conversationId || 'no-conv'}::${originalMessageId}`
                : `${conversationId || 'no-conv'}::${messageText || 'no-message'}::${Date.now()}`;

        console.log('\n================ POST /api/send-response HIT ================');
        console.log('Hit #:', sendResponseHitCount);
        console.log('Time:', new Date().toISOString());
        console.log('Sender:', sender);
        console.log('Conversation ID:', conversationId);
        console.log('Teams Message ID:', teamsMessageId);
        console.log('Reply To Message ID:', replyToMessageId);
        console.log('Message Text:', messageText);
        console.log('Dedupe Key:', dedupeKey);
        console.log('Raw Body:', JSON.stringify(responseData, null, 2));

        if (!messageText) {
            console.log('❌ Missing reply text in body');
            console.log('=============================================================\n');
            return res.status(400).json({
                success: false,
                error: 'Missing replyText, response, or message field'
            });
        }

        // Filter out raw Teams attachment XML / card noise from Power Automate
        const cleanedText = String(messageText).trim();
        const isAttachmentNoise = /^(<attachment[^>]*>\s*<\/attachment>\s*)+$/i.test(cleanedText);
        const isCardJson = /^\s*\{.*"@type"\s*:\s*"MessageCard"/i.test(cleanedText);
        const isEmptyAfterStrip = cleanedText.replace(/<attachment[^>]*>\s*<\/attachment>/gi, '').trim().length === 0;

        if (isAttachmentNoise || isCardJson || isEmptyAfterStrip) {
            console.log('⚠️ TEAMS CARD/ATTACHMENT NOISE -> ignoring');
            console.log('=============================================================\n');
            return res.json({
                success: true,
                ignored: true,
                reason: 'attachment/card noise filtered'
            });
        }

        if (processedTeamsReplies.has(dedupeKey)) {
            console.log('⚠️ DUPLICATE DETECTED -> ignoring');
            console.log('=============================================================\n');
            return res.json({
                success: true,
                ignored: true,
                reason: 'duplicate reply ignored'
            });
        }

        processedTeamsReplies.set(dedupeKey, Date.now());

        setTimeout(() => {
            processedTeamsReplies.delete(dedupeKey);
        }, 10 * 60 * 1000);

        // ---- STALE THREAD FILTER ----
        // Only accept replies from the latest active escalation thread for a conversation.
        // If the replyToMessageId maps to an old/resolved ticket, silently ignore the reply.
        if (conversationId && replyToMessageId) {
            const threadMapping = teamsThreadMap[String(replyToMessageId)];
            if (threadMapping && threadMapping.ticket_id) {
                const threadTicket = ticketsStore[threadMapping.ticket_id];
                if (threadTicket && threadTicket.status === 'resolved') {
                    console.log(`⚠️ STALE THREAD: Reply on resolved ticket ${threadMapping.ticket_id} — ignoring`);
                    console.log('=============================================================\n');
                    return res.json({
                        success: true,
                        ignored: true,
                        reason: 'reply on resolved/stale ticket thread'
                    });
                }

                // Check if there's a newer ticket for this conversation
                const latestTicket = findActiveTicketForConversation(conversationId);
                if (latestTicket && latestTicket.id !== threadMapping.ticket_id) {
                    console.log(`⚠️ STALE THREAD: Reply on old ticket ${threadMapping.ticket_id}, latest is ${latestTicket.id} — ignoring`);
                    console.log('=============================================================\n');
                    return res.json({
                        success: true,
                        ignored: true,
                        reason: `reply on old ticket thread (latest: ${latestTicket.id})`
                    });
                }
            }
        }
        // ---- END STALE THREAD FILTER ----

        // ---- MODERATION INTERCEPT ----
        // Any response NOT explicitly from the AI Assistant goes through moderation.
        // n8n always sends sender='AI Assistant'; Power Automate / Teams replies will have
        // a different sender (or default to 'Support Agent'), so they get held.
        const isTeamsHumanReply = sender !== 'AI Assistant';

        if (isTeamsHumanReply) {
            const modId = `mod_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

            // ---------- STEP 1: Script-based check ----------
            const scriptResult = scriptModerate(messageText);
            console.log('🛡️ MODERATION script check:', {
                passed: scriptResult.passed,
                issues: scriptResult.issues
            });

            if (scriptResult.passed) {
                // Script passed — auto-approve, deliver to chat, close ticket
                const modItem = {
                    id: modId,
                    conversationId,
                    sender,
                    text: messageText,
                    originalText: messageText,
                    teamsMessageId,
                    replyToMessageId,
                    category: responseData.category || null,
                    ticket_id: responseData.ticket_id || null,
                    originalMessageId: responseData.originalMessageId || replyToMessageId || null,
                    messageId: responseData.messageId || `resp_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
                    timestamp: new Date().toISOString(),
                    status: 'approved',
                    moderation: { method: 'script', passed: true, issues: [] }
                };

                moderationQueue[modId] = modItem;
                const delivered = deliverModerationItem(modItem);
                db.saveModerationItem(modItem); // persist to MySQL

                // Mark ticket as awaiting user reply (keep open for back-and-forth)
                const awaitingTicketId = markTicketAwaitingUserReply(conversationId, responseData.ticket_id);

                io.emit('moderation:new', modItem);
                console.log('✅ MODERATION: Script passed — auto-approved & delivered, ticket awaiting user reply:', awaitingTicketId);
                console.log('=============================================================\n');

                return res.json({
                    success: true,
                    auto_approved: true,
                    moderationId: modId,
                    ticket_awaiting_reply: !!awaitingTicketId
                });
            }

            // ---------- STEP 2: Script failed → LLM fallback ----------
            console.log('⚠️ MODERATION: Script failed, calling LLM fallback...');
            const llmResult = await llmModerate(messageText, scriptResult.issues);
            console.log('🤖 MODERATION LLM result:', llmResult);

            if (llmResult.appropriate && llmResult.refinedText) {
                // LLM refined the message — hold for manual review with both versions shown
                const modItem = {
                    id: modId,
                    conversationId,
                    sender,
                    text: llmResult.refinedText,
                    originalText: messageText,
                    teamsMessageId,
                    replyToMessageId,
                    category: responseData.category || null,
                    ticket_id: responseData.ticket_id || null,
                    originalMessageId: responseData.originalMessageId || replyToMessageId || null,
                    messageId: responseData.messageId || `resp_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
                    timestamp: new Date().toISOString(),
                    status: 'pending',
                    moderation: {
                        method: 'llm_refined',
                        scriptIssues: scriptResult.issues,
                        llmReason: llmResult.reason,
                        originalText: messageText,
                        refinedText: llmResult.refinedText
                    }
                };

                moderationQueue[modId] = modItem;
                io.emit('moderation:new', modItem);
                db.saveModerationItem(modItem); // persist to MySQL
                console.log('🛡️ MODERATION: LLM refined — held for manual approval ->', modId);
                console.log('=============================================================\n');

                return res.json({
                    success: true,
                    held_for_moderation: true,
                    moderationId: modId,
                    llm_refined: true
                });
            } else {
                // LLM says not appropriate — auto-reject, don't close ticket
                const modItem = {
                    id: modId,
                    conversationId,
                    sender,
                    text: messageText,
                    originalText: messageText,
                    teamsMessageId,
                    replyToMessageId,
                    category: responseData.category || null,
                    ticket_id: responseData.ticket_id || null,
                    originalMessageId: responseData.originalMessageId || replyToMessageId || null,
                    messageId: responseData.messageId || `resp_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
                    timestamp: new Date().toISOString(),
                    status: 'rejected',
                    moderation: {
                        method: 'llm_rejected',
                        scriptIssues: scriptResult.issues,
                        llmReason: llmResult.reason
                    }
                };

                moderationQueue[modId] = modItem;
                io.emit('moderation:new', modItem);
                db.saveModerationItem(modItem); // persist to MySQL
                console.log('❌ MODERATION: LLM rejected — not appropriate, ticket NOT closed ->', modId);
                console.log('=============================================================\n');

                return res.json({
                    success: true,
                    auto_rejected: true,
                    moderationId: modId,
                    reason: llmResult.reason
                });
            }
        }
        // ---- END MODERATION INTERCEPT ----

        const responseMessage = {
            type: 'response',
            sender,
            timestamp: new Date().toISOString(),
            text: messageText,
            messageId: responseData.messageId || `resp_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
            originalMessageId: responseData.originalMessageId || replyToMessageId || null,
            category: responseData.category || null,
            conversationId,
            ticket_id: responseData.ticket_id || null,
            teamsMessageId,
            replyToMessageId
        };

        console.log('✅ Creating POST responseMessage:', JSON.stringify(responseMessage, null, 2));

        messages.push(responseMessage);
        console.log('Messages array length:', messages.length);

        if (responseMessage.conversationId) {
            if (!conversationMessagesStore[responseMessage.conversationId]) {
                conversationMessagesStore[responseMessage.conversationId] = [];
            }

            conversationMessagesStore[responseMessage.conversationId].push({
                role: 'assistant',
                message_text: messageText,
                assistant_message: messageText,
                matched_issue: responseData.category || null,
                ticket_id: responseData.ticket_id || null,
                teamsMessageId,
                replyToMessageId,
                messageId: responseMessage.messageId,
                created_at: responseMessage.timestamp
            });

            // Update running chat summary with the AI/agent response
            updateChatSummary(responseMessage.conversationId, {
                assistant_message: messageText,
                matched_issue: responseData.category || null,
                ticket_id: responseData.ticket_id || null
            });

            // Update last_response_at on any open ticket for this conversation
            const openTicket = findTicketByConversation(responseMessage.conversationId);
            if (openTicket) {
                openTicket.last_response_at = new Date().toISOString();
                openTicket.updated_at = new Date().toISOString();
            }

            console.log(
                'Conversation message count for',
                responseMessage.conversationId,
                ':',
                conversationMessagesStore[responseMessage.conversationId].length
            );

            updateConversation(responseMessage.conversationId, {
                preview: messageText
            });

            console.log('📡 Emitting POST responseMessage to room:', responseMessage.conversationId);
            io.to(responseMessage.conversationId).emit('responseMessage', responseMessage);
        }

        console.log('=============================================================\n');

        return res.json({
            success: true,
            ignored: false,
            messageId: responseMessage.messageId,
            data: responseMessage
        });
    } catch (error) {
        console.error('❌ Error processing POST response:', error.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/debug/send-response-stats', (req, res) => {
    res.json({
        sendResponseHitCount,
        processedTeamsRepliesSize: processedTeamsReplies.size,
        processedTeamsRepliesKeys: [...processedTeamsReplies.keys()]
    });
});

// -------------------- MODERATION ROUTES --------------------

// Helper: deliver an approved moderation item to the chat
function deliverModerationItem(item) {
    const responseMessage = {
        type: 'response',
        sender: item.sender,
        timestamp: item.timestamp,
        text: item.text,
        messageId: item.messageId,
        originalMessageId: item.originalMessageId,
        category: item.category,
        conversationId: item.conversationId,
        ticket_id: item.ticket_id,
        teamsMessageId: item.teamsMessageId,
        replyToMessageId: item.replyToMessageId
    };

    messages.push(responseMessage);

    if (responseMessage.conversationId) {
        if (!conversationMessagesStore[responseMessage.conversationId]) {
            conversationMessagesStore[responseMessage.conversationId] = [];
        }

        conversationMessagesStore[responseMessage.conversationId].push({
            role: 'assistant',
            message_text: item.text,
            assistant_message: item.text,
            matched_issue: item.category || null,
            ticket_id: item.ticket_id || null,
            teamsMessageId: item.teamsMessageId,
            replyToMessageId: item.replyToMessageId,
            messageId: item.messageId,
            created_at: item.timestamp
        });

        // Update chat summary
        updateChatSummary(responseMessage.conversationId, {
            assistant_message: item.text,
            matched_issue: item.category || null,
            ticket_id: item.ticket_id || null
        });

        updateConversation(responseMessage.conversationId, {
            preview: item.text
        });

        // Mark ticket as awaiting user reply (keep open for back-and-forth)
        const awaitingId = markTicketAwaitingUserReply(item.conversationId, item.ticket_id);
        if (awaitingId) {
            console.log(`⏳ Ticket ${awaitingId} marked awaiting_user_reply via deliverModerationItem`);
        }

        io.to(responseMessage.conversationId).emit('responseMessage', responseMessage);
    }

    return responseMessage;
}

// List all pending moderation items
app.get('/api/moderation/queue', (req, res) => {
    const pending = Object.values(moderationQueue)
        .filter(item => item.status === 'pending')
        .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    res.json(pending);
});

// All moderation items (for debugging/history)
app.get('/api/moderation/all', (req, res) => {
    const all = Object.values(moderationQueue)
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    res.json(all);
});

// Approve a moderation item -> deliver to chat
app.post('/api/moderation/approve/:id', (req, res) => {
    const item = moderationQueue[req.params.id];
    if (!item) {
        return res.status(404).json({ error: 'Moderation item not found' });
    }
    if (item.status !== 'pending') {
        return res.status(400).json({ error: `Item already ${item.status}` });
    }

    item.status = 'approved';
    console.log('✅ MODERATION: Approved ->', item.id);
    db.updateModerationStatus(item.id, 'approved'); // persist to MySQL

    const delivered = deliverModerationItem(item);
    io.emit('moderation:resolved', { id: item.id, status: 'approved' });

    // deliverModerationItem already marks ticket as awaiting_user_reply
    // for the back-and-forth flow — do NOT close the ticket here

    res.json({ success: true, status: 'approved', delivered });
});

// Reject a moderation item -> discard
app.post('/api/moderation/reject/:id', (req, res) => {
    const item = moderationQueue[req.params.id];
    if (!item) {
        return res.status(404).json({ error: 'Moderation item not found' });
    }
    if (item.status !== 'pending') {
        return res.status(400).json({ error: `Item already ${item.status}` });
    }

    item.status = 'rejected';
    console.log('❌ MODERATION: Rejected ->', item.id);
    db.updateModerationStatus(item.id, 'rejected'); // persist to MySQL
    io.emit('moderation:resolved', { id: item.id, status: 'rejected' });

    res.json({ success: true, status: 'rejected' });
});

// -------------------- TICKET ROUTES --------------------

app.post('/api/tickets/escalation-due', (req, res) => {
    try {
        const { days_without_response = 0 } = req.body || {};
        const now = Date.now();

        const dueTickets = Object.values(ticketsStore).filter(ticket => {
            if (ticket.status === 'resolved') return false;

            const lastTime = ticket.last_response_at
                ? new Date(ticket.last_response_at).getTime()
                : new Date(ticket.created_at).getTime();

            const diffMs = now - lastTime;
            return diffMs >= days_without_response * 24 * 60 * 60 * 1000;
        });

        res.json({
            success: true,
            count: dueTickets.length,
            tickets: dueTickets
        });
    } catch (error) {
        console.error('❌ Error fetching escalation tickets:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/tickets', (req, res) => {
    try {
        const ticketData = req.body;

        if (!ticketData.ticket_title || !ticketData.ticket_description) {
            return res.status(400).json({ error: 'Missing ticket_title or ticket_description' });
        }

        const now = new Date().toISOString();
        const convId = ticketData.conversationId || ticketData.created_from_conversation || null;
        const summaryData = getChatSummary(convId);

        const ticket = {
            id: `ticket_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
            title: ticketData.ticket_title,
            description: ticketData.ticket_description,
            chat_summary: ticketData.chat_summary || summaryData.summary || '',
            priority: ticketData.priority || 'Medium',
            status: ticketData.status || 'open',
            assigned_to: ticketData.assigned_to || 'support_team',
            assigned_to_name: ticketData.assigned_to_name || null,
            created_at: now,
            updated_at: now,
            last_response_at: null,
            escalated_at: null,
            escalation_level: 0,
            category: ticketData.category || null,
            conversationId: convId
        };
        ticketsStore[ticket.id] = ticket;
        db.saveTicket(ticket); // persist to MySQL

        res.json({
            success: true,
            ticket_id: ticket.id,
            message: 'Ticket created successfully',
            data: ticket
        });
    } catch (error) {
        console.error('❌ Error creating ticket:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/tickets', (req, res) => {
    res.json(Object.values(ticketsStore));
});

// Delete all tickets
app.delete('/api/tickets', async (req, res) => {
    const count = Object.keys(ticketsStore).length;
    for (const id of Object.keys(ticketsStore)) {
        delete ticketsStore[id];
    }
    try {
        await dbPool.query('DELETE FROM tickets');
    } catch (err) {
        console.error('⚠️ Could not clear tickets from MySQL:', err.message);
    }
    res.json({ success: true, deleted: count });
});

// Delete a single ticket by ID
app.delete('/api/tickets/:ticketId', async (req, res) => {
    const ticket = ticketsStore[req.params.ticketId];
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    delete ticketsStore[req.params.ticketId];
    try {
        await dbPool.query('DELETE FROM tickets WHERE id = ?', [req.params.ticketId]);
    } catch (err) {
        console.error('⚠️ Could not delete ticket from MySQL:', err.message);
    }
    res.json({ success: true, deleted_ticket: req.params.ticketId });
});

app.get('/api/tickets/:ticketId/status', (req, res) => {
    const ticket = ticketsStore[req.params.ticketId];
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    res.json({
        ticket_id: ticket.id,
        status: ticket.status,
        escalation_level: ticket.escalation_level,
        created_at: ticket.created_at,
        updated_at: ticket.updated_at,
        last_response_at: ticket.last_response_at,
        escalated_at: ticket.escalated_at,
        assigned_to: ticket.assigned_to
    });
});

app.post('/api/tickets/mark-escalated', (req, res) => {
    try {
        const { ticket_id, escalated = true, escalated_at = null } = req.body || {};

        if (!ticket_id) {
            return res.status(400).json({ error: 'ticket_id is required' });
        }

        const ticket = ticketsStore[ticket_id];
        if (!ticket) {
            return res.status(404).json({ error: 'Ticket not found' });
        }

        if (escalated) {
            applyEscalation(ticket, escalated_at);
        }

        res.json({
            success: true,
            message: 'Ticket marked as escalated',
            data: ticket
        });
    } catch (error) {
        console.error('❌ Error marking ticket escalated:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.patch('/api/tickets/:ticketId', (req, res) => {
    const ticket = ticketsStore[req.params.ticketId];
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    const { status, assigned_to, priority } = req.body || {};

    if (status) ticket.status = status;
    if (assigned_to) ticket.assigned_to = assigned_to;
    if (priority) ticket.priority = priority;

    ticket.updated_at = new Date().toISOString();
    ticket.last_response_at = new Date().toISOString();
    db.saveTicket(ticket); // persist to MySQL

    res.json({
        success: true,
        data: ticket
    });
});

app.patch('/api/tickets/:ticketId/escalate', (req, res) => {
    const ticket = ticketsStore[req.params.ticketId];
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    applyEscalation(ticket);

    res.json({
        success: true,
        message: 'Ticket escalated successfully',
        data: ticket
    });
});

app.post('/api/tickets/recheck', (req, res) => {
    escalateOldTickets(0);
    res.json({ success: true });
});

app.get('/api/tickets/by-conversation/:conversationId', (req, res) => {
    try {
        const { conversationId } = req.params;
        if (!conversationId) {
            return res.status(400).json({ success: false, error: 'conversationId is required' });
        }

        const matchingTickets = Object.values(ticketsStore)
            .filter(t => t.conversationId === conversationId)
            .sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));

        if (matchingTickets.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'No tickets found for this conversation',
                conversationId
            });
        }

        const latest = matchingTickets[0];
        return res.json({
            success: true,
            ticket_id: latest.id,
            ticket: latest,
            total_tickets: matchingTickets.length
        });
    } catch (error) {
        console.error('\u274c Error looking up ticket by conversation:', error.message);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// -------------------- CONVERSATION ROUTES --------------------

app.post('/api/conversations', (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) {
            return res.status(400).json({ error: 'userId required' });
        }

        const convo = createConversation(userId);
        res.json(convo);
    } catch (error) {
        console.error('❌ Failed to create conversation:', error.message);
        res.status(500).json({ error: 'Failed to create conversation' });
    }
});

app.get('/api/conversations/:userId', (req, res) => {
    try {
        const { userId } = req.params;
        res.json(conversationsStore[userId] || []);
    } catch (error) {
        console.error('❌ Failed to fetch conversations:', error.message);
        res.status(500).json({ error: 'Failed to fetch conversations' });
    }
});

app.get('/api/conversations/:conversationId/messages', (req, res) => {
    try {
        const { conversationId } = req.params;
        res.json(conversationMessagesStore[conversationId] || []);
    } catch (error) {
        console.error('❌ Failed to fetch messages:', error.message);
        res.status(500).json({ error: 'Failed to fetch messages' });
    }
});

app.post('/api/conversations/:conversationId/messages', (req, res) => {
    try {
        const { conversationId } = req.params;
        const {
            role,
            message_text,
            file_url = null,
            file_type = null,
            file_name = null,
            intent = null,
            matched_issue = null,
            ticket_id = null,
            messageId = null
        } = req.body;

        if (!conversationId) {
            return res.status(400).json({ error: 'conversationId required' });
        }

        if (!conversationMessagesStore[conversationId]) {
            conversationMessagesStore[conversationId] = [];
        }

        const msg = {
            role,
            message_text,
            file_url,
            file_type,
            file_name,
            intent,
            matched_issue,
            ticket_id,
            messageId: messageId || `msg_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
            created_at: new Date().toISOString()
        };

        conversationMessagesStore[conversationId].push(msg);

        const existingConvo = findConversation(conversationId);
        if (existingConvo) {
            updateConversation(conversationId, {
                title: existingConvo.title === 'New Chat' && role === 'user'
                    ? generateConversationTitle(message_text)
                    : undefined,
                preview: message_text || file_name || 'Attachment'
            });
        }

        res.json({
            success: true,
            conversationId,
            totalMessages: conversationMessagesStore[conversationId].length
        });
    } catch (error) {
        console.error('❌ Failed to save message:', error.message);
        res.status(500).json({ error: 'Failed to save message' });
    }
});

app.patch('/api/conversations/:conversationId', (req, res) => {
    try {
        const { conversationId } = req.params;
        const { title } = req.body;

        const convo = updateConversation(conversationId, { title });
        if (!convo) {
            return res.status(404).json({ error: 'Conversation not found' });
        }

        res.json(convo);
    } catch (error) {
        console.error('❌ Failed to update conversation:', error.message);
        res.status(500).json({ error: 'Failed to update conversation' });
    }
});

app.post('/api/tickets/followup', (req, res) => {
    try {
        const {
            ticket_id,
            conversationId = null,
            latest_user_message = '',
            previous_ticket_description = '',
            merged_description = '',
            assigned_to = null,
            assigned_to_name = null,
            category = 'followup_support'
        } = req.body || {};

        if (!ticket_id) {
            return res.status(400).json({
                success: false,
                error: 'ticket_id is required'
            });
        }

        const ticket = ticketsStore[ticket_id];
        if (!ticket) {
            return res.status(404).json({
                success: false,
                error: 'Ticket not found'
            });
        }

        const oldDescription = previous_ticket_description || ticket.description || '';
        const newDescription =
            merged_description ||
            [
                oldDescription ? `Previous Ticket Description: ${oldDescription}` : '',
                latest_user_message ? `Latest User Follow-Up: ${latest_user_message}` : ''
            ].filter(Boolean).join('\n\n');

        ticket.previous_ticket_description = oldDescription;
        ticket.latest_user_message = latest_user_message || '';
        ticket.description = newDescription;
        ticket.category = category || ticket.category || 'followup_support';
        ticket.conversationId = conversationId || ticket.conversationId || null;

        // Reopen ticket if resolved — supports back-and-forth after prior closure
        if (ticket.status === 'resolved') {
            console.log(`🔓 Reopening resolved ticket ${ticket_id} for follow-up`);
            ticket.resolved_at = null;
        }

        // Only reset status if ticket is not already escalated
        if (ticket.status !== 'escalated') {
            ticket.status = 'existing_ticket_followup';
        }

        ticket.updated_at = new Date().toISOString();
        ticket.last_response_at = new Date().toISOString();

        if (assigned_to) ticket.assigned_to = assigned_to;
        if (assigned_to_name) ticket.assigned_to_name = assigned_to_name;

        if (!ticket.followups) ticket.followups = [];
        ticket.followups.push({
            message: latest_user_message || '',
            created_at: new Date().toISOString()
        });

        // Cap follow-up history at 20 entries
        if (ticket.followups.length > 20) {
            ticket.followups = ticket.followups.slice(-20);
        }

        db.saveTicket(ticket); // persist to MySQL

        return res.json({
            success: true,
            message: 'Follow-up saved successfully',
            ticket_id: ticket.id,
            data: ticket
        });
    } catch (error) {
        console.error('❌ Error saving follow-up ticket:', error.message);
        return res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

// -------------------- TICKET ESCALATION TIMER --------------------

setInterval(() => {
    escalateOldTickets(5);
}, 5 * 60 * 1000); // check every 5 minutes

// -------------------- MEMORY CAP TIMER --------------------
// Prevent unbounded growth of in-memory stores
setInterval(() => {
    capArray(messages, MAX_MESSAGES);
    for (const convId of Object.keys(conversationMessagesStore)) {
        capArray(conversationMessagesStore[convId], MAX_CONVERSATION_MESSAGES);
    }
}, 60 * 1000); // check every minute

app.get('/api/debug/teams-thread-map', (req, res) => {
    res.json({
        success: true,
        teamsThreadMap
    });
});

// -------------------- PERIODIC CLEANUP --------------------
// Clean resolved/rejected moderation items older than 24 hours every 30 minutes
setInterval(() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    let cleaned = 0;
    for (const id of Object.keys(moderationQueue)) {
        const item = moderationQueue[id];
        if (item.status !== 'pending' && new Date(item.timestamp).getTime() < cutoff) {
            delete moderationQueue[id];
            cleaned++;
        }
    }
    if (cleaned > 0) console.log(`🧹 Cleaned ${cleaned} old moderation items`);
}, 30 * 60 * 1000);

// -------------------- GRACEFUL SHUTDOWN --------------------
function gracefulShutdown(signal) {
    console.log(`\n${signal} received. Shutting down gracefully...`);
    server.close(() => {
        console.log('HTTP server closed');
        if (dbPool) {
            dbPool.end().then(() => {
                console.log('MySQL pool closed');
                process.exit(0);
            }).catch(() => process.exit(1));
        } else {
            process.exit(0);
        }
    });
    // Force exit after 10s
    setTimeout(() => process.exit(1), 10000);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// -------------------- START SERVER --------------------

server.listen(PORT, '0.0.0.0', async () => {
    console.log(`🚀 Chat Support System running on http://localhost:${PORT}`);
    console.log(`📡 n8n webhook: ${N8N_WEBHOOK_URL}`);
    initializeN8nConnection();

    // ---- Run pending SQL migrations, then restore data ----
    const dbOk = await db.testConnection();
    if (dbOk) {
        try {
            const migrateModule = require('./db/migrate-lib');
            await migrateModule.runPendingMigrations(dbPool);
        } catch (migErr) {
            console.error('⚠️  Auto-migration skipped:', migErr.message);
        }
    }

    if (dbOk) {
        // Restore tickets
        const ticketRows = await db.loadTickets();
        for (const row of ticketRows) {
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
                updated_at: new Date(row.updated_at).toISOString()
            };
        }
        console.log(`📦 Restored ${ticketRows.length} tickets from MySQL`);

        // Restore moderation queue
        const modRows = await db.loadModerationItems();
        for (const row of modRows) {
            moderationQueue[row.id] = {
                id: row.id,
                conversationId: row.conversation_id,
                sender: row.sender,
                text: row.text,
                originalText: row.original_text,
                teamsMessageId: row.teams_message_id,
                replyToMessageId: row.reply_to_message_id,
                category: row.category,
                ticket_id: row.ticket_id,
                originalMessageId: row.original_message_id,
                messageId: row.message_id,
                timestamp: new Date(row.created_at).toISOString(),
                status: row.status,
                moderation: {
                    method: row.moderation_method,
                    scriptIssues: (() => { try { return row.moderation_issues ? JSON.parse(row.moderation_issues) : []; } catch { return [row.moderation_issues]; } })(),
                    llmReason: row.moderation_reason,
                    refinedText: row.refined_text,
                    originalText: row.original_text
                }
            };
        }
        console.log(`📦 Restored ${modRows.length} moderation items from MySQL`);
    }
});