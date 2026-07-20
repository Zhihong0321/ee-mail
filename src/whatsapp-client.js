import config from './config.js';

const DEFAULT_BASE_URL = 'https://ee-baileys-production.up.railway.app';

function normalizePhone(phone) {
  return String(phone || '').replace(/[^\d]/g, '');
}

export async function sendWhatsAppMessage({ to, text }) {
  const recipient = normalizePhone(to);
  if (!recipient) {
    throw new Error('WhatsApp recipient is required');
  }
  if (!text || !String(text).trim()) {
    throw new Error('WhatsApp message text is required');
  }

  const response = await fetch(`${config.WHATSAPP_API_URL}/messages/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.WHATSAPP_API_KEY
        ? { 'x-api-key': config.WHATSAPP_API_KEY }
        : {}),
    },
    body: JSON.stringify({
      sessionId: config.WHATSAPP_SESSION_ID,
      to: recipient,
      text: String(text).trim(),
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `WhatsApp API error: ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

export function getWhatsAppConfig() {
  return {
    baseUrl: config.WHATSAPP_API_URL,
    sessionId: config.WHATSAPP_SESSION_ID,
  };
}
