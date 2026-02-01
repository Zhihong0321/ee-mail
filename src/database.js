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
    from,
    to,
    cc,
    bcc,
    subject,
    html,
    text,
    status = 'sent',
  } = data;

  const result = await pool.query(
    `INSERT INTO emails 
     (resend_id, from_email, to_email, cc_emails, bcc_emails, subject, html_content, text_content, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      resendId,
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
