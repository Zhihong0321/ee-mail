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

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/` | API info |
| POST | `/send` | Send single email |
| POST | `/send-batch` | Send batch emails |
| POST | `/webhook` | Receive email webhooks |

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
