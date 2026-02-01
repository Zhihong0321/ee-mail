// Resend API Client for fetching email content

import config from './config.js';

const RESEND_API_BASE = 'https://api.resend.com';

/**
 * Fetch received email content from Resend API
 * Endpoint: GET /emails/receiving/{email_id}
 * @param {string} emailId - The email_id from webhook (UUID format)
 * @returns {Promise<Object>} - Email with html, text, headers
 */
export async function getReceivedEmail(emailId) {
  if (!emailId) {
    throw new Error('Email ID is required');
  }

  const url = `${RESEND_API_BASE}/emails/receiving/${emailId}`;
  console.log(`🌐 Fetching from: ${url}`);

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${config.RESEND_API_KEY}`,
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
 */
export async function getReceivedEmailWithRetry(emailId, retries = 3) {
  let lastError;
  
  for (let i = 0; i < retries; i++) {
    try {
      // Wait a bit for Resend to process the email
      if (i > 0) {
        await new Promise(r => setTimeout(r, 1000 * i));
      }
      
      return await getReceivedEmail(emailId);
    } catch (err) {
      lastError = err;
      console.log(`Retry ${i + 1}/${retries} failed for email ${emailId}: ${err.message}`);
    }
  }
  
  throw lastError;
}
