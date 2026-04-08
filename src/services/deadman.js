/* src/services/deadman.js */
import {
  supabase,
  updateSession,
  resetSession,
  getActivePausedSessions,
  recordPauseExtension,
} from './supabase.js';
import { config } from '../config/index.js';
import { logger } from '../config/logger.js';

// ── Mapa de timers activos: chat_id → { remind, expire } ──
const timers = new Map();

// sender se inyecta después del boot para evitar dependencias circulares
let _sender = null;
export function initDeadman(sender) { _sender = sender; }

// ─────────────────────────────────────────────────────────
// INICIAR PAUSA
// ─────────────────────────────────────────────────────────

/**
 * Pone un chat en modo PAUSED y arranca el deadman switch.
 *
 * @param {string} chatId   - JID del cliente
 * @param {string} folio    - Para el mensaje del admin
 * @param {string} clientName
 */
export async function startPause(chatId, folio, clientName) {
  const now = Date.now();
  const expiresAt = new Date(now + config.pauseDurationMs);

  await updateSession(chatId, {
    state: 'PAUSED',
    paused_at: new Date(now).toISOString(),
    pause_expires_at: expiresAt.toISOString(),
  });

  scheduleTimers(chatId, folio, clientName, config.pauseDurationMs);
  logger.info({ chatId, folio, expiresAt }, 'Pausa iniciada');
}

// ─────────────────────────────────────────────────────────
// EXTENDER PAUSA (comando del admin)
// ─────────────────────────────────────────────────────────

/**
 * Reinicia los timers por 60 minutos adicionales.
 * Guarda la extensión en admin_pauses para auditoría.
 */
export async function extendPause(chatId) {
  clearTimers(chatId);

  const newExpiresAt = new Date(Date.now() + config.pauseDurationMs);

  await updateSession(chatId, { pause_expires_at: newExpiresAt.toISOString() });
  await recordPauseExtension(chatId, newExpiresAt);

  // Recuperar datos para el mensaje del admin
  const { data: session } = await supabase
    .from('sessions')
    .select('form_data')
    .eq('chat_id', chatId)
    .single();

  const clientName = session?.form_data?.nombre_origen || chatId;

  scheduleTimers(chatId, null, clientName, config.pauseDurationMs);
  logger.info({ chatId, newExpiresAt }, 'Pausa extendida');

  // Confirmar al admin
  if (_sender) {
    await _sender.sendText(
      config.admin.jid,
      `✅ Pausa extendida 1 hora más para el chat con *${clientName}*.`
    );
  }
}

// ─────────────────────────────────────────────────────────
// BOOT RECOVERY
// ─────────────────────────────────────────────────────────

/**
 * Al arrancar el proceso, recarga los timers de chats que estaban PAUSADOS
 * y aún no han expirado. Evita despertar y responder a clientes en atención manual.
 */
export async function restoreTimers() {
  const sessions = await getActivePausedSessions();

  if (sessions.length === 0) {
    logger.info('No hay sesiones pausadas activas al arrancar');
    return;
  }

  logger.info({ count: sessions.length }, 'Restaurando timers de sesiones pausadas');

  for (const row of sessions) {
    const remaining = new Date(row.pause_expires_at).getTime() - Date.now();
    if (remaining <= 0) {
      // Ya debería haber expirado — liberar inmediatamente
      await endPause(row.chat_id);
      continue;
    }

    const clientName = row.form_data?.nombre_origen || row.chat_id;
    scheduleTimers(row.chat_id, null, clientName, remaining);
    logger.info({ chatId: row.chat_id, remainingMs: remaining }, 'Timer restaurado');
  }
}

// ─────────────────────────────────────────────────────────
// INTERNOS
// ─────────────────────────────────────────────────────────

function scheduleTimers(chatId, folio, clientName, durationMs) {
  clearTimers(chatId);

  const remindDelay = Math.max(0, durationMs - (config.pauseDurationMs - config.reminderOffsetMs));
  const expireDelay = durationMs;

  const remind = setTimeout(() => sendReminder(chatId, clientName), remindDelay);
  const expire = setTimeout(() => endPause(chatId), expireDelay);

  timers.set(chatId, { remind, expire });
}

function clearTimers(chatId) {
  const t = timers.get(chatId);
  if (t) {
    clearTimeout(t.remind);
    clearTimeout(t.expire);
    timers.delete(chatId);
  }
}

async function sendReminder(chatId, clientName) {
  logger.info({ chatId }, 'Enviando recordatorio al admin');
  if (!_sender) return;

  const msg = [
    `⚠️ *RE RECORDATORIO:* El chat con *${clientName}* sigue pausado.`,
    'El bot se reactivará en 10 min.',
    '¿Deseas extender la pausa 1 hora más? (Responder: *EXTENDER*)',
  ].join('\n');

  await _sender.sendText(config.admin.jid, msg);
}

export async function endPause(chatId) {
  clearTimers(chatId);
  await resetSession(chatId);
  logger.info({ chatId }, 'Pausa finalizada en silencio — sesión reseteada');
}