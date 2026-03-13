const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const FormData = require('form-data');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 8000;
const N8N_WEBHOOK_URL =
    process.env.N8N_WEBHOOK_URL || 'http://[::1]:5678/webhook-test/chat-support';

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Global message log
let messages = [];
let activeUsers = 0;
let n8nConnected = false;
let messageQueue = [];

// In-memory conversation memory store for POC
// key = conversationId
const chatMemoryStore = {};

// Conversation-based storage
// conversationsStore: { userId: [ { conversation_id, title, ... } ] }
const conversationsStore = {};
// conversationMessagesStore: { conversation_id: [ { ...message fields... } ] }
const conversationMessagesStore = {};

// -------------------- HELPERS --------------------

function createConversation(userId, title = 'New Chat', preview = '') {
    const conversation_id = `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const now = new Date().toISOString();

    const convo = {
        conversation_id,
        user_id: userId,
        title,
        last_message_preview: preview,
        created_at: now,
        updated_at: now
    };

    if (!conversationsStore[userId]) conversationsStore[userId] = [];
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

// -------------------- MULTER --------------------

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        const uniqueName = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}_${file.originalname}`;
        cb(null, uniqueName);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedMimes = ['image/jpeg', 'image/png', 'image/gif', 'application/pdf'];
        if (allowedMimes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Only images and PDFs are allowed'));
        }
    }
});

// -------------------- MIDDLEWARE --------------------

app.use(express.static('public'));
app.use(express.static('uploads'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// -------------------- ROUTES --------------------

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
        totalConversations: Object.values(conversationsStore).reduce((acc, arr) => acc + arr.length, 0)
    });
});

// -------------------- FILE UPLOAD --------------------

app.post('/api/upload', upload.single('file'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const fileUrl = `http://localhost:${PORT}/${req.file.filename}`;
        const fileType = req.file.mimetype;

        console.log(`📁 File uploaded: ${req.file.originalname} -> ${fileUrl}`);

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
            messageId: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
        };

        messages.push(messageData);

        if (!conversationMessagesStore[finalConversationId]) {
            conversationMessagesStore[finalConversationId] = [];
        }

        conversationMessagesStore[finalConversationId].push({
            role: 'user',
            message_text: messageData.text,
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
    console.log(`User connected. Active users: ${activeUsers}`);
    io.emit('activeUsers', activeUsers);

    socket.on('sendMessage', async (data) => {
        try {
            console.log('🟢 Received sendMessage event:', data);

            const messageData = {
                type: 'message',
                sender: data.sender || 'Anonymous',
                conversationId: data.conversationId || data.sender || socket.id,
                timestamp: new Date().toISOString(),
                text: data.text || '',
                file_url: data.file_url || null,
                file_type: data.file_type || null,
                file_name: data.file_name || null,
                messageId: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
            };

            messages.push(messageData);

            if (!conversationMessagesStore[messageData.conversationId]) {
                conversationMessagesStore[messageData.conversationId] = [];
            }

            conversationMessagesStore[messageData.conversationId].push({
                role: 'user',
                message_text: messageData.text,
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
            console.log('🔔 Emitted newMessage to clients:', messageData);

            console.log('🟡 Calling sendToN8n with:', messageData);
            const n8nResult = await sendToN8n(messageData);
            console.log('🌐 n8n webhook result:', n8nResult);

            console.log(`Message received from ${messageData.sender}:`, {
                conversationId: messageData.conversationId,
                text: messageData.text.substring(0, 50),
                hasFile: !!messageData.file_url,
                fileType: messageData.file_type,
                fileUrl: messageData.file_url
            });
        } catch (error) {
            console.error('❌ Error sending message:', error.message);
            socket.emit('error', { message: 'Failed to send message' });
        }
    });
    socket.on('joinConversation', (conversationId) => {
        if (!conversationId) return;
        socket.join(conversationId);
        console.log(`Socket ${socket.id} joined conversation ${conversationId}`);
    });
    socket.on('switchConversation', ({ oldConversationId, newConversationId }) => {
        if (oldConversationId) socket.leave(oldConversationId);
        if (newConversationId) socket.join(newConversationId);
        console.log(`Socket ${socket.id} switched from ${oldConversationId} to ${newConversationId}`);
    });
    socket.on('typing', (data) => {
        socket.broadcast.emit('userTyping', {
            sender: data.sender,
            isTyping: data.isTyping
        });
    });

    socket.on('disconnect', () => {
        activeUsers--;
        console.log(`User disconnected. Active users: ${activeUsers}`);
        io.emit('activeUsers', activeUsers);
    });
});

// -------------------- N8N CONNECTION --------------------

async function initializeN8nConnection() {
    try {
        console.log('✅ Connected to n8n workflow');
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
        console.log('🟡 sendToN8n called:', messageData);

        let response;

        if (messageData.file_url && messageData.file_type && messageData.file_type.startsWith('image')) {
            const fileName = path.basename(messageData.file_url);
            const filePath = path.join(uploadsDir, fileName);

            if (!fs.existsSync(filePath)) {
                console.error('❌ Image file not found:', filePath);
                throw new Error('Image file not found');
            }

            const form = new FormData();
            form.append('sender', messageData.sender);
            form.append('conversationId', messageData.conversationId || messageData.sender || 'Guest');
            form.append('text', messageData.text);
            form.append('timestamp', messageData.timestamp);
            form.append('messageId', messageData.messageId);
            form.append('file_type', messageData.file_type);
            form.append('file_name', messageData.file_name);
            form.append('hasFile', 'true');
            form.append('image', fs.createReadStream(filePath), {
                filename: messageData.file_name || 'uploaded_image',
                contentType: messageData.file_type
            });

            response = await axios.post(N8N_WEBHOOK_URL, form, {
                headers: form.getHeaders(),
                timeout: 10000
            });
        } else {
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

            console.log('🟡 sendToN8n POST payload:', payload);

            response = await axios.post(N8N_WEBHOOK_URL, payload, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 10000
            });
        }

        console.log(`📤 Message sent to n8n from ${messageData.sender}: "${messageData.text.substring(0, 50)}${messageData.text.length > 50 ? '...' : ''}"`);
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
    console.log('🔄 Manual reconnection triggered...');
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
            intent = null,
            matched_issue = null,
            issue_summary = null,
            ticket_id = null,
            messageId = null
        } = req.body;

        const key = conversationId || sessionId;

        if (!key) {
            return res.status(400).json({ error: 'conversationId or sessionId is required' });
        }

        if (!chatMemoryStore[key]) {
            chatMemoryStore[key] = [];
        }

        if (user_message) {
            chatMemoryStore[key].push({
                role: 'user',
                message_text: user_message,
                intent,
                matched_issue,
                issue_summary,
                ticket_id,
                messageId,
                created_at: new Date().toISOString()
            });
        }

        if (assistant_message) {
            chatMemoryStore[key].push({
                role: 'assistant',
                message_text: assistant_message,
                intent,
                matched_issue,
                issue_summary,
                ticket_id,
                messageId,
                created_at: new Date().toISOString()
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

// -------------------- RESPONSE ROUTES --------------------

app.get('/api/send-response', (req, res) => {
    try {
        const responseData = req.query;
        const messageText = responseData.response || responseData.message;

        if (!messageText) {
            return res.status(400).json({ error: 'Missing response or message query param' });
        }

        const responseMessage = {
            type: 'response',
            sender: responseData.sender || responseData.source || 'AI Assistant',
            timestamp: new Date().toISOString(),
            text: messageText,
            messageId: responseData.messageId || `resp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            originalMessageId: responseData.originalMessageId || null,
            category: responseData.category || null,
            conversationId: responseData.conversationId || null
        };

        messages.push(responseMessage);
        if (responseMessage.conversationId) {
            io.to(responseMessage.conversationId).emit('responseMessage', responseMessage);
        }

        console.log(`📥 GET response received: "${messageText.substring(0, 50)}${messageText.length > 50 ? '...' : ''}"`);

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
        const responseData = req.body;
        const messageText = responseData.response || responseData.message;

        if (!messageText) {
            return res.status(400).json({ error: 'Missing response or message field' });
        }

        const responseMessage = {
            type: 'response',
            sender: responseData.sender || responseData.source || 'AI Assistant',
            timestamp: new Date().toISOString(),
            text: messageText,
            messageId: responseData.messageId || `resp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            originalMessageId: responseData.originalMessageId || null,
            category: responseData.category || null,
            conversationId: responseData.conversationId || null
        };

        messages.push(responseMessage);

        if (responseMessage.conversationId) {
            if (!conversationMessagesStore[responseMessage.conversationId]) {
                conversationMessagesStore[responseMessage.conversationId] = [];
            }

            conversationMessagesStore[responseMessage.conversationId].push({
                role: 'assistant',
                message_text: messageText,
                matched_issue: responseData.category || null,
                ticket_id: responseData.ticket_id || null,
                messageId: responseMessage.messageId,
                created_at: responseMessage.timestamp
            });

            updateConversation(responseMessage.conversationId, {
                preview: messageText
            });
        }

        if (responseMessage.conversationId) {
            io.to(responseMessage.conversationId).emit('responseMessage', responseMessage);
        }

        console.log(`📥 POST response received from n8n: "${messageText.substring(0, 50)}${messageText.length > 50 ? '...' : ''}"`);

        res.json({
            success: true,
            messageId: responseMessage.messageId,
            data: responseMessage
        });
    } catch (error) {
        console.error('❌ Error processing POST response:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// -------------------- TICKET ROUTE --------------------

app.post('/api/tickets', (req, res) => {
    try {
        const ticketData = req.body;

        if (!ticketData.ticket_title || !ticketData.ticket_description) {
            return res.status(400).json({ error: 'Missing ticket_title or ticket_description' });
        }

        const ticket = {
            id: `ticket_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            title: ticketData.ticket_title,
            description: ticketData.ticket_description,
            priority: ticketData.priority || 'Medium',
            status: ticketData.status || 'open',
            assigned_to: ticketData.assigned_to || 'support_team',
            created_at: new Date().toISOString(),
            category: ticketData.category || null
        };

        console.log('🎫 New support ticket created:', {
            id: ticket.id,
            title: ticket.title,
            priority: ticket.priority,
            assigned_to: ticket.assigned_to
        });

        res.json({
            success: true,
            ticket_id: ticket.id,
            message: 'Ticket created successfully'
        });
    } catch (error) {
        console.error('❌ Error creating ticket:', error.message);
        res.status(500).json({ error: 'Internal server error' });
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
            messageId: messageId || `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
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

// -------------------- START SERVER --------------------

server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Chat Support System running on http://localhost:${PORT}`);
    console.log(`📡 Connecting to n8n workflow: ${N8N_WEBHOOK_URL}\n`);

    initializeN8nConnection();
});