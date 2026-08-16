import { buildApp } from './app.js';
import { bootstrap, startSchedules } from './bootstrap.js';
import { loadConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp(config);

  await bootstrap(app);
  const stopSchedules = startSchedules(app);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    stopSchedules();
    try {
      // In-flight downloads are allowed to finish rather than being cut off.
      await app.close();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    app.log.error({ err: reason }, 'unhandled promise rejection');
  });

  await app.listen({ host: config.host, port: config.port });

  app.log.info(
    {
      basePath: config.basePath || '/',
      libraries: config.libraryPaths.length,
      dataDir: config.dataDir,
      webClient: config.webRoot ? 'bundled' : 'not built',
    },
    'GameBlade is ready',
  );
}

main().catch((error: unknown) => {
  console.error('Failed to start GameBlade:', error);
  process.exit(1);
});
