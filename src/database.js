// PostgreSQL Database Connection

import pg from 'pg';
const { Pool } = pg;

let pool = null;

/**
 * Initialize database connection
 * @param {string} connectionString - PostgreSQL connection string
 */
export function initDatabase(connectionString) {
  if (!connectionString) {
    console.warn('⚠️  No DATABASE_URL provided, database features disabled');
    return null;
  }

  pool = new Pool({
    connectionString,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });

  // Test connection
  pool.query('SELECT NOW()', (err, res) => {
    if (err) {
      console.error('❌ Database connection failed:', err.message);
    } else {
      console.log('✅ Database connected:', res.rows[0].now);
    }
  });

  return pool;
}

/**
 * Get the database pool
 */
export function getPool() {
  return pool;
}

/**
 * Check if database is available
 */
export function isDatabaseAvailable() {
  return pool !== null;
}

/**
 * Initialize database tables
 */
export async function initTables() {
  if (!pool) return;

  const client = await pool.connect();
  try {
    // Create tables (without domain column first for backward compatibility)
    await client.query(`
      CREATE TABLE IF NOT EXISTS emails (
        id SERIAL PRIMARY KEY,
        resend_id VARCHAR(255) UNIQUE,
        from_email VARCHAR(255) NOT NULL,
        to_email VARCHAR(255) NOT NULL,
        cc_emails JSONB DEFAULT '[]',
        bcc_emails JSONB DEFAULT '[]',
        subject TEXT NOT NULL,
        html_content TEXT,
        text_content TEXT,
        status VARCHAR(50) DEFAULT 'pending',
        sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        delivered_at TIMESTAMP,
        opened_at TIMESTAMP,
        clicked_at TIMESTAMP,
        error_message TEXT,
        metadata JSONB DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_emails_resend_id ON emails(resend_id);
      CREATE INDEX IF NOT EXISTS idx_emails_to_email ON emails(to_email);
      CREATE INDEX IF NOT EXISTS idx_emails_status ON emails(status);
      CREATE INDEX IF NOT EXISTS idx_emails_sent_at ON emails(sent_at);
    `);

    // Add domain column to emails if it doesn't exist
    const emailsDomainCheck = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'emails' AND column_name = 'domain'
    `);
    
    if (emailsDomainCheck.rows.length === 0) {
      await client.query(`
        ALTER TABLE emails 
        ADD COLUMN domain VARCHAR(255) NOT NULL DEFAULT 'eternalgy.me'
      `);
      console.log('✅ Added domain column to emails table');
    }
    
    // Create domain index separately (after ensuring column exists)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_emails_domain ON emails(domain)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS webhooks (
        id SERIAL PRIMARY KEY,
        event_type VARCHAR(100) NOT NULL,
        email_id VARCHAR(255),
        payload JSONB NOT NULL,
        received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_webhooks_email_id ON webhooks(email_id);
      CREATE INDEX IF NOT EXISTS idx_webhooks_event_type ON webhooks(event_type);
    `);

    // Create received_emails table (without domain column first)
    await client.query(`
      CREATE TABLE IF NOT EXISTS received_emails (
        id SERIAL PRIMARY KEY,
        email_id VARCHAR(255) UNIQUE,
        message_id VARCHAR(255),
        from_email TEXT NOT NULL,
        to_email TEXT NOT NULL,
        subject TEXT,
        html_content TEXT,
        text_content TEXT,
        attachments JSONB DEFAULT '[]',
        headers JSONB DEFAULT '{}',
        raw_data JSONB DEFAULT '{}',
        received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_received_emails_email_id ON received_emails(email_id);
      CREATE INDEX IF NOT EXISTS idx_received_emails_to_email ON received_emails(to_email);
      CREATE INDEX IF NOT EXISTS idx_received_emails_received_at ON received_emails(received_at);
    `);

    // Add domain column to received_emails if it doesn't exist
    const receivedDomainCheck = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'received_emails' AND column_name = 'domain'
    `);
    
    if (receivedDomainCheck.rows.length === 0) {
      await client.query(`
        ALTER TABLE received_emails 
        ADD COLUMN domain VARCHAR(255) NOT NULL DEFAULT 'eternalgy.me'
      `);
      console.log('✅ Added domain column to received_emails table');
    }
    
    // Create domain index separately (after ensuring column exists)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_received_emails_domain ON received_emails(domain)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS email_logs (
        id SERIAL PRIMARY KEY,
        level VARCHAR(20) NOT NULL,
        message TEXT NOT NULL,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_email_logs_created_at ON email_logs(created_at);
    `);

    // Create api_keys table for domain-specific API key management
    await client.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id SERIAL PRIMARY KEY,
        domain VARCHAR(255) NOT NULL UNIQUE,
        api_key TEXT NOT NULL,
        description TEXT,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_api_keys_domain ON api_keys(domain);
      CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(is_active);
    `);

    console.log('✅ Database tables initialized');
  } catch (err) {
    console.error('❌ Failed to initialize tables:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Save sent email to database
 */
export async function saveEmail(data) {
  if (!pool) return null;

  const {
    resendId,
    domain,
    from,
    to,
    cc,
    bcc,
    subject,
    html,
    text,
    status = 'sent',
  } = data;

  // Extract domain from from_email if not provided
  const fromEmail = from || '';
  const emailDomain = domain || fromEmail.split('@')[1] || 'eternalgy.me';

  const result = await pool.query(
    `INSERT INTO emails 
     (resend_id, domain, from_email, to_email, cc_emails, bcc_emails, subject, html_content, text_content, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      resendId,
      emailDomain,
      from,
      Array.isArray(to) ? to.join(', ') : to,
      JSON.stringify(cc || []),
      JSON.stringify(bcc || []),
      subject,
      html,
      text,
      status,
    ]
  );

  return result.rows[0];
}

/**
 * Save webhook event to database
 */
export async function saveWebhook(event) {
  if (!pool) return null;

  const result = await pool.query(
    `INSERT INTO webhooks (event_type, email_id, payload)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [event.type, event.data?.email_id, JSON.stringify(event)]
  );

  return result.rows[0];
}

/**
 * Update email status from webhook
 */
export async function updateEmailStatus(resendId, status, data = {}) {
  if (!pool) return null;

  const updates = ['status = $1'];
  const values = [status];
  let paramIndex = 2;

  if (data.delivered_at) {
    updates.push(`delivered_at = $${paramIndex++}`);
    values.push(data.delivered_at);
  }
  if (data.opened_at) {
    updates.push(`opened_at = $${paramIndex++}`);
    values.push(data.opened_at);
  }
  if (data.clicked_at) {
    updates.push(`clicked_at = $${paramIndex++}`);
    values.push(data.clicked_at);
  }

  values.push(resendId);

  const result = await pool.query(
    `UPDATE emails SET ${updates.join(', ')} WHERE resend_id = $${paramIndex} RETURNING *`,
    values
  );

  return result.rows[0];
}

/**
 * Get email statistics
 */
export async function getStats() {
  if (!pool) return { total: 0, sent: 0, delivered: 0, opened: 0, bounced: 0 };

  const result = await pool.query(`
    SELECT 
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE status = 'sent') as sent,
      COUNT(*) FILTER (WHERE status = 'delivered') as delivered,
      COUNT(*) FILTER (WHERE status = 'bounced') as bounced,
      COUNT(*) FILTER (WHERE opened_at IS NOT NULL) as opened,
      COUNT(*) FILTER (WHERE clicked_at IS NOT NULL) as clicked
    FROM emails
  `);

  return result.rows[0];
}

/**
 * Get recent emails
 */
export async function getRecentEmails(limit = 50) {
  if (!pool) return [];

  const result = await pool.query(
    `SELECT * FROM emails ORDER BY sent_at DESC LIMIT $1`,
    [limit]
  );

  return result.rows;
}

/**
 * Save received (inbound) email
 */
export async function saveReceivedEmail(data) {
  if (!pool) return null;

  const {
    emailId,
    messageId,
    domain,
    from,
    to,
    subject,
    html,
    text,
    attachments,
    headers,
    rawData,
  } = data;

  // Extract domain from to_email if not provided
  const toEmail = Array.isArray(to) ? to[0] : to;
  const emailDomain = domain || (toEmail && toEmail.split('@')[1]) || 'eternalgy.me';

  const result = await pool.query(
    `INSERT INTO received_emails 
     (email_id, message_id, domain, from_email, to_email, subject, html_content, text_content, attachments, headers, raw_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (email_id) DO NOTHING
     RETURNING *`,
    [
      emailId,
      messageId,
      emailDomain,
      from,
      Array.isArray(to) ? to.join(', ') : to,
      subject,
      html,
      text,
      JSON.stringify(attachments || []),
      JSON.stringify(headers || {}),
      JSON.stringify(rawData || {}),
    ]
  );

  return result.rows[0];
}

/**
 * Get received emails
 */
export async function getReceivedEmails(limit = 50) {
  if (!pool) return [];

  const result = await pool.query(
    `SELECT * FROM received_emails ORDER BY received_at DESC LIMIT $1`,
    [limit]
  );

  return result.rows;
}

/**
 * Update received email with content (html/text)
 */
export async function updateReceivedEmail(emailId, data) {
  if (!pool) return null;

  const updates = [];
  const values = [];
  let paramIndex = 1;

  if (data.html !== undefined) {
    updates.push(`html_content = $${paramIndex++}`);
    values.push(data.html);
  }
  if (data.text !== undefined) {
    updates.push(`text_content = $${paramIndex++}`);
    values.push(data.text);
  }
  if (data.headers) {
    updates.push(`headers = $${paramIndex++}`);
    values.push(JSON.stringify(data.headers));
  }

  if (updates.length === 0) return null;

  values.push(emailId);

  const result = await pool.query(
    `UPDATE received_emails SET ${updates.join(', ')} WHERE email_id = $${paramIndex} RETURNING *`,
    values
  );

  return result.rows[0];
}

/**
 * Get a single sent email by database ID
 */
export async function getEmailById(id) {
  if (!pool) return null;

  const result = await pool.query(
    `SELECT * FROM emails WHERE id = $1`,
    [id]
  );

  return result.rows[0] || null;
}

/**
 * Get a single sent email by Resend ID
 */
export async function getEmailByResendId(resendId) {
  if (!pool) return null;

  const result = await pool.query(
    `SELECT * FROM emails WHERE resend_id = $1`,
    [resendId]
  );

  return result.rows[0] || null;
}

/**
 * Get a single received email by database ID
 */
export async function getReceivedEmailById(id) {
  if (!pool) return null;

  const result = await pool.query(
    `SELECT * FROM received_emails WHERE id = $1`,
    [id]
  );

  return result.rows[0] || null;
}

/**
 * Get a single received email by email ID (Resend ID)
 */
export async function getReceivedEmailByEmailId(emailId) {
  if (!pool) return null;

  const result = await pool.query(
    `SELECT * FROM received_emails WHERE email_id = $1`,
    [emailId]
  );

  return result.rows[0] || null;
}

/**
 * Get email statistics by domain
 */
export async function getStatsByDomain() {
  if (!pool) return [];

  const result = await pool.query(`
    SELECT 
      domain,
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE status = 'sent') as sent,
      COUNT(*) FILTER (WHERE status = 'delivered') as delivered,
      COUNT(*) FILTER (WHERE status = 'bounced') as bounced,
      COUNT(*) FILTER (WHERE opened_at IS NOT NULL) as opened,
      COUNT(*) FILTER (WHERE clicked_at IS NOT NULL) as clicked
    FROM emails
    GROUP BY domain
    ORDER BY domain
  `);

  return result.rows;
}

/**
 * Get recent emails filtered by domain
 */
export async function getRecentEmailsByDomain(domain, limit = 50) {
  if (!pool) return [];

  const result = await pool.query(
    `SELECT * FROM emails WHERE domain = $1 ORDER BY sent_at DESC LIMIT $2`,
    [domain, limit]
  );

  return result.rows;
}

/**
 * Get received emails filtered by domain
 */
export async function getReceivedEmailsByDomain(domain, limit = 50) {
  if (!pool) return [];

  const result = await pool.query(
    `SELECT * FROM received_emails WHERE domain = $1 ORDER BY received_at DESC LIMIT $2`,
    [domain, limit]
  );

  return result.rows;
}

/**
 * Get all unique domains from sent emails
 */
export async function getSentDomains() {
  if (!pool) return [];

  const result = await pool.query(`
    SELECT DISTINCT domain FROM emails WHERE domain IS NOT NULL ORDER BY domain
  `);

  return result.rows.map(r => r.domain);
}

/**
 * Get all unique domains from received emails
 */
export async function getReceivedDomains() {
  if (!pool) return [];

  const result = await pool.query(`
    SELECT DISTINCT domain FROM received_emails WHERE domain IS NOT NULL ORDER BY domain
  `);

  return result.rows.map(r => r.domain);
}

// ============================================
// API Key Management Functions
// ============================================

/**
 * Get all API keys
 */
export async function getAllApiKeys() {
  if (!pool) return [];

  const result = await pool.query(`
    SELECT id, domain, description, is_active, created_at, updated_at
    FROM api_keys 
    ORDER BY domain
  `);

  return result.rows;
}

/**
 * Get API key by domain (returns full record with key)
 */
export async function getApiKeyByDomain(domain) {
  if (!pool || !domain) return null;

  const result = await pool.query(`
    SELECT * FROM api_keys 
    WHERE domain = $1 AND is_active = true
  `, [domain.toLowerCase()]);

  return result.rows[0] || null;
}

/**
 * Get API key by ID
 */
export async function getApiKeyById(id) {
  if (!pool) return null;

  const result = await pool.query(`
    SELECT id, domain, description, is_active, created_at, updated_at
    FROM api_keys 
    WHERE id = $1
  `, [id]);

  return result.rows[0] || null;
}

/**
 * Create or update API key for a domain
 */
export async function saveApiKey(domain, apiKey, description = '') {
  if (!pool) return null;

  const result = await pool.query(`
    INSERT INTO api_keys (domain, api_key, description, updated_at)
    VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
    ON CONFLICT (domain) 
    DO UPDATE SET 
      api_key = EXCLUDED.api_key,
      description = EXCLUDED.description,
      updated_at = CURRENT_TIMESTAMP,
      is_active = true
    RETURNING id, domain, description, is_active, created_at, updated_at
  `, [domain.toLowerCase(), apiKey, description]);

  return result.rows[0];
}

/**
 * Update API key
 */
export async function updateApiKey(id, updates) {
  if (!pool) return null;

  const allowedFields = ['api_key', 'description', 'is_active'];
  const setClauses = [];
  const values = [];
  let paramIndex = 1;

  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key)) {
      setClauses.push(`${key} = $${paramIndex++}`);
      values.push(value);
    }
  }

  if (setClauses.length === 0) return null;

  setClauses.push(`updated_at = CURRENT_TIMESTAMP`);
  values.push(id);

  const result = await pool.query(`
    UPDATE api_keys 
    SET ${setClauses.join(', ')} 
    WHERE id = $${paramIndex}
    RETURNING id, domain, description, is_active, created_at, updated_at
  `, values);

  return result.rows[0] || null;
}

/**
 * Delete API key
 */
export async function deleteApiKey(id) {
  if (!pool) return false;

  const result = await pool.query(`
    DELETE FROM api_keys WHERE id = $1
  `, [id]);

  return result.rowCount > 0;
}

/**
 * Get API keys map for all domains (for config)
 */
export async function getApiKeysMap() {
  if (!pool) return {};

  const result = await pool.query(`
    SELECT domain, api_key FROM api_keys WHERE is_active = true
  `);

  const map = {};
  result.rows.forEach(row => {
    map[row.domain] = row.api_key;
  });

  return map;
}
