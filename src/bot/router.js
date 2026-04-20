/* src/bot/router.js */
import { markMessageProcessed, resetSession } from '../services/supabase.js';
import { dispatch } from '../fsm/machine.js';
import { config } from '../config/index.js';
import { logger } from '../config/logger.js';
import { extendPause, endPause } from '../services/deadman.js';
import { processRatesExcel } from '../services/ratesUploader.js';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { resetAuthStorage } from './auth.js';

const rateLimitMap = new Map();
const chatLocks = new Map();
export const lidToPhoneMap = new Map();

const ADMIN_COMMANDS = {
  EXTENDER: /^EXTENDER$/i,
  FINALIZADO: /^FINALIZADO$/i,
  RESET_AUTH: /^RESET_AUTH$/i,
};

const defaultDeps = {
  markMessageProcessed,
  resetSession,
  dispatch,
  extendPause,
  endPause,
  processRatesExcel,
  downloadMediaMessage,
  resetAuthStorage,
  adminPhone: config.admin.phone,
  adminJid: config.admin.jid,
};

const userMessages = new Map();

function isRateLimited(chatId) {
  const now = Date.now();
  const windowMs = 3000;

  if (!userMessages.has(chatId)) {
    userMessages.set(chatId, []);
  }

  const timestamps = userMessages.get(chatId)
    .filter(t => now - t < windowMs);

  timestamps.push(now);
  userMessages.set(chatId, timestamps);

  return timestamps.length > 5;
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

export async function route(rawMessage, sender, sock, deps = defaultDeps) {
  const chatId = rawMessage?.key?.remoteJid;
  if (!chatId) return;

  const previous = chatLocks.get(chatId) || Promise.resolve();
  const current = previous
    .catch(() => { })
    .then(() => processRoute(rawMessage, sender, sock, deps))
    .finally(() => {
      if (chatLocks.get(chatId) === current) {
        chatLocks.delete(chatId);
      }
    });

  chatLocks.set(chatId, current);
  return current;
}

async function processRoute(rawMessage, sender, sock, deps = defaultDeps) {
  const {
    markMessageProcessed: markMessageProcessedFn,
    resetSession: resetSessionFn,
    dispatch: dispatchFn,
    processRatesExcel: processRatesExcelFn,
    downloadMediaMessage: downloadMediaMessageFn,
    adminPhone,
    adminJid,
  } = deps;
  const chatId = rawMessage.key.remoteJid;
  if (chatId === 'status@broadcast') return;
  const msg = rawMessage.message;
  const key = rawMessage.key;
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
  const isNew = await markMessageProcessedFn(messageId, chatId);
  if (!isNew) {
    logger.debug({ messageId, chatId }, 'Mensaje duplicado ignorado');
    return;
  }

  const messageType = resolveMessageType(msg);
  const text = extractText(msg, messageType);

  logger.info({ chatId, clientPhone, pushName, messageType, textPreview: text?.slice(0, 60) }, 'Mensaje recibido');

  const normalizedText = text?.trim().toLowerCase();
  if (normalizedText === 'hola') {
    logger.info({ chatId, clientPhone, previousStateHint: 'reset-by-hola' }, 'Reiniciando sesión por saludo del cliente');
    try {
      await resetSessionFn(chatId);
      const ctx = { chatId, clientPhone, pushName, messageType, text, message: msg, rawMessage, sender };
      await dispatchFn(ctx);
    } catch (err) {
      logger.error({ chatId, err: err.message, stack: err.stack }, 'Error al reiniciar flujo con "hola"');
      await sender.sendText(chatId, 'Ocurrió un error inesperado. Escribe "hola" para reiniciar.').catch(() => { });
    }
    return;
  }

  const cleanAdminPhone = adminPhone.replace(/\D/g, '');
  const isAdmin = (chatId === adminJid) || (clientPhone && clientPhone.includes(cleanAdminPhone));

  if (isAdmin && messageType === 'documentMessage') {
    const doc = rawMessage.message.documentMessage;

    logger.info({ fileName: doc.fileName }, 'Excel recibido');

    if (!doc.fileName?.endsWith('.xlsx')) {
      await sender.sendText(chatId, '⚠️ Envía un archivo Excel válido (.xlsx)');
      return;
    }

    try {
      const buffer = await downloadMediaMessageFn(
        rawMessage,
        'buffer',
        {},
        {
          logger,
          reuploadRequest: sock.updateMediaMessage
        }
      );

      const count = await processRatesExcelFn(buffer);

      await sender.sendText(chatId, `✅ Tarifas actualizadas (${count} filas)`);

    } catch (err) {
      logger.error({ err: err.message }, 'Error procesando Excel');
      await sender.sendText(chatId, `❌ Error: ${err.message}`);
    }

    return;
  }

  if (isAdmin) {
    const wasCommand = await handleAdminMessage({ chatId, text, sender, rawMessage }, deps);
    if (wasCommand) return;
  }

  const ctx = { chatId, clientPhone, pushName, messageType, text, message: msg, rawMessage, sender };
  try {
    await dispatchFn(ctx);
  } catch (err) {
    logger.error({ chatId, err: err.message, stack: err.stack }, 'Error no manejado en FSM');
    await sender.sendText(chatId, 'Ocurrió un error inesperado. Escribe "hola" para reiniciar.').catch(() => { });
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

async function handleAdminMessage({ chatId, text, sender, rawMessage }, deps = defaultDeps) {
  const {
    extendPause: extendPauseFn,
    endPause: endPauseFn,
    resetAuthStorage: resetAuthStorageFn,
  } = deps;
  const msg = text?.trim().toUpperCase() || '';

  const isExtender = ADMIN_COMMANDS.EXTENDER.test(msg);
  const isFinalizado = ADMIN_COMMANDS.FINALIZADO.test(msg);
  const isResetAuth = ADMIN_COMMANDS.RESET_AUTH.test(msg);

  if (!isExtender && !isFinalizado && !isResetAuth) return false;

  if (isResetAuth) {
    const ok = await resetAuthStorageFn();
    await sender.sendText(
      chatId,
      ok
        ? '✅ Sesión de WhatsApp eliminada. Reinicia el servicio para escanear un QR nuevo.'
        : '❌ No pude eliminar la sesión de WhatsApp. Revisa logs.'
    );
    return true;
  }

  const contextInfo = rawMessage.message?.extendedTextMessage?.contextInfo;
  const quotedMessage = contextInfo?.quotedMessage;
  const quotedText = quotedMessage?.conversation || quotedMessage?.extendedTextMessage?.text;

  if (!quotedText) {
    await sender.sendText(chatId, '⚠️ Para usar este comando, debes *responder* al ticket del cliente.');
    return true;
  }

  const idMatch = quotedText.match(/ID:\s*([^\s]+)/);
  if (!idMatch) {
    await sender.sendText(chatId, '⚠️ No pude encontrar el ID del cliente en el ticket citado.');
    return true;
  }

  const targetJid = idMatch[1];

  // 3. Ejecutar la acción
  if (isFinalizado) {
    await endPauseFn(targetJid);
    await sender.sendText(chatId, '✅ Sesión del cliente liberada exitosamente. El bot lo volverá a atender.');
  } else if (isExtender) {
    await extendPauseFn(targetJid);
  }

  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [chatId, data] of rateLimitMap.entries()) {
    if (now - data.lastMessage > 60000) {
      rateLimitMap.delete(chatId);
    }
  }
}, 10 * 60 * 1000);

export const __private__ = {
  isRateLimited,
  cleanNumber,
  resolveClientPhone,
  resolveMessageType,
  extractText,
  handleAdminMessage,
  processRoute,
  resetTestState() {
    userMessages.clear();
    rateLimitMap.clear();
    chatLocks.clear();
    lidToPhoneMap.clear();
  },
};
