/* src/bot/router.js */
import { markMessageProcessed } from '../services/supabase.js';
import { extendPause } from '../services/deadman.js';
import { dispatch } from '../fsm/machine.js';
import { config } from '../config/index.js';
import { logger } from '../config/logger.js';

const rateLimitMap = new Map();
export const lidToPhoneMap = new Map();

const ADMIN_COMMANDS = {
  EXTENDER: /^EXTENDER$/i,
  FINALIZADO: /^FINALIZADO$/i,
};

function isRateLimited(chatId) {
  const now = Date.now();
  const data = rateLimitMap.get(chatId) || { lastMessage: 0, count: 0 };
  const diff = now - data.lastMessage;

  if (diff > 3000) data.count = 0;
  data.count++;
  data.lastMessage = now;
  rateLimitMap.set(chatId, data);

  return data.count > 5;
}

function cleanNumber(num) {
  if (!num) return null;
  const clean = String(num)
    .replace('@s.whatsapp.net', '')
    .replace('@lid', '')
    .replace(/\D/g, '');
  return /^\d{10,15}$/.test(clean) ? clean : null;
}

async function resolveClientPhone(rawMessage, sock) {
  const key = rawMessage.key;
  const remoteJid = key?.remoteJid || '';

  // 1. Caso ideal: JID real
  if (remoteJid.endsWith('@s.whatsapp.net')) {
    return cleanNumber(remoteJid);
  }

  // 2. Usar senderPn si viene en el mensaje (como en tu log)
  if (key?.senderPn) {
    const phone = cleanNumber(key.senderPn);
    if (phone) {
      lidToPhoneMap.set(remoteJid, phone);
      return phone;
    }
  }

  // 3. Intentar resolver con onWhatsApp si es LID
  if (remoteJid.endsWith('@lid')) {
    try {
      const result = await sock.onWhatsApp(remoteJid);
      if (result?.[0]?.jid) {
        const phone = cleanNumber(result[0].jid);
        if (phone) {
          lidToPhoneMap.set(remoteJid, phone);
          return phone;
        }
      }
    } catch (err) {
      logger.error({ remoteJid, err }, 'Error resolviendo LID');
    }
    return `lid:${remoteJid.replace('@lid', '')}`;
  }

  return 'desconocido';
}

export async function route(rawMessage, sender, sock) {
  const msg = rawMessage.message;
  const key = rawMessage.key;
  const chatId = key.remoteJid;
  const isFromMe = key.fromMe;

  if (isFromMe) return;
  if (chatId.endsWith('@g.us')) return;

  const clientPhone = await resolveClientPhone(rawMessage, sock);
  const pushName = rawMessage.pushName || null;

  logger.info({ chatId, clientPhone, pushName, rawMessageKey: key }, 'Número y nombre resueltos desde primer mensaje');

  if (isRateLimited(chatId)) {
    await sender.sendText(chatId, '⚠️ Estás enviando mensajes muy rápido. Por favor, espera un momento antes de enviar más.');
    logger.warn({ chatId }, 'Usuario rate limited por spam');
    return;
  }

  const messageId = key.id;
  const isNew = await markMessageProcessed(messageId, chatId);
  if (!isNew) {
    logger.debug({ messageId, chatId }, 'Mensaje duplicado ignorado');
    return;
  }

  const messageType = resolveMessageType(msg);
  const text = extractText(msg, messageType);

  logger.info({ chatId, clientPhone, pushName, messageType, textPreview: text?.slice(0, 60) }, 'Mensaje recibido');

  if (chatId === config.admin.jid) {
    return handleAdminMessage({ chatId, text, sender });
  }

  const ctx = { chatId, clientPhone, pushName, messageType, text, message: msg, rawMessage, sender };
  try {
    await dispatch(ctx);
  } catch (err) {
    logger.error({ chatId, err: err.message, stack: err.stack }, 'Error no manejado en FSM');
    await sender.sendText(chatId, 'Ocurrió un error inesperado. Escribe "hola" para reiniciar.').catch(() => {});
  }
}

// Helpers
function resolveMessageType(msg) {
  if (!msg) return 'unknown';
  if (msg.conversation || msg.extendedTextMessage) return 'text';
  if (msg.imageMessage) return 'imageMessage';
  if (msg.documentMessage) return 'documentMessage';
  return 'unknown';
}

function extractText(msg, messageType) {
  if (!msg) return null;
  if (messageType === 'text') return msg.conversation || msg.extendedTextMessage?.text || null;
  if (messageType === 'imageMessage') return msg.imageMessage?.caption || null;
  if (messageType === 'documentMessage') return msg.documentMessage?.caption || null;
  return null;
}