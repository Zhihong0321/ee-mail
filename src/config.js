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

// Parse API keys for each domain from env (fallback only)
// Format: domain1: apikey1, domain2: apikey2
function parseApiKeysFromEnv(domains) {
  const apiKeysEnv = process.env.RESEND_API_KEYS;
  const apiKeys = {};
  const defaultApiKey = process.env.RESEND_API_KEY;
  
  if (apiKeysEnv) {
    // Parse domain:apikey pairs
    apiKeysEnv.split(',').forEach(pair => {
      const [domain, ...keyParts] = pair.split(':');
      const key = keyParts.join(':').trim();
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

// API keys from env (will be overridden by database keys)
const ENV_API_KEYS = parseApiKeysFromEnv(EMAIL_DOMAINS);

const config = {
  // Server
  PORT: process.env.PORT || 3000,
  NODE_ENV: process.env.NODE_ENV || 'development',

  // Resend API - fallback keys from env
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  ENV_API_KEYS,  // Map of domain -> API key from env: { 'domain1.com': 'key1', ... }

  // Email Domains (multiple supported)
  EMAIL_DOMAINS,  // Array of domains: ['domain1.com', 'domain2.com']
  EMAIL_DOMAIN: EMAIL_DOMAINS[0],  // Primary domain (backward compatibility)
  DEFAULT_SENDERS,  // Map of domain -> default sender: { 'domain1.com': 'noreply@domain1.com', ... }
  DEFAULT_FROM: DEFAULT_SENDERS[EMAIL_DOMAINS[0]],  // Primary default sender (backward compatibility)

  // PostgreSQL Database
  DATABASE_URL: process.env.DATABASE_URL,


  // SEDA ATAP approval task worker
  SEDA_API_KEY: process.env.SEDA_API_KEY,
  SEDA_STATUS_API_URL: process.env.SEDA_STATUS_API_URL || 'https://admin.atap.solar/api/v1/seda/status',
  SEDA_STATUS_DRY_RUN: String(process.env.SEDA_STATUS_DRY_RUN || 'false').toLowerCase() === 'true',
  SEDA_TASK_WORKER_INTERVAL_MS: Number(process.env.SEDA_TASK_WORKER_INTERVAL_MS || 5000),

  // Railway specific
  RAILWAY_STATIC_URL: process.env.RAILWAY_STATIC_URL,
  RAILWAY_PROJECT_NAME: process.env.RAILWAY_PROJECT_NAME,
  RAILWAY_SERVICE_NAME: process.env.RAILWAY_SERVICE_NAME,

  // Webhook (for receiving emails)
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET,

  // Recruitment automation
  JOB_APPLICATION_FROM: process.env.JOB_APPLICATION_FROM || 'vacancy@eternalgy.me',
  MIMO_API_KEY: process.env.MIMO_API_KEY,
  MIMO_API_BASE_URL: process.env.MIMO_API_BASE_URL || 'https://token-plan-sgp.xiaomimimo.com/v1',
  MIMO_MODEL: process.env.MIMO_MODEL || 'mimo-v2.5-pro',
  WHATSAPP_API_URL: process.env.WHATSAPP_API_URL || 'https://ee-baileys-production.up.railway.app',
  WHATSAPP_SESSION_ID: process.env.WHATSAPP_SESSION_ID || 'eternalgy-auth',
  WHATSAPP_API_KEY: process.env.WHATSAPP_API_KEY,
};

// Validate required config
export function validateConfig() {
  // At least one key should be configured (can be added via admin UI later)
  const hasDefaultKey = !!config.RESEND_API_KEY;
  const hasDomainKeys = Object.values(config.ENV_API_KEYS).some(k => !!k);
  
  if (!hasDefaultKey && !hasDomainKeys) {
    console.warn('⚠️ No RESEND_API_KEY configured. Add API keys via admin UI or set RESEND_API_KEY env var.');
  }

  if (!config.SEDA_API_KEY) {
    console.warn('⚠️ No SEDA_API_KEY configured. Matching SEDA tasks will remain PENDING for manual review.');
  }

  if (!config.MIMO_API_KEY) {
    console.warn('⚠️ No MIMO_API_KEY configured. Recruitment emails cannot be classified until it is set.');
  }
}

// In-memory cache for database API keys (refreshed on each use)
let dbApiKeysCache = null;
let dbApiKeysCacheTime = 0;
const API_KEYS_CACHE_TTL = 60000; // 1 minute

// Load API keys from database
async function loadApiKeysFromDb() {
  // Dynamic import to avoid circular dependency
  const { getApiKeysMap } = await import('./database.js');
  return await getApiKeysMap();
}

// Get API key for a specific domain (checks DB first, then env)
export async function getApiKeyForDomain(domain) {
  if (!domain) return config.RESEND_API_KEY;
  
  const domainLower = domain.toLowerCase();
  
  // Try to get from database (with simple caching)
  try {
    const now = Date.now();
    if (!dbApiKeysCache || (now - dbApiKeysCacheTime) > API_KEYS_CACHE_TTL) {
      dbApiKeysCache = await loadApiKeysFromDb();
      dbApiKeysCacheTime = now;
    }
    
    if (dbApiKeysCache[domainLower]) {
      return dbApiKeysCache[domainLower];
    }
  } catch (err) {
    // Database not available, fall through to env
  }
  
  // Fallback to environment variables
  return config.ENV_API_KEYS[domainLower] || config.RESEND_API_KEY;
}

// Clear API keys cache (call after updating keys in admin)
export function clearApiKeysCache() {
  dbApiKeysCache = null;
  dbApiKeysCacheTime = 0;
}

export default config;
