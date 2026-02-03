// Resend API Client for fetching email content

import config, { getApiKeyForDomain } from './config.js';

const RESEND_API_BASE = 'https://api.resend.com';

/**
 * Fetch attachments list from Resend API
 * Endpoint: GET /emails/receiving/{email_id}/attachments
 * @param {string} emailId - The email_id from webhook (UUID format)
 * @param {string} [domain] - Domain to determine which API key to use
 * @returns {Promise<Array>} - Array of attachment metadata with download URLs
 */
export async function fetchAttachments(emailId, domain) {
  if (!emailId) {
    throw new Error('Email ID is required');
  }

  const apiKey = await getApiKeyForDomain(domain);
  if (!apiKey) {
    throw new Error(`No API key configured for domain: ${domain}`);
  }

  const url = `${RESEND_API_BASE}/emails/receiving/${emailId}/attachments`;
  console.log(`🌐 Fetching attachments from: ${url}`);

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const status = response.status;
    const errorText = await response.text();
    console.error(`❌ Resend API error ${status}:`, errorText);
    throw new Error(`Resend API error ${status}: ${errorText}`);
  }

  const data = await response.json();
  console.log(`✅ Fetched ${data.length} attachments`);
  return data;
}

/**
 * Download attachment content from download URL
 * @param {string} downloadUrl - The temporary download URL from Resend
 * @returns {Promise<Buffer>} - Attachment content as buffer
 */
export async function downloadAttachment(downloadUrl) {
  if (!downloadUrl) {
    throw new Error('Download URL is required');
  }

  console.log(`📥 Downloading attachment from: ${downloadUrl.substring(0, 50)}...`);

  const response = await fetch(downloadUrl);
  
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  console.log(`✅ Downloaded ${buffer.length} bytes`);
  return buffer;
}

/**
 * Fetch received email content from Resend API
 * Endpoint: GET /emails/receiving/{email_id}
 * @param {string} emailId - The email_id from webhook (UUID format)
 * @param {string} [domain] - Domain to determine which API key to use
 * @returns {Promise<Object>} - Email with html, text, headers
 */
export async function getReceivedEmail(emailId, domain) {
  if (!emailId) {
    throw new Error('Email ID is required');
  }

  const apiKey = await getApiKeyForDomain(domain);
  if (!apiKey) {
    throw new Error(`No API key configured for domain: ${domain}`);
  }

  const url = `${RESEND_API_BASE}/emails/receiving/${emailId}`;
  console.log(`🌐 Fetching from: ${url}`);

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const status = response.status;
    const errorText = await response.text();
    console.error(`❌ Resend API error ${status}:`, errorText);
    throw new Error(`Resend API error ${status}: ${errorText}`);
  }

  const data = await response.json();
  console.log('✅ Email content fetched successfully');
  return data;
}

/**
 * Get email content with retry
 * @param {string} emailId - The email_id from webhook (UUID format)
 * @param {string} [domain] - Domain to determine which API key to use
 * @param {number} [retries=3] - Number of retries
 * @returns {Promise<Object>} - Email with html, text, headers
 */
export async function getReceivedEmailWithRetry(emailId, domain, retries = 3) {
  let lastError;
  
  for (let i = 0; i < retries; i++) {
    try {
      // Wait a bit for Resend to process the email
      if (i > 0) {
        await new Promise(r => setTimeout(r, 1000 * i));
      }
      
      return await getReceivedEmail(emailId, domain);
    } catch (err) {
      lastError = err;
      console.log(`Retry ${i + 1}/${retries} failed for email ${emailId}: ${err.message}`);
    }
  }
  
  throw lastError;
}
