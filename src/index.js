// Entry point for Railway

import { createServer } from './server.js';
import config from './config.js';
import { initDatabase, initTables } from './database.js';

// Initialize database
const pool = initDatabase(config.DATABASE_URL);
if (pool) {
  await initTables();
}

const server = createServer();

server.listen(config.PORT, () => {
  console.log(`🚀 EE-Mail Service running on port ${config.PORT}`);
  console.log(`📧 Domain: ${config.EMAIL_DOMAIN}`);
  console.log(`🌍 Environment: ${config.NODE_ENV}`);
  console.log(`🗄️  Database: ${pool ? 'connected' : 'not configured'}`);
  console.log(`🔗 Health check: http://localhost:${config.PORT}/health`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
