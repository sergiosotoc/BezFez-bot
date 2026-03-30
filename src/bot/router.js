/* src/bot/router.js */
import { markMessageProcessed } from '../services/supabase.js';
import { extendPause } from '../services/deadman.js';
import { dispatch } from '../fsm/machine.js';
import { config } from '../config/index.js';
import { logger } from '../config/logger.js';

const rateLimitMap = new Map();

function isRateLimited(chatId) {
  const now =Date.now();

  const data = rateLimitMap.get(chatId) || {
    lastMessage: 0,
    count: 0,
  };

  const diff = now -data.lastMessage;

  if (diff > 3000) {
    data.count = 0;
  }

  data.count++;
  data.lastMessage = now;

  rateLimitMap.set(chatId, data);

  if (data.count > 5) {
    return true;
  }

  return false;
}

export const lidToPhoneMap = new Map();

const ADMIN_COMMANDS = {
  EXTENDER:   /^EXTENDER$/i,
  FINALIZADO: /^FINALIZADO$/i,
};

export async function route(rawMessage, sender) {
  const msg      = rawMessage.message;
  const key      = rawMessage.key;
  const chatId   = key.remoteJid;
  const isFromMe = key.fromMe;

  if (isFromMe) return;
  if (chatId.endsWith('@g.us')) return;

  if (isRateLimited(chatId)) {
    await sender.sendText(
      chatId,
      '⚠️ Estás enviando mensajes muy rápido. Por favor, espera un momento antes de enviar más.'
    )
    logger.warn({ chatId }, 'Usuario rate limited por spam');
    return;
  }

  // ── Deduplicación ─────────────────────────────────────
  const messageId = key.id;
  const isNew = await markMessageProcessed(messageId, chatId);
  if (!isNew) {
    logger.debug({ messageId, chatId }, 'Mensaje duplicado ignorado');
    return;
  }

  const clientPhone = resolveClientPhone(rawMessage);

  const messageType = resolveMessageType(msg);
  const text = extractText(msg, messageType);

  logger.info({
    chatId,
    clientPhone,
    messageType,
    textPreview: text?.slice(0, 60),
  }, 'Mensaje recibido');

  // ── Admin ─────────────────────────────────────────────
  if (chatId === config.admin.jid) {
    return handleAdminMessage({ chatId, text, sender });
  }

  const ctx = {
    chatId,
    clientPhone,
    messageType,
    text,
    message: msg,
    rawMessage,
    sender,
  };

  try {
    await dispatch(ctx);
  } catch (err) {
    logger.error({ chatId, err: err.message, stack: err.stack }, 'Error no manejado en FSM');
    await sender.sendText(chatId,
      'Ocurrió un error inesperado. Escribe "hola" para reiniciar.'
    ).catch(() => {});
  }
}



function resolveClientPhone(rawMessage) {
  const key = rawMessage.key;

  const candidates = [
    rawMessage?.senderPn,
    rawMessage?.participantPn,
    key?.participantPn,
    rawMessage?.message?.extendedTextMessage?.contextInfo?.participantPn,
    rawMessage?.message?.extendedTextMessage?.contextInfo?.remoteJid,
    rawMessage?.message?.imageMessage?.contextInfo?.participantPn,
    rawMessage?.message?.imageMessage?.contextInfo?.remoteJid,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;

    const num = String(candidate)
      .replace('@s.whatsapp.net', '')
      .replace('@lid', '')
      .replace(/\D/g, '');

    if (/^\d{10,15}$/.test(num)) {
      return num;
    }
  }

  const remoteJid = key.remoteJid || '';

  if (remoteJid.endsWith('@lid')) {
    const lidKey = remoteJid;
    const lidUser = remoteJid.replace('@lid', '');

    return (
      lidToPhoneMap.get(lidKey) ||
      lidToPhoneMap.get(lidUser) ||
      `lid:${lidUser}`
    );
  }

  if (remoteJid.endsWith('@s.whatsapp.net')) {
    return remoteJid.replace('@s.whatsapp.net', '');
  }

  return 'desconocido';
}

//
// ─────────────────────────────────────────────────────────
// ADMIN
// ─────────────────────────────────────────────────────────
//

async function handleAdminMessage({ chatId, text, sender }) {
  if (!text) return;

  const trimmed = text.trim();

  if (ADMIN_COMMANDS.EXTENDER.test(trimmed.split(' ')[0])) {
    const parts = trimmed.split(/\s+/);
    let targetChatId = null;

    if (parts.length > 1) {
      const phone = parts[1].replace(/[^0-9]/g, '');
      targetChatId = `${phone}@s.whatsapp.net`;
    } else {
      targetChatId = await getMostRecentPausedChat();
    }

    if (!targetChatId) {
      await sender.sendText(chatId, '⚠️ No hay chats pausados.');
      return;
    }

    await extendPause(targetChatId);
    logger.info({ admin: chatId, targetChatId }, 'Admin extendió pausa');
    return;
  }

  if (ADMIN_COMMANDS.FINALIZADO.test(trimmed.split(' ')[0])) {
    await sender.sendText(chatId, '✅ Marcado como finalizado.');
    return;
  }
}

async function getMostRecentPausedChat() {
  const { supabase } = await import('../services/supabase.js');
  const { data } = await supabase
    .from('sessions')
    .select('chat_id')
    .eq('state', 'PAUSED')
    .order('paused_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return data?.chat_id || null;
}

//
// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────
//

function resolveMessageType(msg) {
  if (!msg) return 'unknown';
  if (msg.conversation || msg.extendedTextMessage) return 'text';
  if (msg.imageMessage) return 'imageMessage';
  if (msg.documentMessage) return 'documentMessage';
  return 'unknown';
}

function extractText(msg, messageType) {
  if (!msg) return null;

  if (messageType === 'text') {
    return msg.conversation || msg.extendedTextMessage?.text || null;
  }

  if (messageType === 'imageMessage') {
    return msg.imageMessage?.caption || null;
  }

  if (messageType === 'documentMessage') {
    return msg.documentMessage?.caption || null;
  }

  return null;
}