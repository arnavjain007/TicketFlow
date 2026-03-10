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
// const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'http://localhost:5678/webhook/chat-support';

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Store for messages
let messages = [];
let activeUsers = 0;
let n8nConnected = false;
let messageQueue = [];

// Configure multer for file uploads
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

// Middleware
app.use(express.static('public'));
app.use(express.static('uploads'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API endpoint to get message history
app.get('/api/messages', (req, res) => {
    res.json(messages);
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        activeUsers,
        messageCount: messages.length,
        n8nConnected,
        n8nWebhookUrl: N8N_WEBHOOK_URL,
        queuedMessages: messageQueue.length
    });
});

// File upload endpoint
app.post('/api/upload', upload.single('file'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const fileUrl = `http://localhost:${PORT}/${req.file.filename}`;
        const fileType = req.file.mimetype.startsWith('image') ? 'image' : 'pdf';

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

// REST endpoint to send messages (PDF/image/text) via POST
app.post('/api/messages', async (req, res) => {
    try {
        const { sender, text, file_url, file_type, file_name } = req.body;

        const messageData = {
            type: 'message',
            sender: sender || 'Anonymous',
            timestamp: new Date().toISOString(),
            text: text || '',
            file_url: file_url || null,
            file_type: file_type || null,
            file_name: file_name || null,
            messageId: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
        };

        messages.push(messageData);
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

// Socket.io connection handler
io.on('connection', (socket) => {
    activeUsers++;
    console.log(`User connected. Active users: ${activeUsers}`);

    io.emit('activeUsers', activeUsers);

    socket.on('sendMessage', async (data) => {
        try {
            const messageData = {
                type: 'message',
                sender: data.sender || 'Anonymous',
                timestamp: new Date().toISOString(),
                text: data.text || '',
                file_url: data.file_url || null,
                file_type: data.file_type || null,
                file_name: data.file_name || null,
                messageId: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
            };

            messages.push(messageData);
            io.emit('newMessage', messageData);

            console.log('🔔 Emitted newMessage to clients:', messageData);

            const n8nResult = await sendToN8n(messageData);
            console.log('🌐 n8n webhook result:', n8nResult);

            console.log(`Message received from ${messageData.sender}:`, {
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

// Initialize connection with n8n workflow
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

// Function to send message to n8n webhook in real-time
async function sendToN8n(messageData) {
    try {
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
                text: messageData.text,
                file_url: messageData.file_url,
                file_type: messageData.file_type,
                file_name: messageData.file_name,
                timestamp: messageData.timestamp,
                messageId: messageData.messageId,
                hasFile: !!messageData.file_url
            };

            response = await axios.post(N8N_WEBHOOK_URL, payload, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 10000
            });
        }

        console.log(`📤 Message sent to n8n from ${messageData.sender}: "${messageData.text.substring(0, 50)}${messageData.text.length > 50 ? '...' : ''}"`);
        return response.data;
    } catch (error) {
        console.error('❌ Error sending to n8n:', error.response?.data || error.message);

        if (messageQueue.length < 100) {
            messageQueue.push(messageData);
        }

        n8nConnected = false;
        return null;
    }
}

// Clear messages endpoint
app.delete('/api/messages', (req, res) => {
    messages = [];
    io.emit('messagesCleared');
    res.json({ message: 'Messages cleared' });
});

// n8n status endpoint
app.get('/api/n8n-status', (req, res) => {
    res.json({
        connected: n8nConnected,
        webhookUrl: N8N_WEBHOOK_URL,
        queuedMessages: messageQueue.length,
        totalMessages: messages.length
    });
});

// Manually reconnect to n8n
app.post('/api/reconnect-n8n', async (req, res) => {
    console.log('🔄 Manual reconnection triggered...');
    n8nConnected = false;
    await initializeN8nConnection();

    res.json({
        message: 'Reconnection initiated',
        connected: n8nConnected
    });
});

// GET endpoint for testing responses quickly in browser/curl
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
            category: responseData.category || null
        };

        messages.push(responseMessage);
        io.emit('responseMessage', responseMessage);

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

// POST endpoint for n8n to send responses back to chat
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
            category: responseData.category || null
        };

        messages.push(responseMessage);
        io.emit('responseMessage', responseMessage);

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

// Endpoint for creating support tickets
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

server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Chat Support System running on http://localhost:${PORT}`);
    console.log(`📡 Connecting to n8n workflow: ${N8N_WEBHOOK_URL}\n`);

    initializeN8nConnection();

    setInterval(async () => {
        if (!n8nConnected) {
            console.log('🔄 Attempting to reconnect to n8n...');
            await initializeN8nConnection();
        }
    }, 30000);
});