# Chat Support System

A real-time chat support system with n8n integration that triggers events when messages are sent.

## Features

✅ **Real-time Chat**: Socket.io based real-time messaging  
✅ **Multiple Message Types**: Support for text messages, images, or both  
✅ **n8n Integration**: Automatically sends message events to your n8n webhook  
✅ **User Tracking**: See how many users are online  
✅ **Message History**: Maintains chat history during session  
✅ **Responsive UI**: Works on desktop and mobile devices  

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure (Optional)

Edit `.env` file to customize:
- `PORT` (default: 8000)
- `N8N_WEBHOOK_URL` (already configured with your webhook)

### 3. Start the Server

```bash
npm start
```

The chat app will be available at: **http://localhost:8000**

## How It Works

### Message Flow

1. **User sends a message** (text, image, or both) in the chat UI
2. **Socket.io delivers** the message to all connected clients in real-time
3. **Message stored** in server memory for history
4. **Event triggered** to n8n webhook automatically
5. **n8n workflow** can then process the message (store in DB, send notifications, etc.)

### Webhook Payload

When a message is sent, the following data is sent to your n8n webhook:

```json
{
  "sender": "User Name",
  "text": "Message content",
  "image": "base64 encoded image or null",
  "timestamp": "2024-03-06T10:30:45.123Z",
  "messageId": "msg_unique_id"
}
```

### Message Types

- **Text Only**: Send a message without an image
- **Image Only**: Upload an image without text
- **Text + Image**: Send both message and image together

## Usage

### In the Chat Interface

1. Enter your name in the "Your name..." field
2. Type a message in the text box
3. (Optional) Click 📎 to attach an image
4. Click 📤 to send or press Enter
5. Use Shift+Enter for new lines

### API Endpoints

- `GET /` - Chat UI
- `GET /health` - Server health check
- `GET /api/messages` - Get all messages history
- `DELETE /api/messages` - Clear message history

## n8n Workflow Integration

In your n8n workflow:

1. Add a **Webhook** trigger
2. Set it to accept the MCP protocol messages
3. Add nodes to handle the incoming message data
4. Examples:
   - Save to database
   - Send email notification
   - Create support ticket
   - Run AI analysis on message

## Development

For development with hot reload:

```bash
npm run dev
```

This requires `nodemon` to be installed (already in devDependencies).

## Architecture

```
Socket.io Client (Browser)
        ↓
  Express Server (Port 8000)
        ↓
   N8N Webhook
        ↓
   N8N Workflow
```

## Troubleshooting

### Messages not appearing in chat?
- Check if server is running: `curl http://localhost:8000/health`
- Check browser console for errors (F12)

### Not sending to n8n?
- Verify webhook URL in `.env` matches your n8n setup
- Check n8n workflow is in test mode and "Execute workflow" button was clicked
- Check server logs for connection errors

### Images not uploading?
- Check file size (max 50MB)
- Ensure file is a valid image format
- Check browser console for errors

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 8000 | Server port |
| N8N_WEBHOOK_URL | http://localhost:5678/webhook-test/c455f220-a6ac-4e60-b914-ad267d192c19 | n8n webhook endpoint |
| DEBUG | false | Enable debug logging |

## Technologies Used

- **Express.js** - Web server framework
- **Socket.io** - Real-time communication
- **Axios** - HTTP client for webhook requests
- **HTML5/CSS3/JavaScript** - Frontend UI

## License

ISC

## Support

For issues or questions about the n8n integration, ensure your workflow is properly configured and the webhook endpoint is accessible.
