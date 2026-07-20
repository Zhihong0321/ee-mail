// PostgreSQL Database Connection

import pg from 'pg';
const { Pool } = pg;

let pool = null;

function quoteIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

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

    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_email_accounts (
        id SERIAL PRIMARY KEY,
        agent_bubble_id TEXT NOT NULL,
        email_prefix TEXT NOT NULL,
        full_email TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_agent_email_accounts_agent_bubble_id
        ON agent_email_accounts(agent_bubble_id);
      CREATE INDEX IF NOT EXISTS idx_agent_email_accounts_full_email
        ON agent_email_accounts(full_email);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS hod_departments (
      id SERIAL PRIMARY KEY,
      department VARCHAR(255) NOT NULL UNIQUE,
      hod_whatsapp_number VARCHAR(32) NOT NULL,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_hod_departments_active
        ON hod_departments(is_active);

      CREATE TABLE IF NOT EXISTS job_applications (
      id SERIAL PRIMARY KEY,
      received_email_id INTEGER NOT NULL UNIQUE REFERENCES received_emails(id) ON DELETE CASCADE,
      classification VARCHAR(40) NOT NULL,
      confidence NUMERIC(5,4) DEFAULT 0,
      classification_reason TEXT,
      applicant_name TEXT,
      applicant_email TEXT,
      phone TEXT,
      whatsapp_number TEXT,
      applied_position TEXT,
      department TEXT,
      years_experience TEXT,
      location TEXT,
      availability JSONB DEFAULT '[]',
      resume_summary TEXT,
      extraction JSONB NOT NULL DEFAULT '{}',
      processing_status VARCHAR(32) NOT NULL DEFAULT 'pending',
      status VARCHAR(40) NOT NULL DEFAULT 'new',
      acknowledgement_sent_at TIMESTAMP,
      hod_notified_at TIMESTAMP,
      notification_error TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_job_applications_status
        ON job_applications(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_job_applications_department
        ON job_applications(department);
    `);


    // Durable SEDA ATAP approval task queue
    await client.query(`
      CREATE TABLE IF NOT EXISTS seda_tasks (
        id BIGSERIAL PRIMARY KEY,
        task_type VARCHAR(100) NOT NULL DEFAULT 'SEDA_ATAP_APPROVAL',
        source_received_email_id INTEGER REFERENCES received_emails(id) ON DELETE SET NULL,
        source_email_id VARCHAR(255) NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
        requires_manual_review BOOLEAN NOT NULL DEFAULT false,
        customer_name TEXT,
        installation_address TEXT,
        application_number VARCHAR(255),
        payload JSONB NOT NULL DEFAULT '{}',
        api_request JSONB,
        api_response JSONB,
        api_attempts JSONB NOT NULL DEFAULT '[]',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_retry_at TIMESTAMP,
        claimed_at TIMESTAMP,
        last_error TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP,
        UNIQUE (task_type, source_email_id)
      );

      CREATE INDEX IF NOT EXISTS idx_seda_tasks_status_retry
        ON seda_tasks(status, requires_manual_review, next_retry_at);
      CREATE INDEX IF NOT EXISTS idx_seda_tasks_source_email
        ON seda_tasks(source_email_id);
      CREATE INDEX IF NOT EXISTS idx_seda_tasks_created_at
        ON seda_tasks(created_at);
    `);

    // Older setups may have enforced global uniqueness on email_prefix/full_email,
    // which prevents sharing one email across multiple agents.
    const agentEmailUniqueConstraints = await client.query(`
      SELECT c.conname, pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c
      JOIN pg_class t ON c.conrelid = t.oid
      WHERE t.relname = 'agent_email_accounts'
        AND c.contype = 'u'
    `);

    for (const constraint of agentEmailUniqueConstraints.rows) {
      const definition = constraint.definition || '';
      const blocksSharedAssignments =
        /\((email_prefix|full_email)\)/i.test(definition) &&
        !/agent_bubble_id/i.test(definition);

      if (blocksSharedAssignments) {
        await client.query(`
          ALTER TABLE agent_email_accounts
          DROP CONSTRAINT IF EXISTS ${quoteIdentifier(constraint.conname)}
        `);
        console.log(`✅ Dropped old unique constraint ${constraint.conname} on agent_email_accounts`);
      }
    }

    const agentEmailIndexes = await client.query(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename = 'agent_email_accounts'
    `);

    for (const index of agentEmailIndexes.rows) {
      const indexDef = index.indexdef || '';
      const blocksSharedAssignments =
        /CREATE UNIQUE INDEX/i.test(indexDef) &&
        /\((email_prefix|full_email)\)/i.test(indexDef) &&
        !/agent_bubble_id/i.test(indexDef) &&
        index.indexname !== 'agent_email_accounts_pkey';

      if (blocksSharedAssignments) {
        await client.query(`
          DROP INDEX IF EXISTS ${quoteIdentifier(index.indexname)}
        `);
        console.log(`✅ Dropped old unique index ${index.indexname} on agent_email_accounts`);
      }
    }

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_email_accounts_agent_full_email_unique
      ON agent_email_accounts(agent_bubble_id, full_email)
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
    `SELECT id, resend_id, domain, from_email, to_email, subject, status, sent_at, delivered_at, opened_at, clicked_at, error_message FROM emails ORDER BY sent_at DESC LIMIT $1`,
    [limit]
  );

  return result.rows;
}

function normalizeEmailSearchField(field) {
  switch ((field || 'all').toLowerCase()) {
    case 'title':
    case 'subject':
      return 'subject';
    case 'sender':
    case 'from':
      return 'from_email';
    case 'recipient':
    case 'to':
      return 'to_email';
    case 'content':
    case 'body':
      return 'content';
    default:
      return 'all';
  }
}

function buildEmailSearchWhereClause(search, field) {
  const trimmedSearch = (search || '').trim();
  if (!trimmedSearch) {
    return { clause: '', values: [] };
  }

  const normalizedField = normalizeEmailSearchField(field);
  const pattern = `%${trimmedSearch}%`;

  switch (normalizedField) {
    case 'subject':
      return { clause: 'subject ILIKE $1', values: [pattern] };
    case 'from_email':
      return { clause: 'from_email ILIKE $1', values: [pattern] };
    case 'to_email':
      return { clause: 'to_email ILIKE $1', values: [pattern] };
    case 'content':
      return {
        clause: '(COALESCE(text_content, \'\') ILIKE $1 OR COALESCE(html_content, \'\') ILIKE $1)',
        values: [pattern],
      };
    default:
      return {
        clause: `(
          subject ILIKE $1
          OR from_email ILIKE $1
          OR to_email ILIKE $1
          OR COALESCE(text_content, '') ILIKE $1
          OR COALESCE(html_content, '') ILIKE $1
        )`,
        values: [pattern],
      };
  }
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
    `SELECT id, email_id, message_id, domain, from_email, to_email, subject, attachments, received_at FROM received_emails ORDER BY received_at DESC LIMIT $1`,
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

export async function getJobApplicationByReceivedEmailId(receivedEmailId) {
  if (!pool) return null;

  const result = await pool.query(
    `SELECT * FROM job_applications WHERE received_email_id = $1`,
    [receivedEmailId]
  );
  return result.rows[0] || null;
}

export async function getJobApplicationById(id) {
  if (!pool) return null;

  const result = await pool.query(
    `SELECT * FROM job_applications WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

export async function saveJobApplication(data) {
  if (!pool) return null;

  const result = await pool.query(
    `INSERT INTO job_applications (
      received_email_id, classification, confidence, classification_reason,
      applicant_name, applicant_email, phone, whatsapp_number, applied_position,
      department, years_experience, location, availability, resume_summary,
      extraction, processing_status, status
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17
    )
    ON CONFLICT (received_email_id) DO UPDATE SET
      classification = EXCLUDED.classification,
      confidence = EXCLUDED.confidence,
      classification_reason = EXCLUDED.classification_reason,
      applicant_name = EXCLUDED.applicant_name,
      applicant_email = EXCLUDED.applicant_email,
      phone = EXCLUDED.phone,
      whatsapp_number = EXCLUDED.whatsapp_number,
      applied_position = EXCLUDED.applied_position,
      department = EXCLUDED.department,
      years_experience = EXCLUDED.years_experience,
      location = EXCLUDED.location,
      availability = EXCLUDED.availability,
      resume_summary = EXCLUDED.resume_summary,
      extraction = EXCLUDED.extraction,
      processing_status = EXCLUDED.processing_status,
      updated_at = CURRENT_TIMESTAMP
    RETURNING *`,
    [
      data.receivedEmailId,
      data.classification,
      data.confidence || 0,
      data.classificationReason || null,
      data.applicantName || null,
      data.applicantEmail || null,
      data.phone || null,
      data.whatsappNumber || null,
      data.appliedPosition || null,
      data.department || null,
      data.yearsExperience || null,
      data.location || null,
      JSON.stringify(data.availability || []),
      data.resumeSummary || null,
      JSON.stringify(data.extraction || {}),
      data.processingStatus || 'pending',
      data.status || 'new',
    ]
  );
  return result.rows[0] || null;
}

export async function updateJobApplication(id, data) {
  if (!pool) return null;

  const columnMap = {
    processingStatus: 'processing_status',
    status: 'status',
    acknowledgementSentAt: 'acknowledgement_sent_at',
    hodNotifiedAt: 'hod_notified_at',
    notificationError: 'notification_error',
    whatsappNumber: 'whatsapp_number',
    availability: 'availability',
  };
  const updates = [];
  const values = [];

  for (const [key, value] of Object.entries(data)) {
    const column = columnMap[key];
    if (!column) continue;
    values.push(key === 'availability' ? JSON.stringify(value || []) : value);
    updates.push(`${column} = $${values.length}`);
  }

  if (!updates.length) return getJobApplicationById(id);

  values.push(id);
  const result = await pool.query(
    `UPDATE job_applications
     SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
     WHERE id = $${values.length}
     RETURNING *`,
    values
  );
  return result.rows[0] || null;
}

export async function getJobApplications({ limit = 100, status = null } = {}) {
  if (!pool) return [];

  const values = [];
  const conditions = [];
  if (status) {
    values.push(status);
    conditions.push(`ja.status = $${values.length}`);
  }
  values.push(Math.min(Number(limit) || 100, 500));

  const result = await pool.query(
    `SELECT ja.*, re.subject, re.from_email, re.to_email, re.received_at
     FROM job_applications ja
     JOIN received_emails re ON re.id = ja.received_email_id
     ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
     ORDER BY ja.created_at DESC
     LIMIT $${values.length}`,
    values
  );
  return result.rows;
}

export async function getHodDepartments() {
  if (!pool) return [];

  const result = await pool.query(
    `SELECT * FROM hod_departments ORDER BY department ASC`
  );
  return result.rows;
}

export async function getHodDepartment(department) {
  if (!pool) return null;

  const normalized = String(department || '').trim();
  if (normalized) {
    const result = await pool.query(
      `SELECT * FROM hod_departments
       WHERE is_active = true AND LOWER(department) = LOWER($1)
       LIMIT 1`,
      [normalized]
    );
    if (result.rows[0]) return result.rows[0];
  }

  const fallback = await pool.query(
    `SELECT * FROM hod_departments
     WHERE is_active = true AND LOWER(department) IN ('default', 'general')
     ORDER BY id ASC
     LIMIT 1`
  );
  return fallback.rows[0] || null;
}

export async function saveHodDepartment(department, hodWhatsappNumber, isActive = true) {
  if (!pool) return null;

  const result = await pool.query(
    `INSERT INTO hod_departments (department, hod_whatsapp_number, is_active)
     VALUES ($1, $2, $3)
     ON CONFLICT (department) DO UPDATE SET
       hod_whatsapp_number = EXCLUDED.hod_whatsapp_number,
       is_active = EXCLUDED.is_active,
       updated_at = CURRENT_TIMESTAMP
     RETURNING *`,
    [String(department).trim(), String(hodWhatsappNumber).replace(/[^\d+]/g, ''), isActive]
  );
  return result.rows[0] || null;
}

export async function deleteHodDepartment(id) {
  if (!pool) return false;

  const result = await pool.query(
    `DELETE FROM hod_departments WHERE id = $1`,
    [id]
  );
  return result.rowCount > 0;
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
    `SELECT id, resend_id, domain, from_email, to_email, subject, status, sent_at, delivered_at, opened_at, clicked_at, error_message FROM emails WHERE domain = $1 ORDER BY sent_at DESC LIMIT $2`,
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
    `SELECT id, email_id, message_id, domain, from_email, to_email, subject, attachments, received_at FROM received_emails WHERE domain = $1 ORDER BY received_at DESC LIMIT $2`,
    [domain, limit]
  );

  return result.rows;
}

/**
 * Search sent emails with optional domain filter
 */
export async function searchEmails({ search, field = 'all', domain = null, limit = 50 } = {}) {
  if (!pool) return [];

  const values = [];
  const conditions = [];

  if (domain) {
    values.push(domain);
    conditions.push(`domain = $${values.length}`);
  }

  const searchFilter = buildEmailSearchWhereClause(search, field);
  if (searchFilter.clause) {
    const shiftedClause = searchFilter.clause.replace(/\$(\d+)/g, (_, n) => `$${values.length + Number(n)}`);
    conditions.push(shiftedClause);
    values.push(...searchFilter.values);
  }

  values.push(limit);
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await pool.query(
    `SELECT id, resend_id, domain, from_email, to_email, subject, status, sent_at, delivered_at, opened_at, clicked_at, error_message FROM emails ${whereClause} ORDER BY sent_at DESC LIMIT $${values.length}`,
    values
  );

  return result.rows;
}

/**
 * Search received emails with optional domain filter
 */
export async function searchReceivedEmails({ search, field = 'all', domain = null, limit = 50 } = {}) {
  if (!pool) return [];

  const values = [];
  const conditions = [];

  if (domain) {
    values.push(domain);
    conditions.push(`domain = $${values.length}`);
  }

  const searchFilter = buildEmailSearchWhereClause(search, field);
  if (searchFilter.clause) {
    const shiftedClause = searchFilter.clause.replace(/\$(\d+)/g, (_, n) => `$${values.length + Number(n)}`);
    conditions.push(shiftedClause);
    values.push(...searchFilter.values);
  }

  values.push(limit);
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await pool.query(
    `SELECT id, email_id, message_id, domain, from_email, to_email, subject, attachments, received_at FROM received_emails ${whereClause} ORDER BY received_at DESC LIMIT $${values.length}`,
    values
  );

  return result.rows;
}

/**
 * Get received emails (full rows, incl. content) received on or after a given date
 */
export async function getReceivedEmailsSince({ sinceDate, domain = null, limit = 500 } = {}) {
  if (!pool) return [];

  const values = [sinceDate];
  const conditions = ['received_at >= $1'];

  if (domain) {
    values.push(domain);
    conditions.push(`domain = $${values.length}`);
  }

  values.push(limit);

  const result = await pool.query(
    `SELECT * FROM received_emails WHERE ${conditions.join(' AND ')} ORDER BY received_at ASC LIMIT $${values.length}`,
    values
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


/**
 * Create or update a durable SEDA pending task.
 *
 * The INSERT is the first success boundary. The worker never calls the
 * external API until this row exists with status PENDING.
 */
export async function createSedaPendingTask(data) {
  if (!pool) return null;

  const {
    taskType = 'SEDA_ATAP_APPROVAL',
    sourceReceivedEmailId,
    sourceEmailId,
    customerName,
    installationAddress,
    applicationNumber,
    payload = {},
    requiresManualReview = false,
    initialError = null,
  } = data;

  if (!sourceEmailId) {
    throw new Error('sourceEmailId is required for a SEDA task');
  }

  const inserted = await pool.query(
    `INSERT INTO seda_tasks
      (task_type, source_received_email_id, source_email_id, status,
       requires_manual_review, customer_name, installation_address,
       application_number, payload, last_error)
     VALUES ($1, $2, $3, 'PENDING', $4, $5, $6, $7, $8, $9)
     ON CONFLICT (task_type, source_email_id) DO NOTHING
     RETURNING *`,
    [
      taskType,
      sourceReceivedEmailId || null,
      sourceEmailId,
      requiresManualReview,
      customerName || null,
      installationAddress || null,
      applicationNumber || null,
      JSON.stringify(payload),
      initialError,
    ]
  );

  if (inserted.rows[0]) {
    return { task: inserted.rows[0], created: true };
  }

  // A repeated webhook must not create a duplicate, but a later content fetch
  // may have better extracted fields. Never alter a completed task.
  await pool.query(
    `UPDATE seda_tasks
     SET source_received_email_id = COALESCE(source_received_email_id, $1),
         customer_name = COALESCE($2, customer_name),
         installation_address = COALESCE($3, installation_address),
         application_number = COALESCE($4, application_number),
         payload = CASE WHEN status = 'COMPLETED' THEN payload ELSE $5::jsonb END,
         requires_manual_review = CASE WHEN status = 'COMPLETED'
           THEN false ELSE $6 END,
         last_error = CASE WHEN status = 'COMPLETED'
           THEN last_error ELSE $7 END,
         updated_at = CURRENT_TIMESTAMP
     WHERE task_type = $8 AND source_email_id = $9`,
    [
      sourceReceivedEmailId || null,
      customerName || null,
      installationAddress || null,
      applicationNumber || null,
      JSON.stringify(payload),
      requiresManualReview,
      initialError,
      taskType,
      sourceEmailId,
    ]
  );

  const existing = await pool.query(
    `SELECT * FROM seda_tasks
     WHERE task_type = $1 AND source_email_id = $2`,
    [taskType, sourceEmailId]
  );

  return { task: existing.rows[0] || null, created: false };
}

/**
 * Get a single SEDA task.
 */
export async function getSedaTaskById(id) {
  if (!pool) return null;

  const result = await pool.query(
    `SELECT * FROM seda_tasks WHERE id = $1`,
    [id]
  );

  return result.rows[0] || null;
}

/**
 * List SEDA tasks with optional status/manual-review filters.
 */
export async function getSedaTasks({ limit = 50, status = null, requiresManualReview = null } = {}) {
  if (!pool) return [];

  const values = [];
  const conditions = [];

  if (status) {
    values.push(status);
    conditions.push(`status = $${values.length}`);
  }

  if (requiresManualReview !== null && requiresManualReview !== undefined) {
    values.push(requiresManualReview);
    conditions.push(`requires_manual_review = $${values.length}`);
  }

  values.push(Math.min(Math.max(Number(limit) || 50, 1), 100));
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await pool.query(
    `SELECT * FROM seda_tasks
     ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${values.length}`,
    values
  );

  return result.rows;
}

/**
 * Get SEDA task counts by state.
 */
export async function getSedaTaskStats() {
  if (!pool) {
    return { total: 0, pending: 0, processing: 0, completed: 0, manual_review: 0 };
  }

  const result = await pool.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending,
      COUNT(*) FILTER (WHERE status = 'PROCESSING')::int AS processing,
      COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
      COUNT(*) FILTER (WHERE requires_manual_review = true)::int AS manual_review
    FROM seda_tasks
  `);

  return result.rows[0];
}

/**
 * Atomically claim the next retryable PENDING task.
 */
export async function claimNextSedaTask({ staleAfterMs = 15 * 60 * 1000 } = {}) {
  if (!pool) return null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE seda_tasks
       SET status = 'PENDING',
           claimed_at = NULL,
           next_retry_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP,
           last_error = COALESCE(last_error, 'Recovered stale PROCESSING task')
       WHERE status = 'PROCESSING'
         AND claimed_at IS NOT NULL
         AND claimed_at < CURRENT_TIMESTAMP - ($1 * INTERVAL '1 millisecond')`,
      [staleAfterMs]
    );

    const next = await client.query(`
      SELECT *
      FROM seda_tasks
      WHERE status = 'PENDING'
        AND requires_manual_review = false
        AND (next_retry_at IS NULL OR next_retry_at <= CURRENT_TIMESTAMP)
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `);

    if (!next.rows[0]) {
      await client.query('COMMIT');
      return null;
    }

    const claimed = await client.query(
      `UPDATE seda_tasks
       SET status = 'PROCESSING',
           claimed_at = CURRENT_TIMESTAMP,
           attempt_count = attempt_count + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [next.rows[0].id]
    );

    await client.query('COMMIT');
    return claimed.rows[0] || null;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Mark a SEDA task complete only after the external API confirms updated:true.
 */
export async function completeSedaTask(id, data = {}) {
  if (!pool) return null;

  const result = await pool.query(
    `UPDATE seda_tasks
     SET status = 'COMPLETED',
         requires_manual_review = false,
         api_request = $1,
         api_response = $2,
         api_attempts = $3,
         last_error = NULL,
         next_retry_at = NULL,
         claimed_at = NULL,
         completed_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $4
     RETURNING *`,
    [
      data.apiRequest ? JSON.stringify(data.apiRequest) : null,
      data.apiResponse ? JSON.stringify(data.apiResponse) : null,
      JSON.stringify(data.apiAttempts || []),
      id,
    ]
  );

  return result.rows[0] || null;
}

/**
 * Return a task to PENDING for retry or manual review.
 */
export async function deferSedaTask(id, data = {}) {
  if (!pool) return null;

  const result = await pool.query(
    `UPDATE seda_tasks
     SET status = 'PENDING',
         requires_manual_review = $1,
         api_request = $2,
         api_response = $3,
         api_attempts = $4,
         last_error = $5,
         next_retry_at = $6,
         claimed_at = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $7
     RETURNING *`,
    [
      Boolean(data.requiresManualReview),
      data.apiRequest ? JSON.stringify(data.apiRequest) : null,
      data.apiResponse ? JSON.stringify(data.apiResponse) : null,
      JSON.stringify(data.apiAttempts || []),
      data.lastError || null,
      data.nextRetryAt || null,
      id,
    ]
  );

  return result.rows[0] || null;
}

/**
 * Make a task retryable again after manual review or an operator action.
 */
export async function retrySedaTask(id) {
  if (!pool) return null;

  const result = await pool.query(
    `UPDATE seda_tasks
     SET status = 'PENDING',
         requires_manual_review = false,
         next_retry_at = NULL,
         claimed_at = NULL,
         last_error = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND status <> 'COMPLETED'
     RETURNING *`,
    [id]
  );

  return result.rows[0] || null;
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

/**
 * Get all agents
 */
export async function getAgents(limit = 1000) {
  if (!pool) return [];

  const result = await pool.query(`
    SELECT id, bubble_id, name, email, contact, agent_type, slug, created_at
    FROM agent
    ORDER BY name ASC
    LIMIT $1
  `, [limit]);

  return result.rows;
}

/**
 * Get agent by bubble_id
 */
export async function getAgentByBubbleId(bubbleId) {
  if (!pool) return null;

  const result = await pool.query(`
    SELECT id, bubble_id, name, email, contact, agent_type, slug, created_at
    FROM agent
    WHERE bubble_id = $1
  `, [bubbleId]);

  return result.rows[0] || null;
}

/**
 * Get all agent email accounts
 */
export async function getAgentEmailAccounts() {
  if (!pool) return [];

  const result = await pool.query(`
    SELECT 
      aea.id,
      aea.agent_bubble_id,
      aea.email_prefix,
      aea.full_email,
      aea.created_at,
      a.name as agent_name,
      a.contact as agent_contact
    FROM agent_email_accounts aea
    LEFT JOIN agent a ON a.bubble_id = aea.agent_bubble_id
    ORDER BY aea.created_at DESC
  `);

  return result.rows;
}

/**
 * Get email accounts for a specific agent
 */
export async function getAgentEmailAccountsByAgent(agentBubbleId) {
  if (!pool) return [];

  const result = await pool.query(`
    SELECT id, agent_bubble_id, email_prefix, full_email, created_at
    FROM agent_email_accounts
    WHERE agent_bubble_id = $1
    ORDER BY created_at DESC
  `, [agentBubbleId]);

  return result.rows;
}

/**
 * Check if an email is already assigned to an agent
 */
export async function agentEmailAssignmentExists(agentBubbleId, fullEmail) {
  if (!pool) return false;

  const result = await pool.query(`
    SELECT id
    FROM agent_email_accounts
    WHERE agent_bubble_id = $1
      AND LOWER(full_email) = LOWER($2)
  `, [agentBubbleId, fullEmail]);

  return result.rows.length > 0;
}

/**
 * Create agent email account
 */
export async function createAgentEmailAccount(agentBubbleId, emailPrefix, emailDomain = 'eternalgy.me') {
  if (!pool) return null;

  const fullEmail = `${emailPrefix}@${emailDomain}`.toLowerCase();

  const result = await pool.query(`
    INSERT INTO agent_email_accounts (agent_bubble_id, email_prefix, full_email)
    VALUES ($1, $2, $3)
    RETURNING id, agent_bubble_id, email_prefix, full_email, created_at
  `, [agentBubbleId, emailPrefix, fullEmail]);

  return result.rows[0] || null;
}

/**
 * Delete agent email account
 */
export async function deleteAgentEmailAccount(id) {
  if (!pool) return false;

  const result = await pool.query(`
    DELETE FROM agent_email_accounts WHERE id = $1
  `, [id]);

  return result.rowCount > 0;
}
