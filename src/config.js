// Configuration for Railway and local environments

const config = {
  // Server
  PORT: process.env.PORT || 3000,
  NODE_ENV: process.env.NODE_ENV || 'development',

  // Resend API
  RESEND_API_KEY: process.env.RESEND_API_KEY,

  // Email Domain
  EMAIL_DOMAIN: process.env.EMAIL_DOMAIN || 'eternalgy.me',
  DEFAULT_FROM: process.env.DEFAULT_FROM || 'noreply@eternalgy.me',

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
