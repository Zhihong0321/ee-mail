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

// Parse API keys for each domain
// Format: domain1: apikey1, domain2: apikey2
// Falls back to RESEND_API_KEY if no domain-specific key is found
function parseApiKeys(domains) {
  const apiKeysEnv = process.env.RESEND_API_KEYS;
  const apiKeys = {};
  const defaultApiKey = process.env.RESEND_API_KEY;
  
  if (apiKeysEnv) {
    // Parse domain:apikey pairs
    apiKeysEnv.split(',').forEach(pair => {
      const [domain, ...keyParts] = pair.split(':');
      const key = keyParts.join(':').trim(); // Handle keys that might contain ':'
      if (domain && key) {
        apiKeys[domain.trim().toLowerCase()] = key;
      }
    });
  }
  
  // Fill in missing domains with default key
  domains.forEach(domain => {
    if (!apiKeys[domain]) {
      apiKeys[domain] = defaultApiKey;
    }
  });
  
  return apiKeys;
}

const EMAIL_DOMAINS = parseDomains();
const DEFAULT_SENDERS = parseDefaultSenders(EMAIL_DOMAINS);
const RESEND_API_KEYS = parseApiKeys(EMAIL_DOMAINS);

const config = {
  // Server
  PORT: process.env.PORT || 3000,
  NODE_ENV: process.env.NODE_ENV || 'development',

  // Resend API
  RESEND_API_KEY: process.env.RESEND_API_KEY,  // Default/fallback API key
  RESEND_API_KEYS,  // Map of domain -> API key: { 'domain1.com': 'key1', ... }

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
  // Check that we have at least one API key configured
  const hasDefaultKey = !!config.RESEND_API_KEY;
  const hasDomainKeys = Object.values(config.RESEND_API_KEYS).some(k => !!k);
  
  if (!hasDefaultKey && !hasDomainKeys) {
    throw new Error('Missing required environment variable: RESEND_API_KEY or RESEND_API_KEYS');
  }
}

// Get API key for a specific domain
export function getApiKeyForDomain(domain) {
  if (!domain) return config.RESEND_API_KEY;
  return config.RESEND_API_KEYS[domain.toLowerCase()] || config.RESEND_API_KEY;
}

export default config;
