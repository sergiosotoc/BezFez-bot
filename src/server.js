/* src/server.js */

import http from 'http';
import { logger } from './config/logger.js';

const PORT = process.env.PORT || 3000;

export function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', ts: new Date().toISOString() }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.listen(PORT, () => {
    logger.info({ port: PORT }, 'Servidor HTTP activo');
  });

  return server;
}

export function startKeepAlive(publicUrl) {
  if (!publicUrl) {
    logger.warn('RENDER_EXTERNAL_URL no definida — keep-alive desactivado');
    return;
  }

  const url = `${publicUrl}/health`;
  const INTERVAL_MS = 13 * 60 * 1000; // 13 minutos

  setInterval(async () => {
    try {
      const res = await fetch(url);
      logger.info({ status: res.status }, 'Keep-alive ping OK');
    } catch (err) {
      logger.warn({ err: err.message }, 'Keep-alive ping falló');
    }
  }, INTERVAL_MS);

  logger.info({ url, intervalMin: 13 }, 'Keep-alive iniciado');
}