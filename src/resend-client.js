// Resend API Client for fetching email content

import config from './config.js';

const RESEND_API_BASE = 'https://api.resend.com';

/**
 * Fetch received email content from Resend API
 * @param {string} emailId - The email_id from webhook
 * @returns {Promise<Object>} - Email with html, text, headers
 */
export async function getReceivedEmail(emailId) {
  const response = await fetch(`${RESEND_API_BASE}/emails/receiving/${emailId}`, {
    headers: {
      'Authorization': `Bearer ${config.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to fetch email: ${error}`);
  }

  return response.json();
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
      console.log(`Retry ${i + 1}/${retries} failed for email ${emailId}`);
    }
  }
  
  throw lastError;
}
