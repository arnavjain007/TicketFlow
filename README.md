# Chat Support System

An AI-powered chat support system built with Node.js, Socket.io, and n8n. Users chat through a web UI, messages are processed by an n8n workflow that classifies intents, matches issues against a knowledge base, handles attachments (PDF/image OCR), creates support tickets, and optionally escalates to Microsoft Teams. Includes intelligent local message handling, multi-layer moderation, escalation gating, and context-aware conversation management.

## Features

- **Real-time chat** via Socket.io with a clean web UI
- **n8n workflow integration** — message classification, KB matching, ticket creation, and response generation all happen inside n8n
- **Knowledge base** with 45 pre-defined issues across lending, KYC, onboarding, collections, etc.
- **Local intent pre-classifier** — handles greetings, goodbyes, bot capability questions, off-topic messages, and more without touching the LLM
- **Escalation gate** — requires at least 2 bot resolution attempts before allowing ticket creation (prevents immediate escalation)
- **Context-aware clarification** — when users ask about the bot's own responses ("wdym by 2 minutes"), uses conversation history + LLM to answer intelligently
- **Post-ticket conversation handling** — after ticket creation, correctly handles status inquiries, casual chat, off-topic messages, and clarification requests instead of giving generic responses
- **Attachment support** — upload PDFs or images; the server extracts text (pdf-parse / Tesseract OCR) and forwards it to the workflow
- **Conversation memory** — per-session history stored in MySQL so the AI can recall earlier messages
- **Automatic intent detection** — greetings, error codes, follow-ups, issue recall, support requests, frustration detection
- **Support ticket system** — tickets are created, tracked, and can be escalated
- **Microsoft Teams integration** — tickets posted to Teams via Power Automate webhook; agent replies flow back into the chat
- **Moderation queue** — agent replies go through script-based + LLM moderation before delivery (third-person relay tone)
- **Stale thread filtering** — only replies from the latest active ticket thread are accepted
- **Chat summary engine** — long conversations are summarised so context stays compact
- **Frustration detection** — scores user frustration and auto-escalates high-frustration conversations

## Project Structure

```
server.js            — Express + Socket.io backend (all API routes, local classifiers, moderation)
public/
  index.html         — Chat UI
  moderation.html    — Moderation dashboard
db/
  migrate.js         — CLI migration runner (up / down / status / redo / create)
  migrate-lib.js     — Shared migration helpers (also used by server.js on startup)
  migrations/
    001_initial_schema.sql — Creates moderation_log, tickets, chat_messages tables
kb_issues.js         — Knowledge base entries (also embedded in the n8n workflow)
n8n-workflow.json    — Exportable n8n workflow definition
ticket-escalation-workflow.json — n8n escalation sub-workflow
mcp.json             — MCP server configuration for n8n
uploads/             — User-uploaded files (images, PDFs)
eng.traineddata      — Tesseract OCR language data
.env                 — Environment variables (not committed)
package.json         — Dependencies and scripts
```

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| **Node.js** | v18+ | Runtime for the server |
| **MySQL** | 8.x | Conversation memory, tickets, moderation logs |
| **n8n** | Latest | Runs in Docker; handles LLM workflow |
| **Docker** & Docker Compose | Latest | For running n8n |
| **Gemini API Key** | — | Google AI Studio → create API key |
| (Optional) **ngrok** | — | If you need a public URL for n8n webhooks |
| (Optional) **Power Automate** | — | For Teams integration |

## Setup

### 1. Clone the repo

```bash
git clone https://github.com/arnavja830-prog/chat-support-system.git
cd chat-support-system
```

### 2. Set Node version

The project requires **Node.js v20+**. An `.nvmrc` file is included:

```bash
nvm use          # reads .nvmrc → switches to Node 20
```

If you don't have Node 20 installed yet: `nvm install 20`.

### 3. Install dependencies

```bash
npm install
```

This installs: `express`, `socket.io`, `axios`, `mysql2`, `multer`, `pdf-parse`, `tesseract.js`, `dotenv`.

### 5. Get a Gemini API Key

1. Go to [Google AI Studio](https://aistudio.google.com/app/apikey)
2. Click **Create API Key**
3. Copy the key — you'll use it in both `.env` and n8n

### 6. Create the `.env` file

Create a `.env` file in the project root:

```env
# Server
PORT=8000

# Gemini API (used for moderation + ticket intent classification)
GEMINI_API_KEY=your-gemini-api-key-here

# n8n webhook URL (update after importing the workflow)
N8N_WEBHOOK_URL=http://localhost:5678/webhook/chat-support

# MySQL
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=your-mysql-password
MYSQL_DATABASE=chatsupport

# Microsoft Teams webhook (optional — for ticket notifications)
TEAMS_WEBHOOK_URL=https://your-power-automate-webhook-url
```

### 7. Set up MySQL

```bash
# Connect to MySQL
mysql -u root -p

# Create the database
CREATE DATABASE IF NOT EXISTS chatsupport;
EXIT;
```

Run the migrations to create all required tables:

```bash
npm run migrate            # apply all pending migrations
npm run migrate:status     # verify everything is applied  ✅
```

> **Tip:** Migrations also run automatically every time the server starts, so tables are always up to date.

#### Migration commands reference

| Command | Action |
|---------|--------|
| `npm run migrate` | Apply all pending migrations |
| `npm run migrate:down` | Roll back the **last** applied migration |
| `npm run migrate:status` | Show applied / pending status |
| `npm run migrate:redo` | Roll back + re-apply the last migration |
| `npm run migrate:create -- <name>` | Scaffold a new migration file |

To add a schema change, create a new migration file:

```bash
npm run migrate:create -- add_user_preferences
# → creates db/migrations/002_add_user_preferences.sql
# Edit the file, write your SQL, then run: npm run migrate
```

### 8. Start n8n (Docker)

Create a `docker-compose.yml` for n8n (or use an existing one):

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
      # Uncomment and set if using ngrok for external webhook access:
      # - WEBHOOK_URL=https://your-ngrok-url/
    volumes:
      - ./n8n_data:/home/node/.n8n
```

Start n8n:

```bash
docker compose up -d
```

### 9. Import the n8n workflow

1. Open n8n at **http://localhost:5678**
2. Go to **Workflows → Import from File**
3. Import `n8n-workflow.json`
4. **Configure the Gemini credential** in n8n:
   - Go to **Credentials → Add Credential → Google Gemini**
   - Paste your Gemini API key
   - Save
5. Open the imported workflow and assign the Gemini credential to these nodes:
   - **Intent Classifier** (Gemini chat node)
   - **Issue Matcher** (Gemini chat node)
   - Any other Gemini-powered nodes
6. **Update the server URL** in all HTTP Request nodes if your server isn't at `http://172.17.0.1:8000`:
   - Search for `172.17.0.1:8000` in the workflow JSON and replace with your server's address
   - If n8n runs on the same machine as the server: use `http://host.docker.internal:8000` (Mac/Windows) or `http://172.17.0.1:8000` (Linux Docker)
7. **Activate** the workflow (toggle in top-right)
8. Copy the webhook URL from the **Webhook** trigger node and update `N8N_WEBHOOK_URL` in your `.env`

### 10. (Optional) Set up Teams integration

If you want ticket notifications in Microsoft Teams:

1. Create a **Power Automate** flow with an HTTP trigger that posts messages to a Teams channel
2. Copy the Power Automate HTTP POST URL
3. Set it as `TEAMS_WEBHOOK_URL` in `.env`
4. Also update the Power Automate URLs in these n8n nodes:
   - **Send New Ticket To Teams**
   - **Send Escalation To Teams**
   - **Send Frustration To Teams**

For agent replies to flow back to the chat:
1. Set up a Power Automate flow that watches for replies in the Teams channel
2. Configure it to POST replies to `http://your-server:8000/api/send-response` with the conversation ID

### 11. Start the server

```bash
# Production
npm start

# Development (auto-reload with nodemon)
npm run dev
```

Open the chat at **http://localhost:8000**

### 12. Verify everything works

1. **Chat UI** — open http://localhost:8000, send "hello" → should get a greeting response
2. **n8n connection** — check http://localhost:8000/health or send a support issue like "my payment failed"
3. **Moderation dashboard** — open http://localhost:8000/moderation.html (for reviewing agent replies from Teams)

## How It Works

```
  User (browser)
       │
       ▼
  Chat UI (public/index.html)
       │  Socket.io
       ▼
  Express Server (:8000)
       │
       ├─ Local Pre-Classifier (no LLM)
       │   ├─ Greetings, goodbyes, thanks, acknowledgments
       │   ├─ Bot capability questions
       │   ├─ Off-topic / no-issue messages
       │   └─ Escalation gate (min 2 bot attempts)
       │
       ├─ Active Ticket Handler (if ticket exists)
       │   ├─ Clarification requests → LLM with conversation context
       │   ├─ Status inquiries → ticket age + specific info
       │   ├─ Casual chat → friendly response + ticket reminder
       │   ├─ Resolution confirmation flow
       │   └─ Substantive follow-ups → forwarded to support team
       │
       ├─ HTTP POST to n8n (for everything else)
       │       │
       │       ▼
       │   n8n Workflow (:5678)
       │    ├─ Regex pre-classify (greetings, error codes, follow-ups)
       │    ├─ LLM intent classification (Gemini)
       │    ├─ KB issue matching (45 entries)
       │    ├─ Attachment text extraction (PDF / OCR)
       │    ├─ Ticket creation & escalation logic
       │    ├─ Frustration detection & auto-escalation
       │    └─ Response generation
       │       │
       │       ▼
       │   POST /api/send-response
       │
       └─ Agent Reply Handler (from Teams)
            ├─ Stale thread filter
            ├─ Script moderation (vocabulary check)
            ├─ LLM moderation (third-person tone)
            └─ Delivery to user via Socket.io
```

## Message Processing Pipeline

1. **User sends message** (text and/or file attachment)
2. **Local pre-classifier** checks if it's a non-support message (greeting, off-topic, etc.) — handles instantly without LLM
3. **Escalation gate** checks if user is trying to create a ticket before the bot has tried to help (requires 2 bot resolution attempts)
4. **Active ticket handler** intercepts if there's an open ticket — handles clarification, status, casual chat, and follow-ups appropriately
5. **n8n workflow** processes everything else — intent classification, KB matching, ticket creation
6. **Response delivery** — back to the chat via Socket.io
7. **Agent replies** (from Teams) go through moderation before reaching the user

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
| POST | `/api/send-response` | Receive AI/agent response (called by n8n or Teams) |
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
| POST | `/api/tickets/escalation-due` | Check for escalation-due tickets |
| POST | `/api/teams/register-thread` | Register a Teams thread mapping |
| POST | `/api/teams/resolve-conversation` | Resolve a Teams conversation |
| GET | `/api/moderation/queue` | Get pending moderation items |
| GET | `/api/moderation/all` | Get all moderation items |
| POST | `/api/moderation/approve/:id` | Approve a moderated response |
| POST | `/api/moderation/reject/:id` | Reject a moderated response |

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `8000` | Server port |
| `GEMINI_API_KEY` | Yes | — | Google Gemini API key for moderation + classification |
| `N8N_WEBHOOK_URL` | Yes | — | n8n workflow webhook URL |
| `MYSQL_HOST` | No | `localhost` | MySQL host |
| `MYSQL_PORT` | No | `3306` | MySQL port |
| `MYSQL_USER` | No | `root` | MySQL user |
| `MYSQL_PASSWORD` | Yes | — | MySQL password |
| `MYSQL_DATABASE` | No | `chatsupport` | MySQL database name |
| `TEAMS_WEBHOOK_URL` | No | — | Power Automate webhook URL for Teams notifications |

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `Cannot connect to n8n` | Ensure n8n is running (`docker ps`), check `N8N_WEBHOOK_URL` matches the webhook trigger URL |
| `GEMINI_API_KEY not set` | Add your key to `.env`; also configure the credential in n8n |
| `MySQL connection refused` | Verify MySQL is running, credentials in `.env` are correct |
| `n8n nodes show "no credential"` | Open the workflow in n8n, click each Gemini node, and assign your Gemini credential |
| `172.17.0.1 connection refused` | n8n can't reach the server; try `host.docker.internal:8000` or your machine's LAN IP |
| `Teams replies not arriving` | Check Power Automate flow is active, verify the `/api/send-response` URL is reachable |
| `Moderation rejecting valid replies` | Check the moderation dashboard at `/moderation.html`; the vocabulary list may need expansion |

## Technologies

- **Node.js / Express** — backend server
- **Socket.io** — real-time messaging
- **n8n** — workflow automation (intent detection, KB matching, response generation)
- **Google Gemini** — LLM for intent classification, moderation, and clarification
- **MySQL** — conversation memory, ticket storage, moderation logs
- **Tesseract.js** — OCR for image attachments
- **pdf-parse** — PDF text extraction
- **Power Automate** — Microsoft Teams integration
- **Axios** — HTTP client
- **Multer** — file upload handling

## License

ISC
