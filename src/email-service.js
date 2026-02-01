// Resend Email Service

import config from './config.js';

const RESEND_API_URL = 'https://api.resend.com/emails';

/**
 * Send a single email
 * @param {Object} options - Email options
 * @param {string} options.to - Recipient email
 * @param {string} options.subject - Email subject
 * @param {string} options.html - HTML content
 * @param {string} [options.text] - Plain text content
 * @param {string} [options.from] - Sender email (defaults to config.DEFAULT_FROM)
 * @param {Array} [options.cc] - CC recipients
 * @param {Array} [options.bcc] - BCC recipients
 * @param {Array} [options.attachments] - Attachments
 * @returns {Promise<Object>} - Resend API response
 */
export async function sendEmail(options) {
  const { to, subject, html, text, from, cc, bcc, attachments } = options;

  const payload = {
    from: from || config.DEFAULT_FROM,
    to,
    subject,
    html,
    ...(text && { text }),
    ...(cc && { cc }),
    ...(bcc && { bcc }),
    ...(attachments && { attachments }),
  };

  const response = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();

  if (!response.ok) {
    const error = new Error(data.message || 'Failed to send email');
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

/**
 * Send a batch of emails
 * @param {Array<Object>} emails - Array of email options
 * @returns {Promise<Array>} - Array of results
 */
export async function sendBatch(emails) {
  const results = await Promise.allSettled(
    emails.map(email => sendEmail(email))
  );

  return results.map((result, index) => ({
    index,
    success: result.status === 'fulfilled',
    data: result.status === 'fulfilled' ? result.value : null,
    error: result.status === 'rejected' ? result.reason : null,
  }));
}

/**
 * Send a simple text email
 * @param {string} to - Recipient email
 * @param {string} subject - Email subject
 * @param {string} text - Plain text content
 * @returns {Promise<Object>} - Resend API response
 */
export async function sendTextEmail(to, subject, text) {
  return sendEmail({ to, subject, text, html: `<pre>${text}</pre>` });
}

/**
 * Get email status from Resend
 * @param {string} emailId - Resend email ID
 * @returns {Promise<Object>} - Email status
 */
export async function getEmailStatus(emailId) {
  const response = await fetch(`${RESEND_API_URL}/${emailId}`, {
    headers: {
      'Authorization': `Bearer ${config.RESEND_API_KEY}`,
    },
  });

  if (!response.ok) {
    const error = new Error('Failed to get email status');
    error.status = response.status;
    throw error;
  }

  return response.json();
}
