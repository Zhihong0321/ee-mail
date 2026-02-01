// HTTP Server for Railway

import http from 'http';
import fs from 'fs';
import path from 'path';
import { URL } from 'url';
import config, { validateConfig } from './config.js';
import { sendEmail, sendBatch, sendTextEmail } from './email-service.js';
import { 
  isDatabaseAvailable, 
  saveEmail, 
  saveWebhook, 
  updateEmailStatus,
  saveReceivedEmail,
  updateReceivedEmail,
  getStats,
  getRecentEmails,
  getReceivedEmails
} from './database.js';
import { getReceivedEmailWithRetry } from './resend-client.js';

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

// Static file serving
const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  
  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        json(res, 404, { error: 'Not found' });
      } else {
        json(res, 500, { error: 'Server error' });
      }
      return;
    }
    
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });
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
      
      // Save to database if available
      if (isDatabaseAvailable()) {
        await saveEmail({
          resendId: result.id,
          from: body.from || config.DEFAULT_FROM,
          to: body.to,
          cc: body.cc,
          bcc: body.bcc,
          subject: body.subject,
          html: body.html,
          text: body.text,
          status: 'sent',
        });
      }
      
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

  // Receive webhook (for delivery status and inbound emails)
  'POST /webhook': async (req, res) => {
    try {
      const body = await parseBody(req);
      
      console.log(`📨 Webhook received: ${body.type}`, JSON.stringify(body, null, 2));
      
      // Save webhook to database
      if (isDatabaseAvailable()) {
        await saveWebhook(body);
        
        // Handle delivery status events
        if (body.type && body.data?.email_id) {
          const statusMap = {
            'email.sent': 'sent',
            'email.delivered': 'delivered',
            'email.bounced': 'bounced',
            'email.complained': 'complained',
            'email.opened': 'opened',
            'email.clicked': 'clicked',
          };
          
          if (statusMap[body.type]) {
            const updateData = {};
            if (body.type === 'email.delivered') updateData.delivered_at = new Date();
            if (body.type === 'email.opened') updateData.opened_at = new Date();
            if (body.type === 'email.clicked') updateData.clicked_at = new Date();
            
            await updateEmailStatus(body.data.email_id, statusMap[body.type], updateData);
            console.log(`✅ Updated email ${body.data.email_id} status to ${statusMap[body.type]}`);
          }
        }
        
        // Handle inbound email (someone sent TO @eternalgy.me)
        // Resend webhook structure: { type: "email.received", data: { from, to, subject, email_id, ... } }
        // Note: html/text are NOT included in webhook - must fetch via API
        if (body.type === 'email.received' && body.data) {
          const emailData = body.data;
          
          console.log('📥 Inbound email webhook:', JSON.stringify({
            from: emailData.from,
            to: emailData.to,
            subject: emailData.subject,
            emailId: emailData.email_id,
          }, null, 2));
          
          // Save initial record (without html/text)
          const saved = await saveReceivedEmail({
            emailId: emailData.email_id,
            messageId: emailData.message_id,
            from: emailData.from,
            to: Array.isArray(emailData.to) ? emailData.to.join(', ') : emailData.to,
            subject: emailData.subject || '(no subject)',
            html: null, // Will fetch separately
            text: null,
            attachments: emailData.attachments,
            headers: emailData.headers,
            rawData: emailData,
          });
          console.log('✅ Inbound email saved, id:', saved?.id);
          
          // Fetch full email content from Resend API (async, don't block response)
          if (emailData.email_id) {
            setTimeout(async () => {
              try {
                console.log(`🔄 Fetching email content for ${emailData.email_id}...`);
                const fullEmail = await getReceivedEmailWithRetry(emailData.email_id);
                
                await updateReceivedEmail(emailData.email_id, {
                  html: fullEmail.html,
                  text: fullEmail.text,
                  headers: fullEmail.headers,
                });
                
                console.log('✅ Email content updated');
              } catch (err) {
                console.error('❌ Failed to fetch email content:', err.message);
              }
            }, 100);
          }
        }
      }
      
      json(res, 200, { received: true });
    } catch (err) {
      console.error('❌ Webhook error:', err);
      json(res, 500, { error: err.message });
    }
  },

  // Get stats
  'GET /stats': async (req, res) => {
    try {
      const stats = isDatabaseAvailable() ? await getStats() : { note: 'Database not configured' };
      json(res, 200, { success: true, data: stats });
    } catch (err) {
      json(res, 500, { success: false, error: err.message });
    }
  },

  // Get sent emails
  'GET /emails': async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query?.limit) || 50, 100);
      const emails = isDatabaseAvailable() 
        ? await getRecentEmails(limit)
        : [];
      json(res, 200, { success: true, data: emails });
    } catch (err) {
      json(res, 500, { success: false, error: err.message });
    }
  },

  // Get received (inbound) emails
  'GET /received-emails': async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query?.limit) || 50, 100);
      const emails = isDatabaseAvailable() 
        ? await getReceivedEmails(limit)
        : [];
      json(res, 200, { success: true, data: emails });
    } catch (err) {
      json(res, 500, { success: false, error: err.message });
    }
  },

  // Re-fetch email content from Resend API
  'POST /received-emails/:id/fetch': async (req, res) => {
    try {
      if (!isDatabaseAvailable()) {
        return json(res, 503, { success: false, error: 'Database not available' });
      }

      // Parse email ID from URL
      const emailId = req.url.split('/')[2];
      
      if (!emailId) {
        return json(res, 400, { success: false, error: 'Email ID required' });
      }

      console.log(`🔄 Manually fetching content for email: ${emailId}`);
      
      const fullEmail = await getReceivedEmailWithRetry(emailId);
      
      const updated = await updateReceivedEmail(emailId, {
        html: fullEmail.html,
        text: fullEmail.text,
        headers: fullEmail.headers,
      });

      json(res, 200, { 
        success: true, 
        message: 'Email content updated',
        data: {
          hasHtml: !!fullEmail.html,
          hasText: !!fullEmail.text,
        }
      });
    } catch (err) {
      console.error('❌ Failed to fetch email content:', err);
      json(res, 500, { success: false, error: err.message });
    }
  },

  // API docs
  'GET /api': async (req, res) => {
    json(res, 200, {
      name: 'EE-Mail Service',
      version: '1.0.0',
      domain: config.EMAIL_DOMAIN,
      database: isDatabaseAvailable() ? 'connected' : 'not configured',
      endpoints: [
        { method: 'GET', path: '/health', description: 'Health check' },
        { method: 'GET', path: '/stats', description: 'Email statistics (sent)' },
        { method: 'GET', path: '/emails', description: 'Sent emails' },
        { method: 'GET', path: '/received-emails', description: 'Received (inbound) emails' },
        { method: 'POST', path: '/send', description: 'Send email' },
        { method: 'POST', path: '/send-batch', description: 'Send batch emails' },
        { method: 'POST', path: '/webhook', description: 'Receive webhooks & inbound emails' },
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
    const pathname = url.pathname;
    const routeKey = `${req.method} ${pathname}`;

    // API routes
    const handler = routes[routeKey];
    if (handler) {
      await handler(req, res);
      return;
    }

    // Serve admin page at root
    if (pathname === '/') {
      serveStatic(res, path.join(process.cwd(), 'public', 'index.html'));
      return;
    }

    // Serve static files from public directory
    if (pathname.startsWith('/')) {
      const filePath = path.join(process.cwd(), 'public', pathname);
      // Security: ensure file is within public directory
      const resolvedPath = path.resolve(filePath);
      const publicDir = path.resolve(process.cwd(), 'public');
      
      if (resolvedPath.startsWith(publicDir) && fs.existsSync(resolvedPath)) {
        serveStatic(res, resolvedPath);
        return;
      }
    }

    json(res, 404, { error: 'Not found' });
  });
}
