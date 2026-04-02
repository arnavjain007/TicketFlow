# Chat Support System

An AI-powered chat support system built with Node.js, Socket.io, and n8n. Users chat through a web UI, messages are processed by an n8n workflow that classifies intents, matches issues against a knowledge base, handles attachments (PDF/image OCR), creates support tickets, and optionally escalates to Microsoft Teams.

## Features

- **Real-time chat** via Socket.io with a clean web UI
- **n8n workflow integration** — message classification, KB matching, ticket creation, and response generation all happen inside n8n
- **Knowledge base** with 45 pre-defined issues across lending, KYC, onboarding, collections, etc.
- **Attachment support** — upload PDFs or images; the server extracts text (pdf-parse / Tesseract OCR) and forwards it to the workflow
- **Conversation memory** — per-session history stored in MySQL so the AI can recall earlier messages
- **Automatic intent detection** — greetings, error codes, follow-ups, issue recall, support requests
- **Support ticket system** — tickets are created, tracked, and can be escalated
- **Microsoft Teams integration** — tickets can be posted to a Teams channel via webhook; agent replies flow back to the chat
- **Moderation queue** — AI responses can be held for human review before delivery
- **Chat summary engine** — long conversations are summarised so context stays compact

## Project Structure

```
server.js            — Express + Socket.io backend (all API routes)
public/
  index.html         — Chat UI
  moderation.html    — Moderation dashboard
kb_issues.js         — Knowledge base entries (also embedded in the n8n workflow)
n8n-workflow.json    — Exportable n8n workflow definition
ticket-escalation-workflow.json — n8n escalation sub-workflow
uploads/             — User-uploaded files (images, PDFs)
.env                 — Environment variables (not committed)
package.json         — Dependencies and scripts
```

## Prerequisites

- **Node.js** v18+
- **MySQL** 8.x
- **n8n** (runs in Docker)
- **Docker** & Docker Compose
- (Optional) **ngrok** if you need a public URL for n8n webhooks
- **Power Automate Premium** 

## Setup

### 1. Clone the repo

```bash
git clone https://github.com/arnavja830-prog/chat-support-system.git
cd chat-support-system
```

### 2. Install dependencies

```bash
npm install
```

### 3. Create the `.env` file

Copy the example below and fill in your values:

```env
# Server
PORT=8000
DEBUG=true

# Gemini API (used by n8n for LLM calls)
GEMINI_API_KEY=your-gemini-api-key

# n8n webhook URL
N8N_WEBHOOK_URL=http://localhost:5678/webhook/chat-support

# MySQL
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=your-password
MYSQL_DATABASE=chatsupport

# Microsoft Teams (optional)
TEAMS_WEBHOOK_URL=https://your-teams-webhook-url

# Microsoft Graph — Teams channel integration (optional)
GRAPH_TENANT_ID=your-tenant-id
GRAPH_CLIENT_ID=your-client-id
GRAPH_CLIENT_SECRET=your-client-secret
GRAPH_NOTIFICATION_URL=https://your-public-url/api/teams/graph-webhook
GRAPH_TEAMS_TEAM_ID=your-team-id
GRAPH_TEAMS_CHANNEL_ID=your-channel-id
GRAPH_SUBSCRIPTION_RENEW_MINUTES=50

# Escalation
ESCALATION_DAYS=4
```

### 4. Set up MySQL

Create the database:

```sql
CREATE DATABASE IF NOT EXISTS chatsupport;
```

The server auto-creates the required tables on first start (`chat_memory`, `tickets`, etc.).

### 5. Start n8n (Docker)

```bash
cd /path/to/n8n
docker compose up -d
```

A sample `docker-compose.yml`:

```yaml
services:
  n8n:
    image: docker.n8n.io/n8nio/n8n
    restart: always
    ports:
      - "5678:5678"
    environment:
      - N8N_HOST=localhost
      - N8N_PORT=5678
      - N8N_PROTOCOL=http
      - NODE_ENV=production
      # Set this if you need external webhook access (e.g. via ngrok):
      # - WEBHOOK_URL=https://your-ngrok-url/
    volumes:
      - ./n8n_data:/home/node/.n8n
```

Then import the workflow:

1. Open n8n at `http://localhost:5678`
2. Go to **Workflows → Import from File**
3. Import `n8n-workflow.json`
4. Activate the workflow

### 6. Start the server

```bash
npm start
```

For development with auto-reload:

```bash
npm run dev
```

Open the chat at **http://localhost:8000**.

## How It Works

```
  User (browser)
       │
       ▼
  Chat UI (public/index.html)
       │  Socket.io
       ▼
  Express Server (:8000)
       │  HTTP POST
       ▼
  n8n Webhook (:5678)
       │
       ▼
  n8n Workflow
   ├─ Regex pre-classify (greetings, error codes, follow-ups)
   ├─ LLM intent classification (Gemini)
   ├─ KB issue matching (45 entries)
   ├─ Attachment text extraction (PDF / OCR)
   ├─ Ticket creation & escalation logic
   └─ Response generation
       │
       ▼
  POST /api/send-response → back to chat UI via Socket.io
```

1. User sends a message (with optional file attachment)
2. Server forwards it to the n8n webhook along with conversation history
3. n8n classifies the intent, matches it against the knowledge base, and generates a response
4. n8n sends the response back to the server's `/api/send-response` endpoint
5. Server delivers it to the user in real-time via Socket.io
6. If a support ticket is needed, n8n creates one and optionally posts to Teams

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Chat UI |
| GET | `/health` | Health check |
| GET | `/api/messages` | Get message history |
| POST | `/api/messages` | Send a message (REST) |
| DELETE | `/api/messages` | Clear messages |
| POST | `/api/upload` | Upload a file |
| POST | `/api/extract-attachment-text` | Extract text from PDF/image |
| POST | `/api/send-response` | Receive AI response (called by n8n) |
| GET | `/api/n8n-status` | Check n8n connection |
| POST | `/api/reconnect-n8n` | Reconnect to n8n |
| POST | `/api/chat-memory/get` | Get conversation memory |
| POST | `/api/chat-memory/save-turn` | Save a conversation turn |
| GET | `/api/chat-memory/:id` | Get memory for a conversation |
| POST | `/api/tickets` | Create a ticket |
| GET | `/api/tickets` | List all tickets |
| PATCH | `/api/tickets/:id` | Update a ticket |
| PATCH | `/api/tickets/:id/escalate` | Escalate a ticket |
| DELETE | `/api/tickets/:id` | Delete a ticket |
| GET | `/api/moderation/queue` | Get pending moderation items |
| POST | `/api/moderation/approve/:id` | Approve a moderated response |
| POST | `/api/moderation/reject/:id` | Reject a moderated response |

## Technologies

- **Node.js / Express** — backend server
- **Socket.io** — real-time messaging
- **n8n** — workflow automation (intent detection, KB matching, response generation)
- **MySQL** — conversation memory and ticket storage
- **Tesseract.js** — OCR for image attachments
- **pdf-parse** — PDF text extraction
- **Axios** — HTTP client
- **Multer** — file upload handling

## License

ISC
