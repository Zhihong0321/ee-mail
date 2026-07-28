# EE-Mail Service

Email service using Resend API with the `@eternalgy.me` domain. Deployed on Railway.

## Project Structure

```
.
├── src/
│   ├── index.js          # Entry point
│   ├── server.js         # HTTP server
│   ├── email-service.js  # Resend email functions
│   └── config.js         # Environment configuration
├── scripts/
│   └── build.js          # Build script (no nixpack)
├── dist/                 # Build output
├── Dockerfile            # Railway Docker build
├── railway.toml          # Railway configuration
├── package.json
└── .env.example
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `RESEND_API_KEY` | Yes | Your Resend API key |
| `EMAIL_DOMAIN` | No | Email domain (default: eternalgy.me) |
| `DEFAULT_FROM` | No | Default sender email |
| `PORT` | No | Server port (default: 3000) |
| `WEBHOOK_SECRET` | No | Secret for webhook verification |
| `SEDA_API_KEY` | Required for worker | Production SEDA status API key; store as a Railway secret |
| `SEDA_STATUS_API_URL` | No | SEDA status endpoint (defaults to the production endpoint) |
| `SEDA_STATUS_DRY_RUN` | No | Defaults to `false`; use `true` only for safe matching tests |
| `SEDA_TASK_WORKER_INTERVAL_MS` | No | Worker polling interval (default: 5000 ms) |
| `AI_API_KEY` | No | API key for richer AI extraction; store as a Railway secret |
| `AI_API_BASE_URL` | No | OpenAI-compatible API root, without `/chat/completions` |
| `AI_MODEL` | No | Model identifier sent to the AI provider |
| `AI_REQUEST_TIMEOUT_MS` | No | AI request timeout in milliseconds (default: 10000, capped at 15000); recruitment uses a local fallback if the provider is unavailable |
| `AI_MAX_ATTEMPTS` | No | Total AI attempts including the first request (default: 3, capped at 5) |
| `AI_RETRY_BACKOFF_MS` | No | Initial exponential retry delay in milliseconds (default: 750, capped at 10000) |

Set `AI_API_KEY`, `AI_API_BASE_URL`, and `AI_MODEL` in Railway under **Service > Variables**. Railway applies changes after the service redeploys.

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/` | API info |
| POST | `/send` | Send single email |
| POST | `/send-batch` | Send batch emails |
| GET | `/emails` | List sent emails |
| GET | `/emails/:id` | View one sent email |
| GET | `/received-emails` | List received (inbound) emails |
| GET | `/received-emails/:id` | View one received email |
| POST | `/webhook` | Receive email webhooks |

All endpoints are public — there is no API key auth on this service.

### SEDA ATAP approval workflow

Every received email is checked in this order:

1. Sender: `admin@eternalgy.my` or a direct/forwarded `@seda.gov.my` sender.
2. Subject: ATAP/eATAP/ATP approval wording.
3. Headers/body: contains `seda.gov.my`.

A matching email creates a durable PostgreSQL task with status `PENDING` before any SEDA API request. The worker later calls the SEDA status API and changes the task to `COMPLETED` only when the response contains `success: true` and `updated: true`. Failed, ambiguous, or no-match requests remain durable and retryable/manual-reviewable.

Task endpoints (all public):

- `GET /seda-tasks`
- `GET /seda-tasks/stats`
- `GET /seda-tasks/:id`
- `POST /seda-tasks/scan` — body `{ days?: 7, domain?: null, limit?: 500 }`. Scans received emails since `days` ago and creates PENDING tasks for any that match the SEDA ATAP rules (idempotent, safe to re-run over overlapping windows). Also available as a "Scan emails since N days ago" control on the SEDA Tasks dashboard tab.
- `POST /seda-tasks/from-received-email/:id`
- `POST /seda-tasks/:id/retry`

## Local Development

```bash
# Install dependencies
npm install

# Set environment variables
cp .env.example .env
# Edit .env with your values

# Run dev server
npm run dev
```

## Deploy to Railway

### Option 1: Using Railway CLI

```bash
# Login to Railway
railway login

# Link project
railway link

# Deploy
railway up
```

### Option 2: Using GitHub Integration

1. Push to GitHub
2. Connect repository in Railway dashboard
3. Add environment variables
4. Deploy

## API Usage Examples

### Send Email

```bash
curl -X POST http://localhost:3000/send \
  -H "Content-Type: application/json" \
  -d '{
    "to": "user@example.com",
    "subject": "Hello",
    "html": "<h1>Hello World</h1>"
  }'
```

### Send Batch

```bash
curl -X POST http://localhost:3000/send-batch \
  -H "Content-Type: application/json" \
  -d '{
    "emails": [
      {"to": "user1@example.com", "subject": "Hi 1", "html": "<p>1</p>"},
      {"to": "user2@example.com", "subject": "Hi 2", "html": "<p>2</p>"}
    ]
  }'
```

## Build

```bash
# Build for production
npm run build

# Output goes to dist/
```
