import { mkdirSync } from 'node:fs';
import { buildApp } from './app.js';
import { ConfigError, isLoopback, loadConfig } from './config.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  mkdirSync(config.dataDir, { recursive: true });
  const app = await buildApp(config);

  const shutdown = (signal: string): void => {
    app.log.info({ signal }, 'shutting down');
    app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (!isLoopback(config.host)) {
    app.log.warn(
      { host: config.host },
      'HZ_HOST is not a loopback address. Only allowed inside the core container with the port published on 127.0.0.1.',
    );
  }
  await app.listen({ host: config.host, port: config.port });
}

void main();
