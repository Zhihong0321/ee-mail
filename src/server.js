// HTTP Server for Railway

import http from 'http';
import { URL } from 'url';
import config, { validateConfig } from './config.js';
import { sendEmail, sendBatch, sendTextEmail } from './email-service.js';

// Request body parser
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

// JSON response helper
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// CORS headers
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// Route handlers
const routes = {
  // Health check
  'GET /health': async (req, res) => {
    json(res, 200, {
      status: 'ok',
      timestamp: new Date().toISOString(),
      env: config.NODE_ENV,
      version: process.env.npm_package_version || '1.0.0',
    });
  },

  // Send email
  'POST /send': async (req, res) => {
    try {
      const body = await parseBody(req);
      
      // Validate required fields
      if (!body.to || !body.subject || (!body.html && !body.text)) {
        return json(res, 400, {
          error: 'Missing required fields: to, subject, html (or text)',
        });
      }

      const result = await sendEmail(body);
      json(res, 200, { success: true, data: result });
    } catch (err) {
      console.error('Send email error:', err);
      json(res, err.status || 500, {
        success: false,
        error: err.message,
      });
    }
  },

  // Send batch emails
  'POST /send-batch': async (req, res) => {
    try {
      const body = await parseBody(req);
      
      if (!Array.isArray(body.emails)) {
        return json(res, 400, {
          error: 'Missing required field: emails (array)',
        });
      }

      const results = await sendBatch(body.emails);
      json(res, 200, { success: true, data: results });
    } catch (err) {
      console.error('Send batch error:', err);
      json(res, err.status || 500, {
        success: false,
        error: err.message,
      });
    }
  },

  // Receive webhook (for incoming emails)
  'POST /webhook': async (req, res) => {
    try {
      const body = await parseBody(req);
      
      // Verify webhook secret if configured
      if (config.WEBHOOK_SECRET) {
        const signature = req.headers['x-resend-signature'];
        // TODO: Implement signature verification
      }

      console.log('Webhook received:', body);
      
      // Handle the webhook event
      // You can add your custom logic here
      
      json(res, 200, { received: true });
    } catch (err) {
      console.error('Webhook error:', err);
      json(res, 500, { error: err.message });
    }
  },

  // Root - API info
  'GET /': async (req, res) => {
    json(res, 200, {
      name: 'EE-Mail Service',
      version: '1.0.0',
      domain: config.EMAIL_DOMAIN,
      endpoints: [
        { method: 'GET', path: '/health', description: 'Health check' },
        { method: 'POST', path: '/send', description: 'Send email' },
        { method: 'POST', path: '/send-batch', description: 'Send batch emails' },
        { method: 'POST', path: '/webhook', description: 'Receive email webhooks' },
      ],
    });
  },
};

// Create server
export function createServer() {
  validateConfig();

  return http.createServer(async (req, res) => {
    setCors(res);

    // Handle preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const routeKey = `${req.method} ${url.pathname}`;

    const handler = routes[routeKey] || routes[`${req.method} ${url.pathname}`];

    if (handler) {
      await handler(req, res);
    } else {
      json(res, 404, { error: 'Not found' });
    }
  });
}
