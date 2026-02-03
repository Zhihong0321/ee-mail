// HTTP Server for Railway

import http from 'http';
import fs from 'fs';
import path from 'path';
import { URL } from 'url';
import config, { validateConfig, clearApiKeysCache } from './config.js';
import { sendEmail, sendBatch, sendTextEmail } from './email-service.js';
import {
  isDatabaseAvailable,
  saveEmail,
  saveWebhook,
  updateEmailStatus,
  saveReceivedEmail,
  updateReceivedEmail,
  getStats,
  getStatsByDomain,
  getRecentEmails,
  getReceivedEmails,
  getRecentEmailsByDomain,
  getReceivedEmailsByDomain,
  getSentDomains,
  getReceivedDomains,
  getEmailById,
  getEmailByResendId,
  getReceivedEmailById,
  getReceivedEmailByEmailId,
  getAllApiKeys,
  saveApiKey,
  getApiKeyById,
  updateApiKey,
  deleteApiKey
} from './database.js';
import { getReceivedEmailWithRetry } from './resend-client.js';
import { fetchAttachments, downloadAttachment } from './resend-client.js';

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

      // Validate attachments (10MB limit)
      const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10MB
      if (body.attachments && Array.isArray(body.attachments)) {
        let totalSize = 0;
        for (const attachment of body.attachments) {
          if (attachment.content) {
            // Calculate base64 decoded size (approximate)
            const base64Length = attachment.content.length;
            const decodedSize = Math.floor(base64Length * 0.75);
            totalSize += decodedSize;
            
            if (decodedSize > MAX_ATTACHMENT_SIZE) {
              return json(res, 400, {
                error: `Attachment "${attachment.filename || 'unnamed'}" exceeds 10MB limit`,
              });
            }
          }
        }
        
        if (totalSize > MAX_ATTACHMENT_SIZE) {
          return json(res, 400, {
            error: 'Total attachment size exceeds 10MB limit',
          });
        }
      }

      // Determine domain from from_email or use provided domain
      let fromEmail = body.from;
      let domain = body.domain;
      
      if (fromEmail) {
        // Extract domain from from_email
        domain = fromEmail.split('@')[1];
      } else if (domain && config.EMAIL_DOMAINS.includes(domain)) {
        // Use provided domain with default sender
        fromEmail = config.DEFAULT_SENDERS[domain];
      } else {
        // Use primary domain default
        fromEmail = config.DEFAULT_FROM;
        domain = config.EMAIL_DOMAIN;
      }

      const result = await sendEmail({ ...body, from: fromEmail });
      
      // Save to database if available
      if (isDatabaseAvailable()) {
        await saveEmail({
          resendId: result.id,
          domain,
          from: fromEmail,
          to: body.to,
          cc: body.cc,
          bcc: body.bcc,
          subject: body.subject,
          html: body.html,
          text: body.text,
          status: 'sent',
        });
      }
      
      json(res, 200, { success: true, data: result, domain });
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
          
          // Extract domain from "to" email address for API key selection
          const toEmail = Array.isArray(emailData.to) ? emailData.to[0] : emailData.to;
          const domain = toEmail ? toEmail.split('@')[1] : null;
          
          // Save initial record (without html/text)
          const saved = await saveReceivedEmail({
            emailId: emailData.email_id,
            messageId: emailData.message_id,
            domain,
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
                const fullEmail = await getReceivedEmailWithRetry(emailData.email_id, domain);
                
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

  // Get stats by domain
  'GET /stats/domains': async (req, res) => {
    try {
      const stats = isDatabaseAvailable() 
        ? await getStatsByDomain() 
        : { note: 'Database not configured' };
      json(res, 200, { success: true, data: stats });
    } catch (err) {
      json(res, 500, { success: false, error: err.message });
    }
  },

  // Get all configured domains
  'GET /domains': async (req, res) => {
    try {
      const configuredDomains = config.EMAIL_DOMAINS || [];
      const sentDomains = isDatabaseAvailable() ? await getSentDomains() : [];
      const receivedDomains = isDatabaseAvailable() ? await getReceivedDomains() : [];
      
      // Merge all domains
      const allDomains = new Set([...configuredDomains, ...sentDomains, ...receivedDomains]);
      
      const domainData = Array.from(allDomains).map(domain => ({
        domain,
        configured: configuredDomains.includes(domain),
        defaultSender: config.DEFAULT_SENDERS[domain] || `noreply@${domain}`,
        isPrimary: domain === config.EMAIL_DOMAIN,
      }));
      
      json(res, 200, { success: true, data: domainData });
    } catch (err) {
      json(res, 500, { success: false, error: err.message });
    }
  },

  // Get sent emails
  'GET /emails': async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query?.limit) || 50, 100);
      const domain = req.query?.domain;
      
      let emails;
      if (isDatabaseAvailable()) {
        emails = domain 
          ? await getRecentEmailsByDomain(domain, limit)
          : await getRecentEmails(limit);
      } else {
        emails = [];
      }
      
      json(res, 200, { success: true, data: emails });
    } catch (err) {
      json(res, 500, { success: false, error: err.message });
    }
  },

  // Get received (inbound) emails
  'GET /received-emails': async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query?.limit) || 50, 100);
      const domain = req.query?.domain;
      
      let emails;
      if (isDatabaseAvailable()) {
        emails = domain
          ? await getReceivedEmailsByDomain(domain, limit)
          : await getReceivedEmails(limit);
      } else {
        emails = [];
      }
      
      json(res, 200, { success: true, data: emails });
    } catch (err) {
      json(res, 500, { success: false, error: err.message });
    }
  },

  // View a single sent email by database ID or Resend ID
  'GET /emails/:id': async (req, res) => {
    try {
      if (!isDatabaseAvailable()) {
        return json(res, 503, { success: false, error: 'Database not available' });
      }

      const id = req.params.id;
      let email;

      // Try database ID first (numeric), then Resend ID (string)
      if (/^\d+$/.test(id)) {
        email = await getEmailById(parseInt(id));
      } else {
        email = await getEmailByResendId(id);
      }

      if (!email) {
        return json(res, 404, { success: false, error: 'Email not found' });
      }

      json(res, 200, { success: true, data: email });
    } catch (err) {
      json(res, 500, { success: false, error: err.message });
    }
  },

  // View a single received email by database ID or email ID
  'GET /received-emails/:id': async (req, res) => {
    try {
      if (!isDatabaseAvailable()) {
        return json(res, 503, { success: false, error: 'Database not available' });
      }

      const id = req.params.id;
      let email;

      // Try database ID first (numeric), then email_id (string)
      if (/^\d+$/.test(id)) {
        email = await getReceivedEmailById(parseInt(id));
      } else {
        email = await getReceivedEmailByEmailId(id);
      }

      if (!email) {
        return json(res, 404, { success: false, error: 'Email not found' });
      }

      json(res, 200, { success: true, data: email });
    } catch (err) {
      json(res, 500, { success: false, error: err.message });
    }
  },

  // Get email attachments
  'GET /received-emails/:id/attachments': async (req, res) => {
    try {
      if (!isDatabaseAvailable()) {
        return json(res, 503, { success: false, error: 'Database not available' });
      }

      const id = req.params.id;
      let email;

      // Try database ID first (numeric), then email_id (string)
      if (/^\d+$/.test(id)) {
        email = await getReceivedEmailById(parseInt(id));
      } else {
        email = await getReceivedEmailByEmailId(id);
      }

      if (!email) {
        return json(res, 404, { success: false, error: 'Email not found' });
      }

      if (!email.email_id) {
        return json(res, 400, { success: false, error: 'Email has no Resend ID' });
      }

      const attachments = await fetchAttachments(email.email_id, email.domain);
      
      json(res, 200, { 
        success: true, 
        data: attachments 
      });
    } catch (err) {
      console.error('❌ Failed to fetch attachments:', err);
      json(res, 500, { success: false, error: err.message });
    }
  },

  // Proxy download attachment (handles CORS and expired URLs)
  'GET /attachments/:emailId/:filename': async (req, res) => {
    try {
      const { emailId, filename } = req.params;
      
      if (!emailId || !filename) {
        return json(res, 400, { success: false, error: 'Missing emailId or filename' });
      }

      // Get domain from database if available
      let domain = null;
      if (isDatabaseAvailable()) {
        const email = await getReceivedEmailByEmailId(emailId);
        domain = email?.domain;
      }

      // Fetch fresh attachments to get valid download_url
      const attachments = await fetchAttachments(emailId, domain);
      const attachment = attachments.find(a => a.filename === decodeURIComponent(filename));
      
      if (!attachment) {
        return json(res, 404, { success: false, error: 'Attachment not found' });
      }

      // Download the attachment content
      const content = await downloadAttachment(attachment.download_url);
      
      // Set appropriate headers
      res.writeHead(200, {
        'Content-Type': attachment.content_type || 'application/octet-stream',
        'Content-Disposition': `inline; filename="${encodeURIComponent(attachment.filename)}"`,
        'Content-Length': content.length,
      });
      res.end(content);
    } catch (err) {
      console.error('❌ Failed to download attachment:', err);
      json(res, 500, { success: false, error: err.message });
    }
  },

  // Download attachment with download header
  'GET /attachments/:emailId/:filename/download': async (req, res) => {
    try {
      const { emailId, filename } = req.params;
      
      if (!emailId || !filename) {
        return json(res, 400, { success: false, error: 'Missing emailId or filename' });
      }

      // Get domain from database if available
      let domain = null;
      if (isDatabaseAvailable()) {
        const email = await getReceivedEmailByEmailId(emailId);
        domain = email?.domain;
      }

      // Fetch fresh attachments to get valid download_url
      const attachments = await fetchAttachments(emailId, domain);
      const attachment = attachments.find(a => a.filename === decodeURIComponent(filename));
      
      if (!attachment) {
        return json(res, 404, { success: false, error: 'Attachment not found' });
      }

      // Download the attachment content
      const content = await downloadAttachment(attachment.download_url);
      
      // Set appropriate headers for download
      res.writeHead(200, {
        'Content-Type': attachment.content_type || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(attachment.filename)}"`,
        'Content-Length': content.length,
      });
      res.end(content);
    } catch (err) {
      console.error('❌ Failed to download attachment:', err);
      json(res, 500, { success: false, error: err.message });
    }
  },

  // Re-fetch email content from Resend API
  'POST /received-emails/fetch': async (req, res) => {
    try {
      if (!isDatabaseAvailable()) {
        return json(res, 503, { success: false, error: 'Database not available' });
      }

      const body = await parseBody(req);
      const emailId = body.email_id;
      
      if (!emailId) {
        return json(res, 400, { success: false, error: 'email_id required in body' });
      }

      // Get domain from database for API key selection
      const email = await getReceivedEmailByEmailId(emailId);
      const domain = email?.domain;

      console.log(`🔄 Manually fetching content for email: ${emailId}`);
      
      const fullEmail = await getReceivedEmailWithRetry(emailId, domain);
      
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

  // ============================================
  // API Key Management (Admin UI)
  // ============================================
  
  // Get all API keys
  'GET /api-keys': async (req, res) => {
    try {
      if (!isDatabaseAvailable()) {
        return json(res, 503, { success: false, error: 'Database not available' });
      }

      const keys = await getAllApiKeys();
      json(res, 200, { success: true, data: keys });
    } catch (err) {
      json(res, 500, { success: false, error: err.message });
    }
  },

  // Create or update API key
  'POST /api-keys': async (req, res) => {
    try {
      if (!isDatabaseAvailable()) {
        return json(res, 503, { success: false, error: 'Database not available' });
      }

      const body = await parseBody(req);
      
      if (!body.domain || !body.api_key) {
        return json(res, 400, {
          error: 'Missing required fields: domain, api_key',
        });
      }

      const result = await saveApiKey(body.domain, body.api_key, body.description || '');
      
      // Clear cache so new key is used immediately
      clearApiKeysCache();
      
      json(res, 200, { success: true, data: result });
    } catch (err) {
      console.error('Save API key error:', err);
      json(res, 500, { success: false, error: err.message });
    }
  },

  // Update API key (toggle active, update description)
  'PATCH /api-keys/:id': async (req, res) => {
    try {
      if (!isDatabaseAvailable()) {
        return json(res, 503, { success: false, error: 'Database not available' });
      }

      const id = parseInt(req.params.id);
      const body = await parseBody(req);
      
      const updates = {};
      if (body.api_key !== undefined) updates.api_key = body.api_key;
      if (body.description !== undefined) updates.description = body.description;
      if (body.is_active !== undefined) updates.is_active = body.is_active;

      const result = await updateApiKey(id, updates);
      
      if (!result) {
        return json(res, 404, { success: false, error: 'API key not found' });
      }
      
      // Clear cache so changes take effect immediately
      clearApiKeysCache();
      
      json(res, 200, { success: true, data: result });
    } catch (err) {
      json(res, 500, { success: false, error: err.message });
    }
  },

  // Delete API key
  'DELETE /api-keys/:id': async (req, res) => {
    try {
      if (!isDatabaseAvailable()) {
        return json(res, 503, { success: false, error: 'Database not available' });
      }

      const id = parseInt(req.params.id);
      const deleted = await deleteApiKey(id);
      
      if (!deleted) {
        return json(res, 404, { success: false, error: 'API key not found' });
      }
      
      // Clear cache so deletion takes effect immediately
      clearApiKeysCache();
      
      json(res, 200, { success: true, message: 'API key deleted' });
    } catch (err) {
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
        { method: 'GET', path: '/emails', description: 'List sent emails' },
        { method: 'GET', path: '/emails/:id', description: 'View a single sent email by ID (database ID or Resend ID)' },
        { method: 'GET', path: '/received-emails', description: 'List received (inbound) emails' },
        { method: 'GET', path: '/received-emails/:id', description: 'View a single received email by ID (database ID or email ID)' },
        { method: 'POST', path: '/send', description: 'Send email' },
        { method: 'POST', path: '/send-batch', description: 'Send batch emails' },
        { method: 'POST', path: '/webhook', description: 'Receive webhooks & inbound emails' },
        { method: 'GET', path: '/domains', description: 'List all configured domains' },
        { method: 'GET', path: '/stats/domains', description: 'Get stats grouped by domain' },
        { method: 'GET', path: '/received-emails/:id/attachments', description: 'Get email attachments list' },
        { method: 'GET', path: '/attachments/:emailId/:filename', description: 'View attachment inline' },
        { method: 'GET', path: '/attachments/:emailId/:filename/download', description: 'Download attachment' },
        { method: 'GET', path: '/api-keys', description: 'List all API keys (admin)' },
        { method: 'POST', path: '/api-keys', description: 'Create/update API key (admin)' },
        { method: 'PATCH', path: '/api-keys/:id', description: 'Update API key (admin)' },
        { method: 'DELETE', path: '/api-keys/:id', description: 'Delete API key (admin)' },
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

    // Attach query params to request
    req.query = Object.fromEntries(url.searchParams.entries());

    // API routes - exact match first
    const handler = routes[routeKey];
    if (handler) {
      await handler(req, res);
      return;
    }

    // Try to match dynamic routes (e.g., /emails/:id)
    const routeParts = pathname.split('/').filter(Boolean);
    for (const [routePattern, routeHandler] of Object.entries(routes)) {
      const [method, pattern] = routePattern.split(' ');
      if (method !== req.method) continue;

      const patternParts = pattern.split('/').filter(Boolean);
      if (patternParts.length !== routeParts.length) continue;

      const params = {};
      let isMatch = true;

      for (let i = 0; i < patternParts.length; i++) {
        if (patternParts[i].startsWith(':')) {
          // Extract parameter name (remove ':')
          const paramName = patternParts[i].slice(1);
          params[paramName] = routeParts[i];
        } else if (patternParts[i] !== routeParts[i]) {
          isMatch = false;
          break;
        }
      }

      if (isMatch) {
        req.params = params;
        await routeHandler(req, res);
        return;
      }
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
