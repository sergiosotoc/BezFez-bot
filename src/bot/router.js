/* src/bot/router.js */
import { markMessageProcessed, resetSession } from '../services/supabase.js';
import { dispatch } from '../fsm/machine.js';
import { config } from '../config/index.js';
import { logger } from '../config/logger.js';
import { extendPause, endPause } from '../services/deadman.js';
import { processRatesExcel } from '../services/ratesUploader.js';
import { downloadMediaMessage } from '@whiskeysockets/baileys';

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
  const isNew = await markMessageProcessed(messageId, chatId);
  if (!isNew) {
    logger.debug({ messageId, chatId }, 'Mensaje duplicado ignorado');
    return;
  }

  const messageType = resolveMessageType(msg);
  const text = extractText(msg, messageType);

  logger.info({ chatId, clientPhone, pushName, messageType, textPreview: text?.slice(0, 60) }, 'Mensaje recibido');

  const normalizedText = text?.trim().toLowerCase();
  if (normalizedText === 'hola') {
    await resetSession(chatId);
    const ctx = { chatId, clientPhone, pushName, messageType, text, message: msg, rawMessage, sender };
    await dispatch(ctx);
    return;
  }

  const cleanAdminPhone = config.admin.phone.replace(/\D/g, '');
  const isAdmin = (chatId === config.admin.jid) || (clientPhone && clientPhone.includes(cleanAdminPhone));

  if (isAdmin && messageType === 'documentMessage') {
    const doc = rawMessage.message.documentMessage;

    logger.info({ fileName: doc.fileName }, 'Excel recibido');

    if (!doc.fileName?.endsWith('.xlsx')) {
      await sender.sendText(chatId, '⚠️ Envía un archivo Excel válido (.xlsx)');
      return;
    }

    try {
      const buffer = await downloadMediaMessage(
        rawMessage,
        'buffer',
        {},
        {
          logger,
          reuploadRequest: sock.updateMediaMessage
        }
      );

      const count = await processRatesExcel(buffer);

      await sender.sendText(chatId, `✅ Tarifas actualizadas (${count} filas)`);

    } catch (err) {
      logger.error({ err: err.message }, 'Error procesando Excel');
      await sender.sendText(chatId, `❌ Error: ${err.message}`);
    }

    return;
  }

  if (isAdmin) {
    const wasCommand = await handleAdminMessage({ chatId, text, sender, rawMessage });
    if (wasCommand) return;
  }

  const ctx = { chatId, clientPhone, pushName, messageType, text, message: msg, rawMessage, sender };
  try {
    await dispatch(ctx);
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

async function handleAdminMessage({ chatId, text, sender, rawMessage }) {
  const msg = text?.trim().toUpperCase() || '';

  const isExtender = ADMIN_COMMANDS.EXTENDER.test(msg);
  const isFinalizado = ADMIN_COMMANDS.FINALIZADO.test(msg);

  if (!isExtender && !isFinalizado) return false;

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
    await endPause(targetJid);
    await sender.sendText(chatId, '✅ Sesión del cliente liberada exitosamente. El bot lo volverá a atender.');
  } else if (isExtender) {
    await extendPause(targetJid);
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
