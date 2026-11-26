import { loadConfig } from './config.js';
import { createLogger } from './log.js';
import { createGateway } from './server.js';
import { loadUi } from './static.js';

const bootLogger = createLogger('info');
let config;
try {
  config = loadConfig(process.env);
} catch (err) {
  bootLogger.error(err instanceof Error ? err.message : 'Ungültige Konfiguration');
  process.exit(1);
}

const logger = createLogger(config.logLevel);
logger.addSecret(config.gatewayToken);
const ui = loadUi(config.uiDir, (msg) => logger.warn(msg));
const server = createGateway({ config, logger, ui });

server.listen(config.port, config.host, () => {
  logger.info('share gateway listening', {
    host: config.host,
    port: config.port,
    assets: ui.assets.size,
  });
});

const shutdown = (): void => {
  logger.info('shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
