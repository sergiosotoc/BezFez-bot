/* src/bot/index.js */
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import pino from 'pino';

import { Sender } from './sender.js';
import { route, lidToPhoneMap } from './router.js';
import { injectSender, restoreTimers } from '../services/deadman.js';
import { cleanExpiredMessages } from '../services/supabase.js';
import { ensureBucketExists } from '../services/storage.js';
import { logger } from '../config/logger.js';
import { ensureAuthBucket, downloadAuthFromSupabase, uploadAuthToSupabase } from './auth.js';

const AUTH_DIR = './auth_info';

export async function startBot() {
  try {
    await ensureBucketExists();
    logger.info('Bucket de Supabase Storage verificado');
  } catch (err) {
    logger.error({ err: err.message }, 'Error verificando bucket (no crítico)');
  }
  logger.info('Bucket de Supabase Storage verificado');

  try {
    await ensureAuthBucket();
    await downloadAuthFromSupabase();
  } catch (err) {
    logger.error({ err: err.message }, 'Error descargando auth de Supabase, se continúa sin sync');
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  logger.info({ version }, 'Baileys version');

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['BazFez Bot', 'Chrome', '1.0.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  const sender = new Sender(sock);

  sock.ev.on('chats.phoneNumberShare', ({ lid, jid }) => {
    try {
      if (!lid || !jid) return;

      const lidKey = String(lid);
      const lidUser = lidKey.replace('@lid', '');

      const phone = jid.replace('@s.whatsapp.net', '');

      if (!/^\d{10,15}$/.test(phone)) return;

      lidToPhoneMap.set(lidKey, phone);
      lidToPhoneMap.set(lidUser, phone);
      lidToPhoneMap.set(`${lidUser}@lid`, phone);

      logger.info(
        { lid: lidKey, phone },
        '✅ LID → teléfono resuelto correctamente'
      );
    } catch (err) {
      logger.warn({ err: err.message }, 'Error en phoneNumberShare');
    }
  });

  sock.ev.on('chats.phoneNumberShare', (data) => {
    console.log('🔥 phoneNumberShare:', data);
  });

  injectSender(sender);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      logger.info('Escanea el QR para conectar WhatsApp:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode
        : null;

      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      logger.warn({ statusCode, shouldReconnect }, 'Conexión cerrada');

      if (shouldReconnect) {
        logger.info('Reconectando en 5 segundos...');
        setTimeout(startBot, 5000);
      } else {
        logger.error('Sesión cerrada. Elimina auth_info y reinicia.');
        process.exit(1);
      }
    }

    if (connection === 'open') {
      logger.info('✅ Bot conectado a WhatsApp');

      await restoreTimers();
      logger.info('Timers de pausa restaurados');
    }
  });

  sock.ev.on('creds.update', async () => {
    await saveCreds();

    try {
      await uploadAuthToSupabase();
    } catch (err) {
      logger.error({ err: err.message }, 'Error subiendo auth a Supabase (no crítico)');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const rawMessage of messages) {
      route(rawMessage, sender, sock).catch(err => {
        logger.error({ err: err.message }, 'Error no capturado en route()');
      });
    }
  });

  setInterval(() => {
    cleanExpiredMessages().catch(err => {
      logger.warn({ err: err.message }, 'Error en limpieza de processed_messages');
    });
  }, 5 * 60 * 1000);

  return sock;
}