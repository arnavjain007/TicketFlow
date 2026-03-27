const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const FormData = require('form-data');
const pdfParse = require('pdf-parse');
const Tesseract = require('tesseract.js');
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
    process.env.N8N_WEBHOOK_URL || 'http://127.0.0.1:5678/webhook-test/chat-support';

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
const conversationsStore = {};
const conversationMessagesStore = {};
const ticketsStore = {};
const teamsThreadMap = {};

const processedTeamsReplies = new Map();
let sendResponseHitCount = 0;

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

function applyEscalation(ticket, escalatedAt = null) {
    if (!ticket || ticket.status === 'resolved') return ticket;

    const currentLevel = ticket.escalation_level || 0;
    if (currentLevel >= 2) return ticket;

    const nextLevel = currentLevel + 1;
    ticket.escalation_level = nextLevel;
    ticket.status = 'escalated';
    ticket.escalated_at = escalatedAt || new Date().toISOString();
    ticket.updated_at = new Date().toISOString();

    if (nextLevel === 1) {
        ticket.assigned_to = 'dev';
    } else if (nextLevel === 2) {
        ticket.assigned_to = 'manager';
    }

    return ticket;
}

function escalateOldTickets(minutes = 2) {
    const now = Date.now();

    console.log('Running escalation check...');

    Object.values(ticketsStore).forEach(ticket => {
        if (ticket.status === 'resolved') return;
        if ((ticket.escalation_level || 0) >= 2) return;

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
            applyEscalation(ticket);
            console.log(
                `🚨 Re-escalated: ${ticket.id}, level: ${ticket.escalation_level}, assigned_to: ${ticket.assigned_to}`
            );
        }
    });
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
        const payload = {
            sender: messageData.sender,
            conversationId: messageData.conversationId || messageData.sender || 'Guest',
            text: messageData.text,
            file_url: messageData.file_url,
            file_type: messageData.file_type,
            file_name: messageData.file_name,
            timestamp: messageData.timestamp,
            messageId: messageData.messageId,
            hasFile: !!messageData.file_url
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

        res.json({
            success: true,
            conversationId: key,
            messages: recentMessages
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
        }

        if (chatMemoryStore[key].length > 50) {
            chatMemoryStore[key] = chatMemoryStore[key].slice(-50);
        }

        res.json({
            success: true,
            conversationId: key,
            totalMessages: chatMemoryStore[key].length
        });
    } catch (error) {
        console.error('❌ Error saving chat memory:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/chat-memory/:conversationId', (req, res) => {
    try {
        const { conversationId } = req.params;
        res.json({
            success: true,
            conversationId,
            messages: chatMemoryStore[conversationId] || []
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

app.post('/api/send-response', (req, res) => {
    try {
        sendResponseHitCount++;

        const responseData = req.body || {};

        // Accept multiple possible field names safely
        const messageText =
            responseData.replyText ||
            responseData.response ||
            responseData.message ||
            null;

        const teamsMessageId = responseData.teamsMessageId || null;
        const replyToMessageId = responseData.replyToMessageId || null;
        const conversationId = responseData.conversationId || null;
        const sender = responseData.sender || responseData.source || 'AI Assistant';

        // Use the actual reply message id for dedupe.
        // Do NOT use replyToMessageId as primary dedupe key because all replies in the same thread
        // can share the same parent id.
        const dedupeKey = teamsMessageId
            ? `${conversationId || 'no-conv'}::${teamsMessageId}`
            : `${conversationId || 'no-conv'}::${messageText || 'no-message'}::${replyToMessageId || 'no-parent'}`;

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
        const ticket = {
            id: `ticket_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
            title: ticketData.ticket_title,
            description: ticketData.ticket_description,
            priority: ticketData.priority || 'Medium',
            status: ticketData.status || 'open',
            assigned_to: ticketData.assigned_to || 'support_team',
            created_at: now,
            updated_at: now,
            last_response_at: null,
            escalated_at: null,
            escalation_level: 0,
            category: ticketData.category || null,
            conversationId:
                ticketData.conversationId ||
                ticketData.created_from_conversation ||
                null
        };
        ticketsStore[ticket.id] = ticket;

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
        ticket.status = 'existing_ticket_followup';
        ticket.updated_at = new Date().toISOString();
        ticket.last_response_at = new Date().toISOString();

        if (assigned_to) ticket.assigned_to = assigned_to;
        if (assigned_to_name) ticket.assigned_to_name = assigned_to_name;

        if (!ticket.followups) ticket.followups = [];
        ticket.followups.push({
            message: latest_user_message || '',
            created_at: new Date().toISOString()
        });

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
    escalateOldTickets(2);
}, 10000);

// -------------------- START SERVER --------------------

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Chat Support System running on http://localhost:${PORT}`);
    console.log(`📡 n8n webhook: ${N8N_WEBHOOK_URL}`);
    initializeN8nConnection();
});

app.get('/api/debug/teams-thread-map', (req, res) => {
    res.json({
        success: true,
        teamsThreadMap
    });
});