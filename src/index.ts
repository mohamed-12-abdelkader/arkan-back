import tls from 'node:tls';
import { applyMigrations } from './db/migrate';

if (
  typeof tls.getCACertificates === 'function' &&
  typeof tls.setDefaultCACertificates === 'function'
) {
  tls.setDefaultCACertificates([
    ...new Set([...tls.getCACertificates('default'), ...tls.getCACertificates('system')]),
  ]);
}
import { config, logger } from './utils';
import { app } from './app';

const startServer = async () => {
  try {
    logger.info('Applying database migrations...');
    try {
      await applyMigrations(config.DATABASE_URL, 'up');
    } catch (migrationError) {
      // Concurrent restarts can leave an advisory lock; don't block boot in that case.
      logger.warn(
        { err: migrationError },
        'Migration step failed — continuing server start (check DB if schema is outdated)',
      );
    }

    const PORT = config.PORT;

    const server = app.listen(PORT, () => {
      logger.info(`🚀 Server is running on port ${PORT}`);
    });

    // Graceful shutdown
    const shutdown = () => {
      logger.info('Received shutdown signal. Closing server...');
      server.close(() => {
        logger.info('HTTP server closed.');
        process.exit(0);
      });
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (error) {
    logger.error({ err: error }, '❌ Failed to start server');
    process.exit(1);
  }
};

startServer();
