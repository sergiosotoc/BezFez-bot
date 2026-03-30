/* src/index.js */
import { startBot } from './bot/index.js';
import { logger } from './config/logger.js';

// ── Validar config al arrancar (lanza si falta una variable) ──
import './config/index.js';

logger.info('Iniciando AHSE Bot...');

startBot().catch(err => {
  logger.fatal({ err: err.message, stack: err.stack }, 'Error fatal al iniciar el bot');
  process.exit(1);
});

// ── Manejo de señales del sistema ─────────────────────────
process.on('SIGINT', () => {
  logger.info('SIGINT recibido — cerrando bot...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM recibido — cerrando bot...');
  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Promesa rechazada no manejada');
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err: err.message, stack: err.stack }, 'Excepción no capturada');
  process.exit(1);
});
