// Configuration for Railway and local environments

// Parse multiple domains from comma-separated string
function parseDomains() {
  const domainsEnv = process.env.EMAIL_DOMAINS || process.env.EMAIL_DOMAIN;
  if (!domainsEnv) return ['eternalgy.me'];
  
  return domainsEnv.split(',')
    .map(d => d.trim().toLowerCase())
    .filter(d => d.length > 0);
}

// Parse default senders for each domain
// Format: domain1: sender1@domain1, domain2: sender2@domain2
function parseDefaultSenders(domains) {
  const sendersEnv = process.env.DEFAULT_SENDERS || process.env.DEFAULT_FROM;
  const senders = {};
  
  if (!sendersEnv) {
    // Default to noreply@domain for each domain
    domains.forEach(domain => {
      senders[domain] = `noreply@${domain}`;
    });
    return senders;
  }
  
  // Check if it's in the new format (comma-separated domain:sender pairs)
  if (sendersEnv.includes(':')) {
    sendersEnv.split(',').forEach(pair => {
      const [domain, sender] = pair.split(':').map(s => s.trim());
      if (domain && sender) {
        senders[domain.toLowerCase()] = sender;
      }
    });
  }
  
  // Fill in missing domains with defaults
  domains.forEach(domain => {
    if (!senders[domain]) {
      senders[domain] = `noreply@${domain}`;
    }
  });
  
  return senders;
}

const EMAIL_DOMAINS = parseDomains();
const DEFAULT_SENDERS = parseDefaultSenders(EMAIL_DOMAINS);

const config = {
  // Server
  PORT: process.env.PORT || 3000,
  NODE_ENV: process.env.NODE_ENV || 'development',

  // Resend API
  RESEND_API_KEY: process.env.RESEND_API_KEY,

  // Email Domains (multiple supported)
  EMAIL_DOMAINS,  // Array of domains: ['domain1.com', 'domain2.com']
  EMAIL_DOMAIN: EMAIL_DOMAINS[0],  // Primary domain (backward compatibility)
  DEFAULT_SENDERS,  // Map of domain -> default sender: { 'domain1.com': 'noreply@domain1.com', ... }
  DEFAULT_FROM: DEFAULT_SENDERS[EMAIL_DOMAINS[0]],  // Primary default sender (backward compatibility)

  // PostgreSQL Database
  DATABASE_URL: process.env.DATABASE_URL,

  // Railway specific
  RAILWAY_STATIC_URL: process.env.RAILWAY_STATIC_URL,
  RAILWAY_PROJECT_NAME: process.env.RAILWAY_PROJECT_NAME,
  RAILWAY_SERVICE_NAME: process.env.RAILWAY_SERVICE_NAME,

  // Webhook (for receiving emails)
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET,
};

// Validate required config
export function validateConfig() {
  const required = ['RESEND_API_KEY'];
  const missing = required.filter(key => !config[key]);
  
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

export default config;
