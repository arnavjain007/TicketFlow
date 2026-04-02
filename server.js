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
    'cookies', 'browser', 'refresh', 'update', 'reset', 'error', 'issue', 'problem',
    'ticket', 'support', 'team', 'account', 'login', 'password', 'page', 'system',
    'server', 'status', 'loan', 'payment', 'repayment', 'bank', 'amount', 'balance',
    'ok', 'okay', 'sure', 'thanks', 'thank', 'sorry', 'hello', 'hi', 'hey',
    'resolve', 'fix', 'working', 'still', 'already', 'pending', 'failed', 'done',
    'correct', 'incorrect', 'wrong', 'right', 'good', 'bad', 'new', 'old'
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
    const words = lower.replace(/[^a-z\\s]/g, '').split(/\\s+/).filter(w => w.length > 0);

    if (words.length > 0) {
        const recognizedCount = words.filter(w => COMMON_WORDS.has(w) || w.length <= 1).length;
        const recognizedRatio = recognizedCount / words.length;

        // If less than 30% of words are recognized AND message is short-ish, flag as gibberish
        if (recognizedRatio < 0.3 && words.length <= 15) {
            issues.push('gibberish or nonsensical text');
        }

        // Also flag if single "word" with no spaces and length > 6 that isn't a known word
        if (words.length === 1 && words[0].length > 6 && !COMMON_WORDS.has(words[0])) {
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

Original message:
"${originalText}"

Your tasks:
1. Determine if the core message contains useful information for the customer (e.g. a resolution, update, instruction, or helpful answer).
2. If useful: rewrite the message to be professional, polite, and helpful. Remove any rude, offensive, or unprofessional language while keeping the useful content intact.
3. If not useful (e.g. just insults, no actual info): mark as not appropriate.

Return ONLY valid JSON:
{
  "appropriate": true/false,
  "refined_text": "rewritten professional message" or null if not appropriate,
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
        await sendToN8n(messageData);

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
                    const normalized = messageData.text.trim().toLowerCase();
                    const isPositive = /^(yes|yeah|yep|yup|ya|yaa+|resolved|done|fixed|it('?s)?\s*(working|fixed|resolved|good)|all\s*(good|set)|that\s*(works|worked|helped|fixed)|no\s*more\s*issues?|looks?\s*good)\s*[.!]*$/i.test(normalized);

                    if (isPositive) {
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

                    // User said no or described further issue → forward to Teams as follow-up
                    activeTicket.latest_user_message = messageData.text;
                    activeTicket.updated_at = new Date().toISOString();
                    if (!activeTicket.followups) activeTicket.followups = [];
                    activeTicket.followups.push({ message: messageData.text, created_at: new Date().toISOString() });
                    if (activeTicket.followups.length > 20) activeTicket.followups = activeTicket.followups.slice(-20);
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
                // Record the message but don't spam Teams again.
                activeTicket.latest_user_message = messageData.text;
                activeTicket.updated_at = new Date().toISOString();
                if (!activeTicket.followups) activeTicket.followups = [];
                activeTicket.followups.push({ message: messageData.text, created_at: new Date().toISOString() });
                if (activeTicket.followups.length > 20) activeTicket.followups = activeTicket.followups.slice(-20);
                db.saveTicket(activeTicket);

                const waitText = "Your follow-up has already been shared with the support team. They'll get back to you shortly.";
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

            // No active ticket — proceed with normal n8n flow
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

    // ---- Restore data from MySQL on startup ----
    const dbOk = await db.testConnection();
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